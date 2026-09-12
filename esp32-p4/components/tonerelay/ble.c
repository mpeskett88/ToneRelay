#include "tonerelay.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#define TAG "tr_ble"
#define LOCAL_NAME "ToneRelay"
#define CHUNK 160
#define FLAG_FIRST 0x01
#define FLAG_LAST 0x02
#define CMD_MAX 24576

char *hxbridge_handle_json(const char *json, int json_len);
void hxbridge_free(char *p);

/* uuid5 hxblue.helix-bridge.gatt.* — little-endian for NimBLE. */
static const ble_uuid128_t SVC_UUID =
    BLE_UUID128_INIT(0x5c, 0x2b, 0x5a, 0x38, 0x30, 0xf4, 0xca, 0xa0,
                     0xfd, 0x5e, 0xd2, 0xe8, 0xb2, 0x0b, 0x3e, 0x36);
static const ble_uuid128_t CMD_UUID =
    BLE_UUID128_INIT(0x42, 0xd3, 0x34, 0xb3, 0x5d, 0x8b, 0x36, 0xb7,
                     0x62, 0x5a, 0x9a, 0xa2, 0xf0, 0xca, 0xbf, 0x6b);
static const ble_uuid128_t RSP_UUID =
    BLE_UUID128_INIT(0x86, 0x68, 0x80, 0xf3, 0x80, 0x30, 0x4d, 0xa5,
                     0x4b, 0x5e, 0xb2, 0x79, 0x14, 0x03, 0x47, 0x37);
static const ble_uuid128_t STATUS_UUID =
    BLE_UUID128_INIT(0x6c, 0x32, 0x7d, 0x58, 0x79, 0xfd, 0x5a, 0x8b,
                     0x35, 0x52, 0x41, 0x29, 0xb0, 0xc7, 0xbe, 0x87);

static uint16_t s_cmd_handle;
static uint16_t s_rsp_handle;
static uint16_t s_status_handle;
static uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static uint8_t s_own_addr_type;
static bool s_ble_up;

static uint8_t s_asm[CMD_MAX];
static uint16_t s_asm_total;
static uint16_t s_asm_filled;

typedef struct {
    uint16_t conn;
    uint16_t len;
    char *json;
} job_t;

static QueueHandle_t s_jobs;

static int gap_event(struct ble_gap_event *event, void *arg);

static void advertise(void)
{
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (uint8_t *)LOCAL_NAME;
    fields.name_len = sizeof(LOCAL_NAME) - 1;
    fields.name_is_complete = 1;
    fields.uuids128 = &SVC_UUID;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;
    ble_gap_adv_set_fields(&fields);

    struct ble_gap_adv_params adv = {0};
    adv.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv.disc_mode = BLE_GAP_DISC_MODE_GEN;
    int rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &adv, gap_event, NULL);
    if (rc != 0) {
        ESP_LOGW(TAG, "adv_start rc=%d", rc);
    } else {
        ESP_LOGI(TAG, "advertising as %s", LOCAL_NAME);
        s_ble_up = true;
    }
}

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_conn = event->connect.conn_handle;
            ESP_LOGI(TAG, "connected handle=%u", s_conn);
        } else {
            advertise();
        }
        return 0;
    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnected");
        s_conn = BLE_HS_CONN_HANDLE_NONE;
        s_asm_total = 0;
        s_asm_filled = 0;
        advertise();
        return 0;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        return 0;
    case BLE_GAP_EVENT_SUBSCRIBE:
        return 0;
    default:
        return 0;
    }
}

static void on_sync(void)
{
    ble_hs_id_infer_auto(0, &s_own_addr_type);
    advertise();
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "nimble reset %d", reason);
    s_ble_up = false;
}

static void notify_chunks(uint16_t conn, const uint8_t *body, uint16_t total)
{
    uint16_t offset = 0;
    if (total == 0) {
        body = (const uint8_t *)"{}";
        total = 2;
    }
    while (offset < total) {
        uint16_t n = (uint16_t)(total - offset);
        if (n > CHUNK) {
            n = CHUNK;
        }
        uint8_t pkt[5 + CHUNK];
        pkt[0] = (uint8_t)((offset == 0 ? FLAG_FIRST : 0) | (offset + n >= total ? FLAG_LAST : 0));
        pkt[1] = (uint8_t)(total >> 8);
        pkt[2] = (uint8_t)(total & 0xff);
        pkt[3] = (uint8_t)(offset >> 8);
        pkt[4] = (uint8_t)(offset & 0xff);
        memcpy(pkt + 5, body + offset, n);
        struct os_mbuf *om = ble_hs_mbuf_from_flat(pkt, 5 + n);
        if (!om) {
            return;
        }
        int rc = ble_gatts_notify_custom(conn, s_rsp_handle, om);
        if (rc != 0) {
            ESP_LOGW(TAG, "notify rc=%d", rc);
            return;
        }
        offset = (uint16_t)(offset + n);
        vTaskDelay(pdMS_TO_TICKS(8));
    }
}

static void worker(void *arg)
{
    (void)arg;
    job_t job;
    while (xQueueReceive(s_jobs, &job, portMAX_DELAY) == pdTRUE) {
        if (!job.json) {
            continue;
        }
        char *out = hxbridge_handle_json(job.json, (int)job.len);
        free(job.json);
        if (!out) {
            continue;
        }
        notify_chunks(job.conn, (const uint8_t *)out, (uint16_t)strlen(out));
        hxbridge_free(out);
    }
}

static int cmd_write(struct os_mbuf *om)
{
    uint8_t hdr[5 + CHUNK];
    uint16_t n = OS_MBUF_PKTLEN(om);
    if (n < 5 || n > sizeof(hdr)) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    int rc = ble_hs_mbuf_to_flat(om, hdr, sizeof(hdr), &n);
    if (rc != 0) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    uint8_t flags = hdr[0];
    uint16_t total = (uint16_t)((hdr[1] << 8) | hdr[2]);
    uint16_t offset = (uint16_t)((hdr[3] << 8) | hdr[4]);
    uint16_t piece = (uint16_t)(n - 5);
    if (total > CMD_MAX || (uint32_t)offset + piece > CMD_MAX) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (flags & FLAG_FIRST) {
        s_asm_total = total;
        s_asm_filled = 0;
        memset(s_asm, 0, CMD_MAX);
    }
    memcpy(s_asm + offset, hdr + 5, piece);
    if (offset + piece > s_asm_filled) {
        s_asm_filled = (uint16_t)(offset + piece);
    }
    if (flags & FLAG_LAST) {
        uint16_t len = s_asm_total ? s_asm_total : s_asm_filled;
        char *copy = malloc((size_t)len + 1);
        if (!copy) {
            return BLE_ATT_ERR_INSUFFICIENT_RES;
        }
        memcpy(copy, s_asm, len);
        copy[len] = 0;
        job_t job = {.conn = s_conn, .len = len, .json = copy};
        if (xQueueSend(s_jobs, &job, 0) != pdTRUE) {
            free(copy);
            return BLE_ATT_ERR_UNLIKELY;
        }
        s_asm_total = 0;
        s_asm_filled = 0;
    }
    return 0;
}

static int access_cb(uint16_t conn_handle, uint16_t attr_handle,
                     struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)arg;
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR && attr_handle == s_cmd_handle) {
        return cmd_write(ctxt->om);
    }
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR && attr_handle == s_status_handle) {
        char buf[192];
        int n = snprintf(
            buf,
            sizeof(buf),
            "{\"usb\":%s,\"wifi_sta\":%s,\"setup_required\":%s}",
            helix_usb_present() ? "true" : "false",
            tonerelay_wifi_sta_up() ? "true" : "false",
            tonerelay_wifi_setup_required() ? "true" : "false"
        );
        if (n < 0) {
            return BLE_ATT_ERR_UNLIKELY;
        }
        return os_mbuf_append(ctxt->om, buf, (uint16_t)n) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static const struct ble_gatt_svc_def s_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &SVC_UUID.u,
        .characteristics = (struct ble_gatt_chr_def[]){
            {
                .uuid = &CMD_UUID.u,
                .access_cb = access_cb,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
                .val_handle = &s_cmd_handle,
            },
            {
                .uuid = &RSP_UUID.u,
                .access_cb = access_cb,
                .flags = BLE_GATT_CHR_F_NOTIFY | BLE_GATT_CHR_F_READ,
                .val_handle = &s_rsp_handle,
            },
            {
                .uuid = &STATUS_UUID.u,
                .access_cb = access_cb,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &s_status_handle,
            },
            {0},
        },
    },
    {0},
};

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void tonerelay_ble_start(void)
{
    s_jobs = xQueueCreate(2, sizeof(job_t));
    xTaskCreate(worker, "ble_cmd", 8192, NULL, 4, NULL);

    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init: %s", esp_err_to_name(err));
        return;
    }
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_svc_gap_device_name_set(LOCAL_NAME);
    ble_att_set_preferred_mtu(512);
    int rc = ble_gatts_count_cfg(s_svcs);
    if (rc != 0) {
        ESP_LOGE(TAG, "count_cfg %d", rc);
        return;
    }
    rc = ble_gatts_add_svcs(s_svcs);
    if (rc != 0) {
        ESP_LOGE(TAG, "add_svcs %d", rc);
        return;
    }
    nimble_port_freertos_init(host_task);
}

bool tonerelay_ble_up(void)
{
    return s_ble_up;
}
