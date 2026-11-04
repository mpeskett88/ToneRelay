#include "tonerelay.h"

#include "sdkconfig.h"

#if CONFIG_TONERELAY_BLE_MIDI

#include <string.h>

#include "blemidi.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "usb/usb_host.h"

/*
 * MIDI to the pedal over its USB MIDI interface (the HX Stomp has one next to the Helix interface that helix_usb uses). This is a
 * second USB client, so it works whether or not a Helrig session is open. It claims the MIDI streaming interface as soon as the pedal
 * enumerates, sends what tonerelay_usb_midi_send() is given, and reads what the pedal sends back (a device whose MIDI output nobody reads can
 * stall) and passes its channel messages on to the Bluetooth MIDI link.
 */

#define TAG "usb_midi"
#define VID 0x0E41
#define OUT_PACKETS 128 /* USB-MIDI packets of 4 bytes in one transfer */

static usb_host_client_handle_t s_client;
static usb_device_handle_t s_dev;
static uint8_t s_if;
static uint8_t s_ep_out;
static uint8_t s_ep_in;
static int s_in_mps;
static usb_transfer_t *s_xout;
static usb_transfer_t *s_xin;
static volatile bool s_ready;
static volatile bool s_gone;
static volatile bool s_scan;
static volatile uint8_t s_open_addr;
static volatile int s_in_flight; /* submitted IN transfers whose callback has not run yet */
static volatile int s_out_flight;
static bool s_close_pending; /* close_dev left the device, interface and transfers in place because some were still in flight */
static SemaphoreHandle_t s_out_done;
static SemaphoreHandle_t s_enc_mu;
static QueueHandle_t s_q; /* 4-byte USB-MIDI packets waiting to go out */
static usbmidi_enc_t s_enc;

static void out_cb(usb_transfer_t *x)
{
    (void)x;
    __atomic_fetch_sub(&s_out_flight, 1, __ATOMIC_SEQ_CST);
    xSemaphoreGive(s_out_done);
}

/* The pedal sends back what it is sent on its MIDI output (a MIDI Thru), so each packet that went to it is remembered for a moment and
 * the same packet coming back is not passed to the phone: it would only hear itself. */
#define ECHO_SLOTS 64
#define ECHO_MS 400
static struct {
    uint32_t pkt;
    uint32_t ms;
} s_echo[ECHO_SLOTS];
static int s_echo_next;
static portMUX_TYPE s_echo_mux = portMUX_INITIALIZER_UNLOCKED;

static uint32_t now_ms(void)
{
    return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
}

static void echo_remember(const uint8_t *p)
{
    uint32_t v;
    memcpy(&v, p, 4);
    portENTER_CRITICAL(&s_echo_mux);
    s_echo[s_echo_next].pkt = v;
    s_echo[s_echo_next].ms = now_ms();
    s_echo_next = (s_echo_next + 1) % ECHO_SLOTS;
    portEXIT_CRITICAL(&s_echo_mux);
}

/* True if `p` is the packet that was sent to the pedal a moment ago; the match is used up. */
static bool echo_take(const uint8_t *p)
{
    uint32_t v, now = now_ms();
    bool hit = false;
    memcpy(&v, p, 4);
    portENTER_CRITICAL(&s_echo_mux);
    for (int i = 0; i < ECHO_SLOTS; i++) {
        if (s_echo[i].pkt == v && s_echo[i].ms != 0 && now - s_echo[i].ms < ECHO_MS) {
            s_echo[i].ms = 0;
            hit = true;
            break;
        }
    }
    portEXIT_CRITICAL(&s_echo_mux);
    return hit;
}

static void in_cb(usb_transfer_t *x)
{
    if (x->status == USB_TRANSFER_STATUS_COMPLETED) {
        uint8_t fresh[128];
        size_t n = 0;
        for (int i = 0; i + 4 <= x->actual_num_bytes && n + 4 <= sizeof(fresh); i += 4) {
            if (!echo_take(x->data_buffer + i)) {
                memcpy(fresh + n, x->data_buffer + i, 4);
                n += 4;
            }
        }
        if (n > 0) {
            tonerelay_midi_ble_notify_usb(fresh, n); /* on to the tablet; only channel messages go */
        }
    }
    if (x->status == USB_TRANSFER_STATUS_COMPLETED && s_ready && usb_host_transfer_submit(x) == ESP_OK) {
        return; /* what the pedal sent is dropped, and the next read is posted (still in flight) */
    }
    __atomic_fetch_sub(&s_in_flight, 1, __ATOMIC_SEQ_CST);
}

static void client_event(const usb_host_client_event_msg_t *msg, void *arg)
{
    (void)arg;
    if (msg->event == USB_HOST_CLIENT_EVENT_NEW_DEV) {
        s_open_addr = msg->new_dev.address;
    } else if (msg->event == USB_HOST_CLIENT_EVENT_DEV_GONE && s_dev && msg->dev_gone.dev_hdl == s_dev) {
        s_ready = false;
        s_gone = true; /* the worker closes it: this callback must not wait for transfers that only this task can complete */
    }
}

static void client_task(void *arg)
{
    (void)arg;
    while (true) {
        usb_host_client_handle_events(s_client, portMAX_DELAY);
    }
}

/* Finds the MIDI streaming interface (class 1, subclass 3) and its bulk endpoints in the active configuration. */
static bool find_midi(const usb_config_desc_t *cfg)
{
    const uint8_t *p = (const uint8_t *)cfg;
    int total = cfg->wTotalLength;
    bool in_midi = false;
    bool found = false;
    s_ep_out = 0;
    s_ep_in = 0;
    for (int i = 0; i + 2 <= total;) {
        uint8_t len = p[i];
        uint8_t type = p[i + 1];
        if (len < 2 || i + len > total) {
            break;
        }
        if (type == USB_B_DESCRIPTOR_TYPE_INTERFACE && len >= 9) {
            in_midi = p[i + 3] == 0 && p[i + 5] == 0x01 && p[i + 6] == 0x03;
            if (in_midi) {
                s_if = p[i + 2];
                found = true;
            }
        } else if (type == USB_B_DESCRIPTOR_TYPE_ENDPOINT && in_midi && len >= 7 && (p[i + 3] & 0x03) == 0x02) {
            if (p[i + 2] & 0x80) {
                s_ep_in = p[i + 2];
                s_in_mps = p[i + 4] | (p[i + 5] << 8);
            } else {
                s_ep_out = p[i + 2];
            }
        }
        i += len;
    }
    return found && s_ep_out != 0;
}

/* Releases the interface, closes the device and frees the transfers, once none of them is in flight: freeing one the host stack still
 * owns asserts in hcd_urb_dequeue and resets the chip. Waits up to wait_ms for the callbacks. If some have not run, nothing is changed,
 * s_close_pending stays set and the worker calls this again. Same rule as finish_close in usb.c. */
static void close_dev(int wait_ms)
{
    s_ready = false;
    if (!s_dev) {
        return;
    }
    if (!s_close_pending) {
        if (s_ep_out) {
            usb_host_endpoint_halt(s_dev, s_ep_out);
            usb_host_endpoint_flush(s_dev, s_ep_out);
        }
        if (s_ep_in) {
            usb_host_endpoint_halt(s_dev, s_ep_in);
            usb_host_endpoint_flush(s_dev, s_ep_in);
        }
    }
    for (int waited = 0; (s_in_flight > 0 || s_out_flight > 0) && waited < wait_ms; waited += 10) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (s_in_flight > 0 || s_out_flight > 0) {
        if (!s_close_pending) {
            ESP_LOGW(TAG, "close: %d IN and %d OUT still in flight, finishing later", s_in_flight, s_out_flight);
        }
        s_close_pending = true;
        return;
    }
    s_close_pending = false;
    if (s_xout) {
        usb_host_transfer_free(s_xout);
        s_xout = NULL;
    }
    if (s_xin) {
        usb_host_transfer_free(s_xin);
        s_xin = NULL;
    }
    usb_host_interface_release(s_client, s_dev, s_if);
    usb_host_device_close(s_client, s_dev);
    s_dev = NULL;
    ESP_LOGI(TAG, "pedal MIDI closed");
}

static void try_open(uint8_t addr)
{
    if (s_dev) {
        return;
    }
    usb_device_handle_t dev = NULL;
    if (usb_host_device_open(s_client, addr, &dev) != ESP_OK) {
        return;
    }
    const usb_device_desc_t *desc = NULL;
    const usb_config_desc_t *cfg = NULL;
    if (usb_host_get_device_descriptor(dev, &desc) != ESP_OK || desc->idVendor != VID ||
        usb_host_get_active_config_descriptor(dev, &cfg) != ESP_OK || !cfg || !find_midi(cfg)) {
        usb_host_device_close(s_client, dev);
        return;
    }
    if (usb_host_interface_claim(s_client, dev, s_if, 0) != ESP_OK) {
        ESP_LOGW(TAG, "could not claim the MIDI interface %u", s_if);
        usb_host_device_close(s_client, dev);
        return;
    }
    if (usb_host_transfer_alloc(OUT_PACKETS * 4, 0, &s_xout) != ESP_OK) {
        usb_host_interface_release(s_client, dev, s_if);
        usb_host_device_close(s_client, dev);
        return;
    }
    s_dev = dev;
    memset(&s_enc, 0, sizeof(s_enc));
    xQueueReset(s_q);
    if (s_ep_in && s_in_mps > 0 && usb_host_transfer_alloc(s_in_mps, 0, &s_xin) == ESP_OK) {
        s_xin->device_handle = dev;
        s_xin->bEndpointAddress = s_ep_in;
        s_xin->num_bytes = s_in_mps;
        s_xin->callback = in_cb;
        s_xin->context = NULL;
        s_ready = true;
        __atomic_fetch_add(&s_in_flight, 1, __ATOMIC_SEQ_CST);
        if (usb_host_transfer_submit(s_xin) != ESP_OK) {
            __atomic_fetch_sub(&s_in_flight, 1, __ATOMIC_SEQ_CST);
        }
    }
    s_ready = true;
    ESP_LOGI(TAG, "pedal MIDI ready: interface %u out 0x%02x in 0x%02x", s_if, s_ep_out, s_ep_in);
}

static void scan_present(void)
{
    uint8_t addrs[8];
    int n = 0;
    if (usb_host_device_addr_list_fill(sizeof(addrs), addrs, &n) != ESP_OK) {
        return;
    }
    for (int i = 0; i < n && !s_dev; i++) {
        try_open(addrs[i]);
    }
}

static void worker(void *arg)
{
    (void)arg;
    uint8_t pkt[4];
    while (true) {
        if (s_gone) {
            s_gone = false;
            close_dev(1000);
        } else if (s_close_pending) {
            close_dev(0);
        }
        if (s_scan) {
            s_scan = false;
            scan_present();
        }
        uint8_t addr = s_open_addr;
        if (addr) {
            s_open_addr = 0;
            try_open(addr);
        }
        if (xQueueReceive(s_q, pkt, pdMS_TO_TICKS(100)) != pdTRUE) {
            continue;
        }
        if (!s_ready || !s_xout || s_out_flight > 0) {
            continue; /* no pedal, or the last send has not come back: the message is dropped */
        }
        xSemaphoreTake(s_out_done, 0);
        size_t n = 4;
        memcpy(s_xout->data_buffer, pkt, 4);
        while (n + 4 <= OUT_PACKETS * 4 && xQueueReceive(s_q, s_xout->data_buffer + n, 0) == pdTRUE) {
            n += 4;
        }
        s_xout->device_handle = s_dev;
        s_xout->bEndpointAddress = s_ep_out;
        s_xout->num_bytes = (int)n;
        s_xout->callback = out_cb;
        s_xout->context = NULL;
        __atomic_fetch_add(&s_out_flight, 1, __ATOMIC_SEQ_CST);
        esp_err_t err = usb_host_transfer_submit(s_xout);
        if (err != ESP_OK) {
            __atomic_fetch_sub(&s_out_flight, 1, __ATOMIC_SEQ_CST);
            ESP_LOGW(TAG, "submit: %s", esp_err_to_name(err));
            continue;
        }
        if (xSemaphoreTake(s_out_done, pdMS_TO_TICKS(500)) != pdTRUE) {
            ESP_LOGW(TAG, "send timed out, clearing the endpoint");
            usb_host_endpoint_halt(s_dev, s_ep_out);
            usb_host_endpoint_flush(s_dev, s_ep_out);
            xSemaphoreTake(s_out_done, pdMS_TO_TICKS(500));
            usb_host_endpoint_clear(s_dev, s_ep_out);
        }
        if (s_out_flight == 0 && s_xout->status != USB_TRANSFER_STATUS_COMPLETED) {
            ESP_LOGW(TAG, "send status %d", (int)s_xout->status);
        }
    }
}

void tonerelay_usb_midi_start(void)
{
    s_q = xQueueCreate(512, 4);
    s_out_done = xSemaphoreCreateBinary();
    s_enc_mu = xSemaphoreCreateMutex();
    if (!s_q || !s_out_done || !s_enc_mu) {
        return;
    }
    usb_host_client_config_t cfg = {
        .is_synchronous = false,
        .max_num_event_msg = 5,
        .async = {.client_event_callback = client_event, .callback_arg = NULL},
    };
    esp_err_t err = usb_host_client_register(&cfg, &s_client);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "client_register: %s", esp_err_to_name(err));
        return;
    }
    xTaskCreatePinnedToCore(client_task, "usb_midi_cli", 4096, NULL, 13, NULL, 0);
    xTaskCreate(worker, "usb_midi", 4096, NULL, 5, NULL);
    s_scan = true; /* a pedal that was plugged in before the start sends no new-device event */
}

bool tonerelay_usb_midi_ready(void)
{
    return s_ready;
}

void tonerelay_usb_midi_send(const uint8_t *bytes, size_t n)
{
    if (!s_ready || !s_enc_mu || xSemaphoreTake(s_enc_mu, pdMS_TO_TICKS(20)) != pdTRUE) {
        return;
    }
    uint8_t packets[4 * 32];
    for (size_t i = 0; i < n; i += 32) {
        size_t m = n - i > 32 ? 32 : n - i;
        size_t w = usbmidi_encode(&s_enc, bytes + i, m, packets, sizeof(packets));
        for (size_t j = 0; j < w; j += 4) {
            echo_remember(packets + j);
            xQueueSend(s_q, packets + j, 0); /* a full queue drops the message: the pedal is not keeping up */
        }
    }
    xSemaphoreGive(s_enc_mu);
}

#else /* !CONFIG_TONERELAY_BLE_MIDI */

void tonerelay_usb_midi_start(void) {}
bool tonerelay_usb_midi_ready(void) { return false; }
void tonerelay_usb_midi_send(const uint8_t *bytes, size_t n) { (void)bytes; (void)n; }

#endif
