#include "tonerelay.h"

#include "sdkconfig.h"

#if CONFIG_TONERELAY_BLE_MIDI

#include <stdio.h>
#include <string.h>

#include "blemidi.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
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

#define TAG "tr_midi"
#define PKT_MAX 512

void ble_store_config_init(void);

/* MIDI over Bluetooth LE: service 03B80E5A-EDE8-4B33-A751-6CE34EC4C700, one characteristic 7772E5DB-3868-4112-A1A9-F2669D106BF3
 * (read, write, write without response, notify). Little-endian for NimBLE. */
static const ble_uuid128_t MIDI_SVC_UUID =
    BLE_UUID128_INIT(0x00, 0xc7, 0xc4, 0x4e, 0xe3, 0x6c, 0x51, 0xa7,
                     0x33, 0x4b, 0xe8, 0xed, 0x5a, 0x0e, 0xb8, 0x03);
static const ble_uuid128_t MIDI_CHR_UUID =
    BLE_UUID128_INIT(0xf3, 0x6b, 0x10, 0x9d, 0x66, 0xf2, 0xa9, 0xa1,
                     0x12, 0x41, 0x68, 0x38, 0xdb, 0xe5, 0x72, 0x77);

static uint16_t s_chr_handle;
static uint8_t s_own_addr_type;
static bool s_up;
static uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_mtu = 23;
static uint16_t s_notify_conn = BLE_HS_CONN_HANDLE_NONE; /* the link that has subscribed to notifications, if any */
static uint8_t s_muid[4]; /* our MIDI-CI id, chosen at start */
static void (*s_sink)(const uint8_t *bytes, size_t n);

static void log_sink(const uint8_t *bytes, size_t n)
{
    /* MIDI clock (24 a beat) and active sensing would flood the console: count them and say so now and then. */
    static uint32_t ticks;
    if (n == 1 && (bytes[0] == 0xF8 || bytes[0] == 0xFE)) {
        if (++ticks % 96 == 0) {
            ESP_LOGI(TAG, "midi in: %u clock/sensing bytes so far", (unsigned)ticks);
        }
        return;
    }
    char hex[3 * 32 + 4];
    size_t shown = n > 32 ? 32 : n;
    for (size_t i = 0; i < shown; i++) {
        snprintf(hex + 3 * i, 4, "%02X ", bytes[i]);
    }
    ESP_LOGI(TAG, "midi in (%u bytes): %s%s", (unsigned)n, hex, n > shown ? "..." : "");
}

void tonerelay_midi_set_sink(void (*sink)(const uint8_t *bytes, size_t n))
{
    s_sink = sink;
}

bool tonerelay_midi_ble_up(void)
{
    return s_up;
}

static int gap_event(struct ble_gap_event *event, void *arg);

static void advertise(void)
{
    /* The MIDI service UUID goes in the advertisement, where apps look for it; the name goes in the scan response. */
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids128 = &MIDI_SVC_UUID;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGW(TAG, "adv_set_fields rc=%d", rc);
        return;
    }

    char name[40];
    tonerelay_profile_instance(name, sizeof(name));
    size_t name_len = strlen(name);
    struct ble_hs_adv_fields rsp = {0};
    rsp.name = (uint8_t *)name;
    rsp.name_len = name_len > 29 ? 29 : name_len;
    rsp.name_is_complete = name_len <= 29;
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGW(TAG, "adv_rsp_set_fields rc=%d", rc);
        return;
    }

    struct ble_gap_adv_params adv = {0};
    adv.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &adv, gap_event, NULL);
    if (rc == BLE_HS_EALREADY) {
        s_up = true; /* it is advertising already, for a second device while one is connected */
    } else if (rc != 0) {
        ESP_LOGW(TAG, "adv_start rc=%d", rc);
    } else {
        ESP_LOGI(TAG, "advertising MIDI as %s", name);
        s_up = true;
    }
}

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_conn = event->connect.conn_handle;
            ESP_LOGI(TAG, "connected handle=%u", event->connect.conn_handle);
            /* The specification asks for a connection interval of 11.25 to 15 ms, for low latency. */
            struct ble_gap_upd_params params = {
                .itvl_min = 9, .itvl_max = 12, .latency = 0, .supervision_timeout = 400,
                .min_ce_len = 0, .max_ce_len = 0,
            };
            ble_gap_update_params(event->connect.conn_handle, &params);
            /* Let a second phone or computer find the box while one is connected (the stack allows two links). */
            advertise();
        } else {
            ESP_LOGW(TAG, "connect failed status=%d", event->connect.status);
            advertise();
        }
        return 0;
    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnected reason=%d", event->disconnect.reason);
        s_conn = BLE_HS_CONN_HANDLE_NONE;
        if (s_notify_conn == event->disconnect.conn.conn_handle) {
            s_notify_conn = BLE_HS_CONN_HANDLE_NONE;
        }
        advertise();
        return 0;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        return 0;
    case BLE_GAP_EVENT_SUBSCRIBE:
        ESP_LOGI(TAG, "subscribe attr=%u notify=%d indicate=%d", event->subscribe.attr_handle, event->subscribe.cur_notify,
                 event->subscribe.cur_indicate);
        if (event->subscribe.attr_handle == s_chr_handle) {
            if (event->subscribe.cur_notify) {
                s_notify_conn = event->subscribe.conn_handle;
            } else if (s_notify_conn == event->subscribe.conn_handle) {
                s_notify_conn = BLE_HS_CONN_HANDLE_NONE;
            }
        }
        return 0;
    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "mtu=%u", event->mtu.value);
        s_mtu = event->mtu.value;
        return 0;
    case BLE_GAP_EVENT_CONN_UPDATE:
        ESP_LOGI(TAG, "conn update status=%d", event->conn_update.status);
        return 0;
    case BLE_GAP_EVENT_PASSKEY_ACTION:
        ESP_LOGW(TAG, "passkey action %d (not supported: Just Works only)", event->passkey.params.action);
        return 0;
    case BLE_GAP_EVENT_ENC_CHANGE:
        ESP_LOGI(TAG, "link encryption status=%d", event->enc_change.status);
        return 0;
    case BLE_GAP_EVENT_REPEAT_PAIRING: {
        /* The phone lost its bond and asks again: forget the old one and pair anew. */
        struct ble_gap_conn_desc desc;
        if (ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc) == 0) {
            ble_store_util_delete_peer(&desc.peer_id_addr);
        }
        return BLE_GAP_REPEAT_PAIRING_RETRY;
    }
    default:
        return 0;
    }
}

/* Apple's MIDI stack sends a MIDI-CI Discovery when a device connects and does not carry on until it is answered. */
static bool answer_discovery(uint16_t conn, const uint8_t *midi, size_t n)
{
    uint8_t reply[48];
    size_t r = blemidi_ci_discovery_reply(midi, n, s_muid, reply, sizeof(reply));
    if (r == 0) {
        return false;
    }
    uint8_t pkt[64];
    size_t len = blemidi_encode_sysex(reply, r, (uint32_t)(esp_timer_get_time() / 1000), pkt, sizeof(pkt));
    struct os_mbuf *om = len ? ble_hs_mbuf_from_flat(pkt, (uint16_t)len) : NULL;
    if (!om) {
        return true;
    }
    int rc = ble_gatts_notify_custom(conn, s_chr_handle, om);
    ESP_LOGI(TAG, "answered MIDI-CI discovery rc=%d", rc);
    return true;
}

static int chr_access(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)arg;
    if (attr_handle != s_chr_handle) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        ESP_LOGI(TAG, "read midi characteristic (conn %u)", conn_handle);
        return 0; /* the specification wants an empty value */
    }
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    uint8_t pkt[PKT_MAX];
    uint16_t len = 0;
    if (OS_MBUF_PKTLEN(ctxt->om) > sizeof(pkt)) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (ble_hs_mbuf_to_flat(ctxt->om, pkt, sizeof(pkt), &len) != 0) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    uint8_t midi[PKT_MAX];
    size_t n = blemidi_parse(pkt, len, midi, sizeof(midi));
    ESP_LOGD(TAG, "write %u bytes -> %u midi", len, (unsigned)n);
    if (n > 0 && answer_discovery(conn_handle, midi, n)) {
        return 0; /* MIDI-CI between the phone and us is not for the pedal */
    }
    if (n > 0) {
        if (s_sink) {
            s_sink(midi, n);
        } else {
            log_sink(midi, n);
            tonerelay_usb_midi_send(midi, n); /* on to the pedal, if it is plugged in */
        }
    }
    return 0;
}

/* What the pedal sent (USB-MIDI event packets), to the phone or tablet that has subscribed, in as few notifications as fit the link.
 * Dropped when none has subscribed. */
void tonerelay_midi_ble_notify_usb(const uint8_t *pkts, size_t len)
{
    uint16_t conn = s_notify_conn;
    if (conn == BLE_HS_CONN_HANDLE_NONE) {
        return;
    }
    uint8_t out[64];
    size_t cap = s_mtu > 3 ? s_mtu - 3 : 20;
    if (cap > sizeof(out)) {
        cap = sizeof(out);
    }
    uint32_t ms = (uint32_t)(esp_timer_get_time() / 1000);
    while (len >= 4) {
        size_t used = 0;
        size_t n = blemidi_encode_usb_events(pkts, len, ms, out, cap, &used);
        if (used == 0) {
            break;
        }
        pkts += used;
        len -= used;
        if (n == 0) {
            continue;
        }
        struct os_mbuf *om = ble_hs_mbuf_from_flat(out, (uint16_t)n);
        if (!om || ble_gatts_notify_custom(conn, s_chr_handle, om) != 0) {
            ESP_LOGD(TAG, "notify dropped");
            return; /* the link is busy: drop the rest rather than queue it */
        }
    }
}

static const struct ble_gatt_svc_def s_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &MIDI_SVC_UUID.u,
        .characteristics = (struct ble_gatt_chr_def[]){
            {
                .uuid = &MIDI_CHR_UUID.u,
                .access_cb = chr_access,
                /* Encrypted only: the phone pairs ("Just Works") the first time, and the bond is kept. */
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP | BLE_GATT_CHR_F_NOTIFY
#if CONFIG_TONERELAY_BLE_MIDI_ENCRYPT
                         | BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_WRITE_ENC
#endif
                         ,
                .val_handle = &s_chr_handle,
            },
            {0},
        },
    },
    {0},
};

static void on_sync(void)
{
    ble_hs_id_infer_auto(0, &s_own_addr_type);
    advertise();
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "nimble reset %d", reason);
    s_up = false;
}

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void tonerelay_midi_ble_start(void)
{
    ESP_LOGI(TAG, "BLE MIDI starting, encrypted link %s",
#if CONFIG_TONERELAY_BLE_MIDI_ENCRYPT
             "required"
#else
             "not required"
#endif
    );
    do {
        for (int i = 0; i < 4; i++) {
            s_muid[i] = (uint8_t)(esp_random() & 0x7F);
        }
    } while (s_muid[0] == 0x7F && s_muid[1] == 0x7F && s_muid[2] == 0x7F && s_muid[3] == 0x7F);
    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init: %s", esp_err_to_name(err));
        return;
    }
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.store_status_cb = ble_store_util_status_rr;
    ble_hs_cfg.sm_io_cap = BLE_HS_IO_NO_INPUT_OUTPUT;
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    char name[40];
    tonerelay_profile_instance(name, sizeof(name));
    ble_svc_gap_device_name_set(name);
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
    ble_store_config_init();
    nimble_port_freertos_init(host_task);
}

/* Forgets every bond (the keys of each paired phone and tablet), in the store the bonds are kept in, so a box that is handed on no
 * longer trusts them. The phone or tablet keeps its own side: it has to forget the box too, then pair again. */
void tonerelay_midi_ble_forget_bonds(void)
{
    int rc = ble_store_clear();
    ESP_LOGW(TAG, "Bluetooth pairings erased rc=%d", rc);
}

#else /* !CONFIG_TONERELAY_BLE_MIDI */

void tonerelay_midi_ble_start(void) {}
bool tonerelay_midi_ble_up(void) { return false; }
void tonerelay_midi_set_sink(void (*sink)(const uint8_t *bytes, size_t n)) { (void)sink; }
void tonerelay_midi_ble_forget_bonds(void) {}
void tonerelay_midi_ble_notify_usb(const uint8_t *pkts, size_t len) { (void)pkts; (void)len; }

#endif
