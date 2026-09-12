#include "tonerelay.h"

#include <stdio.h>
#include <string.h>

#include "esp_bit_defs.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "usb/usb_helpers.h"
#include "usb/usb_host.h"
#include "usb/usb_types_ch9.h"

#include <stdint.h>

#define TAG "helix_usb"
#define VID 0x0E41
#define PID_FLOOR 0x4248
#define IFACE 0
#define EP_OUT 0x01
#define EP_IN 0x81
#define IN_MPS 512
#define OUT_MAX 4096
#define USB_LIB_PRIO 14
#define USB_CLI_PRIO 13
/* P4 HS DWC has 16 host channels; IN URBs queue on one bulk pipe. Keep a
 * short software queue so a Helix burst parks URBs (device NAKs) instead of
 * the USB client task spinning at high priority until the watchdog resets. */
#define IN_URBS 3
#define RX_QUEUE_LEN 16
#define FEATURE_ENDPOINT_HALT 0

typedef struct {
    uint16_t len;
    uint8_t data[IN_MPS];
} rx_item_t;

static usb_host_client_handle_t s_client;
static usb_device_handle_t s_dev;
static uint8_t s_addr;
static uint16_t s_pid;
static bool s_present;
static uint32_t s_enum_gen;
static bool s_open;
static bool s_closing;
static bool s_ignore_gone;
static usb_transfer_t *s_in[IN_URBS];
static usb_transfer_t *s_out;
static QueueHandle_t s_rx;
static SemaphoreHandle_t s_out_done;
static SemaphoreHandle_t s_ctrl_done;
static SemaphoreHandle_t s_lock;
static SemaphoreHandle_t s_rx_mu;
static usb_transfer_t *s_parked[IN_URBS];
static int s_nparked;
static unsigned s_parked_peak;
static int s_out_status;
static int s_out_actual;
static int s_ctrl_status;
static unsigned s_rx_drops;
static unsigned s_in_ok;
static unsigned s_tx_ok;
static unsigned s_in_logs;
static unsigned s_tx_logs;
static int s_last_in_n;
static int s_last_in_st;
static int s_in_mps = IN_MPS;
static char s_last_err[96];

static void set_err(const char *msg)
{
    if (!msg) {
        s_last_err[0] = 0;
        return;
    }
    strncpy(s_last_err, msg, sizeof(s_last_err) - 1);
    s_last_err[sizeof(s_last_err) - 1] = 0;
}

static void note_hx(usb_device_handle_t dev, uint8_t addr)
{
    const usb_device_desc_t *desc = NULL;
    if (usb_host_get_device_descriptor(dev, &desc) != ESP_OK || desc->idVendor != VID) {
        usb_host_device_close(s_client, dev);
        return;
    }
    /* Prefer Helix Floor when several HX devices are on the hub. */
    if (s_present && s_pid == PID_FLOOR && desc->idProduct != PID_FLOOR) {
        usb_host_device_close(s_client, dev);
        return;
    }
    s_addr = addr;
    s_pid = desc->idProduct;
    s_present = true;
    s_enum_gen++;
    ESP_LOGI(TAG, "HX device pid=%04x addr=%u gen=%u", s_pid, s_addr, (unsigned)s_enum_gen);
    usb_host_device_close(s_client, dev);
}

static bool enum_filter(const usb_device_desc_t *desc, uint8_t *cfg)
{
    *cfg = 1;
    ESP_LOGI(TAG, "enum vid=%04x pid=%04x", desc->idVendor, desc->idProduct);
    return desc->idVendor == VID;
}

static void in_cb(usb_transfer_t *xfer);

static void post_in(usb_transfer_t *xfer)
{
    xfer->num_bytes = s_in_mps;
    xfer->callback = in_cb;
    xfer->bEndpointAddress = EP_IN;
    xfer->device_handle = s_dev;
    xfer->timeout_ms = 0;
    esp_err_t err = usb_host_transfer_submit(xfer);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "post_in %s", esp_err_to_name(err));
    }
}

static bool enqueue_in(const uint8_t *data, int n)
{
    rx_item_t item = {0};
    item.len = (uint16_t)n;
    memcpy(item.data, data, (size_t)n);
    return xQueueSend(s_rx, &item, 0) == pdTRUE;
}

static void park_xfer(usb_transfer_t *xfer)
{
    if (s_nparked < IN_URBS) {
        s_parked[s_nparked++] = xfer;
        if ((unsigned)s_nparked > s_parked_peak) {
            s_parked_peak = (unsigned)s_nparked;
        }
        if (s_nparked == 1 || (s_nparked % 4) == 0) {
            ESP_LOGW(TAG, "IN parked n=%d depth=%d", xfer->actual_num_bytes, s_nparked);
        }
        return;
    }
    /* Every URB is already holding unread data. Dropping here loses stream
     * bytes and wedges the Helix; re-posting would overwrite them. */
    s_rx_drops++;
    ESP_LOGE(TAG, "IN park overflow drops=%u", s_rx_drops);
}

static void flush_parked(void)
{
    if (!s_rx_mu) {
        return;
    }
    xSemaphoreTake(s_rx_mu, portMAX_DELAY);
    while (s_nparked > 0) {
        usb_transfer_t *xfer = s_parked[0];
        int n = xfer->actual_num_bytes;
        if (n < 0) {
            n = 0;
        }
        if (n > IN_MPS) {
            n = IN_MPS;
        }
        if (n > 0 && !enqueue_in(xfer->data_buffer, n)) {
            break;
        }
        memmove(&s_parked[0], &s_parked[1], sizeof(s_parked[0]) * (size_t)(s_nparked - 1));
        s_nparked--;
        xSemaphoreGive(s_rx_mu);
        if (!s_closing && s_open) {
            post_in(xfer);
        }
        xSemaphoreTake(s_rx_mu, portMAX_DELAY);
    }
    xSemaphoreGive(s_rx_mu);
}

static void in_cb(usb_transfer_t *xfer)
{
    if (s_closing) {
        return;
    }
    int n = xfer->actual_num_bytes;
    if (n < 0) {
        n = 0;
    }
    if (n > IN_MPS) {
        n = IN_MPS;
    }
    s_last_in_n = n;
    s_last_in_st = (int)xfer->status;
    if (xfer->status != USB_TRANSFER_STATUS_COMPLETED &&
        xfer->status != USB_TRANSFER_STATUS_CANCELED) {
        ESP_LOGW(TAG, "IN status=%d n=%d", (int)xfer->status, n);
    } else if (n > 0) {
        s_in_ok++;
        if (s_in_logs < 8) {
            s_in_logs++;
            ESP_LOGI(TAG, "IN n=%d drops=%u parked=%d", n, s_rx_drops, s_nparked);
        }
    }
    bool hold = false;
    if (xfer->status == USB_TRANSFER_STATUS_COMPLETED && s_rx && n > 0) {
        xSemaphoreTake(s_rx_mu, portMAX_DELAY);
        if (!enqueue_in(xfer->data_buffer, n)) {
            park_xfer(xfer);
            hold = true;
        }
        xSemaphoreGive(s_rx_mu);
    }
    if (!hold && !s_closing && s_open) {
        post_in(xfer);
    }
    /* Let the idle task run during a bulk IN burst. USB client used to sit
     * at priority 21 and starve the 5s task watchdog mid-transfer. */
    if (n > 0 && (s_in_ok & 3u) == 0) {
        vTaskDelay(1);
    }
}

static void out_cb(usb_transfer_t *xfer)
{
    s_out_status = (int)xfer->status;
    s_out_actual = xfer->actual_num_bytes;
    if (s_out_done) {
        xSemaphoreGive(s_out_done);
    }
}

static void ctrl_cb(usb_transfer_t *xfer)
{
    s_ctrl_status = (int)xfer->status;
    if (s_ctrl_done) {
        xSemaphoreGive(s_ctrl_done);
    }
}

static void client_event(const usb_host_client_event_msg_t *msg, void *arg)
{
    (void)arg;
    if (msg->event == USB_HOST_CLIENT_EVENT_NEW_DEV) {
        usb_device_handle_t dev = NULL;
        if (usb_host_device_open(s_client, msg->new_dev.address, &dev) != ESP_OK) {
            return;
        }
        note_hx(dev, msg->new_dev.address);
    } else if (msg->event == USB_HOST_CLIENT_EVENT_DEV_GONE) {
        if (s_closing || s_ignore_gone) {
            ESP_LOGI(TAG, "HX gone ignored (local close)");
            return;
        }
        ESP_LOGW(TAG, "HX device gone");
        s_present = false;
        s_open = false;
        s_enum_gen++;
    }
}

static void adopt_present(void)
{
    uint8_t addrs[8];
    int n = 0;
    if (usb_host_device_addr_list_fill(8, addrs, &n) != ESP_OK || n <= 0) {
        return;
    }
    for (int i = 0; i < n; i++) {
        if (s_present && s_pid == PID_FLOOR) {
            break;
        }
        usb_device_handle_t dev = NULL;
        if (usb_host_device_open(s_client, addrs[i], &dev) != ESP_OK) {
            continue;
        }
        note_hx(dev, addrs[i]);
    }
}

static void host_lib_task(void *arg)
{
    (void)arg;
    uint32_t flags = 0;
    while (true) {
        usb_host_lib_handle_events(portMAX_DELAY, &flags);
        if (flags != 0) {
            ESP_LOGI(TAG, "host flags=0x%lx", (unsigned long)flags);
        }
    }
}

static void client_task(void *arg)
{
    (void)arg;
    while (true) {
        usb_host_client_handle_events(s_client, portMAX_DELAY);
    }
}

static void dump_cfg(void)
{
    usb_device_info_t info = {0};
    if (usb_host_device_info(s_dev, &info) == ESP_OK) {
        const char *speed = info.speed == USB_SPEED_HIGH ? "HS"
                           : info.speed == USB_SPEED_FULL ? "FS"
                           : info.speed == USB_SPEED_LOW ? "LS"
                           : "?";
        ESP_LOGI(TAG, "dev addr=%u speed=%s cfg=%u mps0=%u",
                 info.dev_addr, speed, info.bConfigurationValue, info.bMaxPacketSize0);
    }
    const usb_config_desc_t *cfg = NULL;
    if (usb_host_get_active_config_descriptor(s_dev, &cfg) != ESP_OK || !cfg) {
        ESP_LOGW(TAG, "no config descriptor");
        return;
    }
    ESP_LOGI(TAG, "config wTotalLength=%u interfaces=%u", cfg->wTotalLength, cfg->bNumInterfaces);
    usb_print_config_descriptor(cfg, NULL);
    const usb_ep_desc_t *ep_in =
        usb_parse_endpoint_descriptor_by_address(cfg, IFACE, 0, EP_IN, NULL);
    const usb_ep_desc_t *ep_out =
        usb_parse_endpoint_descriptor_by_address(cfg, IFACE, 0, EP_OUT, NULL);
    if (ep_in) {
        s_in_mps = USB_EP_DESC_GET_MPS(ep_in);
        if (s_in_mps <= 0 || s_in_mps > IN_MPS) {
            s_in_mps = IN_MPS;
        }
        ESP_LOGI(TAG, "IF0 IN 0x%02x type=%u mps=%d",
                 ep_in->bEndpointAddress, USB_EP_DESC_GET_XFERTYPE(ep_in), s_in_mps);
    } else {
        ESP_LOGW(TAG, "IF0 has no EP 0x%02x", EP_IN);
    }
    if (ep_out) {
        ESP_LOGI(TAG, "IF0 OUT 0x%02x type=%u mps=%u",
                 ep_out->bEndpointAddress, USB_EP_DESC_GET_XFERTYPE(ep_out),
                 (unsigned)USB_EP_DESC_GET_MPS(ep_out));
    } else {
        ESP_LOGW(TAG, "IF0 has no EP 0x%02x", EP_OUT);
    }
}

/* Linux usb_clear_halt: CLEAR_FEATURE ENDPOINT_HALT on the device, then un-halt
 * the host pipe so both toggles restart at DATA0. usb_host_endpoint_clear alone
 * only works if the host pipe is already halted and does not talk to the device. */
static void clear_halt(uint8_t ep)
{
    usb_transfer_t *xfer = NULL;
    if (usb_host_transfer_alloc(sizeof(usb_setup_packet_t), 0, &xfer) != ESP_OK) {
        ESP_LOGW(TAG, "clear_halt 0x%02x: no mem", ep);
        return;
    }
    usb_setup_packet_t *setup = (usb_setup_packet_t *)xfer->data_buffer;
    setup->bmRequestType = USB_BM_REQUEST_TYPE_DIR_OUT | USB_BM_REQUEST_TYPE_TYPE_STANDARD |
                           USB_BM_REQUEST_TYPE_RECIP_ENDPOINT;
    setup->bRequest = USB_B_REQUEST_CLEAR_FEATURE;
    setup->wValue = FEATURE_ENDPOINT_HALT;
    setup->wIndex = ep;
    setup->wLength = 0;
    xfer->num_bytes = sizeof(usb_setup_packet_t);
    xfer->device_handle = s_dev;
    xfer->callback = ctrl_cb;
    xfer->bEndpointAddress = 0;
    xfer->timeout_ms = 1000;
    xSemaphoreTake(s_ctrl_done, 0);
    esp_err_t err = usb_host_transfer_submit_control(s_client, xfer);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "clear_halt 0x%02x submit %s", ep, esp_err_to_name(err));
        usb_host_transfer_free(xfer);
        return;
    }
    if (xSemaphoreTake(s_ctrl_done, pdMS_TO_TICKS(1000)) != pdTRUE) {
        ESP_LOGW(TAG, "clear_halt 0x%02x timeout", ep);
    } else if (s_ctrl_status != USB_TRANSFER_STATUS_COMPLETED) {
        ESP_LOGW(TAG, "clear_halt 0x%02x status=%d", ep, s_ctrl_status);
    } else {
        ESP_LOGI(TAG, "clear_halt 0x%02x ok", ep);
    }
    usb_host_transfer_free(xfer);
    /* Do not halt/flush here: that left the Helix IN pipe silent on this host. */
}

static void clear_eps(void)
{
    clear_halt(EP_OUT);
    clear_halt(EP_IN);
}

int helix_usb_start(void)
{
    s_lock = xSemaphoreCreateMutex();
    s_rx_mu = xSemaphoreCreateMutex();
    s_rx = xQueueCreate(RX_QUEUE_LEN, sizeof(rx_item_t));
    s_out_done = xSemaphoreCreateBinary();
    s_ctrl_done = xSemaphoreCreateBinary();
    if (!s_lock || !s_rx_mu || !s_rx || !s_out_done || !s_ctrl_done) {
        return -3;
    }

    usb_host_config_t host_cfg = {
        .skip_phy_setup = false,
        .intr_flags = ESP_INTR_FLAG_LEVEL1,
        .enum_filter_cb = enum_filter,
        .peripheral_map = BIT0,
    };
    esp_err_t err = usb_host_install(&host_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "usb_host_install: %s", esp_err_to_name(err));
        return -3;
    }
    xTaskCreatePinnedToCore(host_lib_task, "usb_lib", 4096, NULL, USB_LIB_PRIO, NULL, 0);

    usb_host_client_config_t client_cfg = {
        .is_synchronous = false,
        .max_num_event_msg = 5,
        .async = {
            .client_event_callback = client_event,
            .callback_arg = NULL,
        },
    };
    err = usb_host_client_register(&client_cfg, &s_client);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "client_register: %s", esp_err_to_name(err));
        return -3;
    }
    xTaskCreatePinnedToCore(client_task, "usb_cli", 4096, NULL, USB_CLI_PRIO, NULL, 0);
    vTaskDelay(pdMS_TO_TICKS(50));
    adopt_present();
    ESP_LOGI(TAG, "USB host started");
    return 0;
}

int helix_usb_open(uint16_t *pid_out)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (!s_present) {
        set_err("not present");
        xSemaphoreGive(s_lock);
        return -2;
    }
    if (s_open) {
        if (pid_out) {
            *pid_out = s_pid;
        }
        xSemaphoreGive(s_lock);
        return 0;
    }

    s_closing = false;
    s_ignore_gone = false;
    esp_err_t err = usb_host_device_open(s_client, s_addr, &s_dev);
    if (err != ESP_OK) {
        snprintf(s_last_err, sizeof(s_last_err), "device_open %s addr=%u", esp_err_to_name(err), s_addr);
        ESP_LOGE(TAG, "%s", s_last_err);
        xSemaphoreGive(s_lock);
        return -3;
    }
    dump_cfg();

    /* HX Edit claims, releases, and claims again so channel state is cleared. */
    err = usb_host_interface_claim(s_client, s_dev, IFACE, 0);
    if (err != ESP_OK) {
        snprintf(s_last_err, sizeof(s_last_err), "claim %s", esp_err_to_name(err));
        ESP_LOGE(TAG, "%s", s_last_err);
        usb_host_device_close(s_client, s_dev);
        s_dev = NULL;
        xSemaphoreGive(s_lock);
        return -4;
    }
    usb_host_interface_release(s_client, s_dev, IFACE);
    err = usb_host_interface_claim(s_client, s_dev, IFACE, 0);
    if (err != ESP_OK) {
        snprintf(s_last_err, sizeof(s_last_err), "reclaim %s", esp_err_to_name(err));
        ESP_LOGE(TAG, "%s", s_last_err);
        usb_host_device_close(s_client, s_dev);
        s_dev = NULL;
        xSemaphoreGive(s_lock);
        return -5;
    }
    clear_eps();

    for (int i = 0; i < IN_URBS; i++) {
        if (usb_host_transfer_alloc(IN_MPS, 0, &s_in[i]) != ESP_OK) {
            set_err("transfer_alloc IN failed");
            ESP_LOGE(TAG, "%s", s_last_err);
            for (int j = 0; j < i; j++) {
                usb_host_transfer_free(s_in[j]);
                s_in[j] = NULL;
            }
            usb_host_interface_release(s_client, s_dev, IFACE);
            usb_host_device_close(s_client, s_dev);
            s_dev = NULL;
            xSemaphoreGive(s_lock);
            return -6;
        }
    }
    if (usb_host_transfer_alloc(OUT_MAX, 0, &s_out) != ESP_OK) {
        set_err("transfer_alloc OUT failed");
        ESP_LOGE(TAG, "%s", s_last_err);
        for (int i = 0; i < IN_URBS; i++) {
            usb_host_transfer_free(s_in[i]);
            s_in[i] = NULL;
        }
        usb_host_interface_release(s_client, s_dev, IFACE);
        usb_host_device_close(s_client, s_dev);
        s_dev = NULL;
        xSemaphoreGive(s_lock);
        return -6;
    }

    xQueueReset(s_rx);
    xSemaphoreTake(s_rx_mu, portMAX_DELAY);
    s_nparked = 0;
    memset(s_parked, 0, sizeof(s_parked));
    s_parked_peak = 0;
    xSemaphoreGive(s_rx_mu);
    s_rx_drops = 0;
    s_in_ok = 0;
    s_tx_ok = 0;
    s_in_logs = 0;
    s_tx_logs = 0;
    set_err("");
    s_open = true;
    for (int i = 0; i < IN_URBS; i++) {
        post_in(s_in[i]);
    }

    if (pid_out) {
        *pid_out = s_pid;
    }
    ESP_LOGI(TAG, "interface 0 claimed pid=%04x", s_pid);
    xSemaphoreGive(s_lock);
    return 0;
}

int helix_usb_close(void)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (!s_open && !s_dev) {
        xSemaphoreGive(s_lock);
        return 0;
    }
    s_closing = true;
    s_ignore_gone = true;
    s_open = false;
    if (s_rx_mu) {
        xSemaphoreTake(s_rx_mu, portMAX_DELAY);
        s_nparked = 0;
        memset(s_parked, 0, sizeof(s_parked));
        xSemaphoreGive(s_rx_mu);
    }
    if (s_dev) {
        usb_host_endpoint_halt(s_dev, EP_IN);
        usb_host_endpoint_flush(s_dev, EP_IN);
        usb_host_endpoint_halt(s_dev, EP_OUT);
        usb_host_endpoint_flush(s_dev, EP_OUT);
        usb_host_interface_release(s_client, s_dev, IFACE);
        usb_host_device_close(s_client, s_dev);
        s_dev = NULL;
    }
    for (int i = 0; i < IN_URBS; i++) {
        usb_host_transfer_free(s_in[i]);
        s_in[i] = NULL;
    }
    usb_host_transfer_free(s_out);
    s_out = NULL;
    if (s_rx) {
        xQueueReset(s_rx);
    }
    ESP_LOGI(TAG, "interface released parked_peak=%u drops=%u", s_parked_peak, s_rx_drops);
    s_closing = false;
    xSemaphoreGive(s_lock);
    return 0;
}

int helix_usb_send(const uint8_t *data, size_t len, uint32_t timeout_ms)
{
    if (!s_open || !s_out || !data) {
        return -2;
    }
    if (len > OUT_MAX) {
        return -3;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (!s_open) {
        xSemaphoreGive(s_lock);
        return -2;
    }
    memcpy(s_out->data_buffer, data, len);
    s_out->num_bytes = (int)len;
    s_out->callback = out_cb;
    s_out->bEndpointAddress = EP_OUT;
    s_out->device_handle = s_dev;
    s_out->timeout_ms = timeout_ms;
    xSemaphoreTake(s_out_done, 0);
    esp_err_t err = usb_host_transfer_submit(s_out);
    xSemaphoreGive(s_lock);
    if (err != ESP_OK) {
        return -3;
    }
    TickType_t ticks = pdMS_TO_TICKS(timeout_ms ? timeout_ms : 1);
    if (xSemaphoreTake(s_out_done, ticks) != pdTRUE) {
        return -1;
    }
    if (s_out_status != USB_TRANSFER_STATUS_COMPLETED || s_out_actual != (int)len) {
        ESP_LOGW(TAG, "TX %u status=%d actual=%d", (unsigned)len, s_out_status, s_out_actual);
        return -3;
    }
    s_tx_ok++;
    if (s_tx_logs < 8) {
        s_tx_logs++;
        ESP_LOGI(TAG, "TX %u", (unsigned)len);
    }
    return 0;
}

int helix_usb_recv(uint8_t *buf, size_t buf_len, size_t *out_len, uint32_t timeout_ms)
{
    if (!buf || !out_len) {
        return -3;
    }
    *out_len = 0;
    if (!s_open) {
        return -2;
    }
    flush_parked();
    rx_item_t item;
    TickType_t ticks = timeout_ms == 0 ? 0 : pdMS_TO_TICKS(timeout_ms);
    if (xQueueReceive(s_rx, &item, ticks) != pdTRUE) {
        flush_parked();
        if (xQueueReceive(s_rx, &item, 0) != pdTRUE) {
            return -1;
        }
    }
    size_t n = item.len;
    if (n > buf_len) {
        n = buf_len;
    }
    memcpy(buf, item.data, n);
    *out_len = n;
    flush_parked();
    return 0;
}

bool helix_usb_present(void)
{
    return s_present;
}

bool helix_usb_claimed(void)
{
    return s_open;
}

uint16_t helix_usb_pid(void)
{
    return s_pid;
}

uint32_t helix_usb_enum_gen(void)
{
    return s_enum_gen;
}

void helix_usb_stats(
    uint32_t *drops,
    uint32_t *in_ok,
    uint32_t *tx_ok,
    int32_t *last_n,
    int32_t *last_st,
    uint32_t *parked,
    uint32_t *queued
)
{
    if (drops) {
        *drops = s_rx_drops;
    }
    if (in_ok) {
        *in_ok = s_in_ok;
    }
    if (tx_ok) {
        *tx_ok = s_tx_ok;
    }
    if (last_n) {
        *last_n = s_last_in_n;
    }
    if (last_st) {
        *last_st = s_last_in_st;
    }
    if (parked) {
        *parked = (uint32_t)s_nparked;
    }
    if (queued) {
        *queued = s_rx ? (uint32_t)uxQueueMessagesWaiting(s_rx) : 0;
    }
}

const char *helix_usb_last_error(void)
{
    return s_last_err;
}
