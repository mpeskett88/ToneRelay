#include "tonerelay.h"

#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mdns.h"
#include "nvs.h"
#include "nvs_flash.h"

#define TAG "tr_wifi"
#define NVS_NS "tonerelay"
#define AP_SSID "ToneRelay"
#define AP_PASS_MIN 8
#define AP_PASS_MAX 63
#define RETRY_CAP_US (30ULL * 1000000ULL)

static bool s_sta_up;
static bool s_sta_configured;
static bool s_ap_secured;
static char s_sta_ip[16];
static char s_sta_ssid[33];
static int s_sta_rssi;
static int s_retry;
static esp_timer_handle_t s_sta_retry_timer;

static void json_escape(char *dst, size_t dst_len, const char *src)
{
    size_t o = 0;
    for (size_t i = 0; src[i] && o + 2 < dst_len; i++) {
        char c = src[i];
        if (c == '"' || c == '\\') {
            if (o + 3 >= dst_len) {
                break;
            }
            dst[o++] = '\\';
            dst[o++] = c;
        } else if ((unsigned char)c < 0x20) {
            continue;
        } else {
            dst[o++] = c;
        }
    }
    dst[o] = 0;
}

static bool nvs_load_sta(char *ssid, size_t ssid_len, char *pass, size_t pass_len)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) {
        return false;
    }
    size_t sl = ssid_len;
    size_t pl = pass_len;
    esp_err_t e1 = nvs_get_str(h, "ssid", ssid, &sl);
    esp_err_t e2 = nvs_get_str(h, "pass", pass, &pl);
    nvs_close(h);
    return e1 == ESP_OK && ssid[0] != 0 && e2 == ESP_OK;
}

static bool nvs_load_ap_pass(char *pass, size_t pass_len)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) {
        return false;
    }
    size_t pl = pass_len;
    esp_err_t err = nvs_get_str(h, "ap_pass", pass, &pl);
    nvs_close(h);
    return err == ESP_OK && pass[0] != 0;
}

static esp_err_t nvs_save_sta(const char *ssid, const char *pass)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(h, "ssid", ssid);
    if (err == ESP_OK) {
        err = nvs_set_str(h, "pass", pass ? pass : "");
    }
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err;
}

static esp_err_t nvs_save_ap_pass(const char *pass)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(h, "ap_pass", pass);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err;
}

static void nvs_erase_sta(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) {
        return;
    }
    nvs_erase_key(h, "ssid");
    nvs_erase_key(h, "pass");
    nvs_commit(h);
    nvs_close(h);
}

static void start_mdns(void)
{
    static bool started = false;
    if (started) {
        return;
    }
    if (mdns_init() != ESP_OK) {
        ESP_LOGW(TAG, "mdns_init failed");
        return;
    }
    mdns_hostname_set("tonerelay");
    mdns_instance_name_set("ToneRelay");
    mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
    started = true;
    ESP_LOGI(TAG, "mDNS tonerelay.local");
}

static void start_ap(void)
{
    wifi_config_t ap = {0};
    strncpy((char *)ap.ap.ssid, AP_SSID, sizeof(ap.ap.ssid));
    ap.ap.ssid_len = strlen(AP_SSID);
    ap.ap.channel = 6;
    ap.ap.max_connection = 4;
    ap.ap.pmf_cfg.required = false;
    char ap_pass[64] = {0};
    if (nvs_load_ap_pass(ap_pass, sizeof(ap_pass)) && strlen(ap_pass) >= AP_PASS_MIN) {
        ap.ap.authmode = WIFI_AUTH_WPA2_PSK;
        strncpy((char *)ap.ap.password, ap_pass, sizeof(ap.ap.password) - 1);
        s_ap_secured = true;
        ESP_LOGI(TAG, "SoftAP %s WPA2 at 192.168.4.1", AP_SSID);
    } else {
        ap.ap.authmode = WIFI_AUTH_OPEN;
        s_ap_secured = false;
        ESP_LOGI(TAG, "SoftAP %s open at 192.168.4.1", AP_SSID);
    }
    memset(ap_pass, 0, sizeof(ap_pass));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
}

static void start_sta(const char *ssid, const char *pass)
{
    wifi_config_t sta = {0};
    strncpy((char *)sta.sta.ssid, ssid, sizeof(sta.sta.ssid) - 1);
    strncpy((char *)sta.sta.password, pass ? pass : "", sizeof(sta.sta.password) - 1);
    sta.sta.threshold.authmode = (pass && pass[0]) ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
    strncpy(s_sta_ssid, ssid, sizeof(s_sta_ssid) - 1);
    s_retry = 0;
    ESP_LOGI(TAG, "STA joining ssid=%s", ssid);
    ESP_ERROR_CHECK(esp_wifi_connect());
}

static void sta_retry_cb(void *arg)
{
    (void)arg;
    if (s_sta_configured && !s_sta_up) {
        ESP_LOGW(TAG, "STA retry %d", s_retry);
        esp_wifi_connect();
    }
}

static uint64_t retry_delay_us(int attempt)
{
    uint64_t sec = 1ULL << (attempt > 8 ? 8 : attempt);
    if (sec > 30) {
        sec = 30;
    }
    return sec * 1000000ULL;
}

static void schedule_sta_retry(void)
{
    if (!s_sta_retry_timer || !s_sta_configured) {
        return;
    }
    s_retry++;
    uint64_t us = retry_delay_us(s_retry);
    if (us > RETRY_CAP_US) {
        us = RETRY_CAP_US;
    }
    esp_timer_stop(s_sta_retry_timer);
    esp_timer_start_once(s_sta_retry_timer, us);
}

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        char ssid[33] = {0};
        char pass[65] = {0};
        if (nvs_load_sta(ssid, sizeof(ssid), pass, sizeof(pass))) {
            s_sta_configured = true;
            start_sta(ssid, pass);
        }
        memset(pass, 0, sizeof(pass));
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_sta_up = false;
        s_sta_ip[0] = 0;
        schedule_sta_retry();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
        snprintf(s_sta_ip, sizeof(s_sta_ip), IPSTR, IP2STR(&ev->ip_info.ip));
        s_sta_up = true;
        s_retry = 0;
        if (s_sta_retry_timer) {
            esp_timer_stop(s_sta_retry_timer);
        }
        ESP_LOGI(TAG, "STA ip=%s", s_sta_ip);
    }
}

void tonerelay_wifi_start(void)
{
    const esp_timer_create_args_t timer_args = {
        .callback = sta_retry_cb,
        .name = "sta_retry",
    };
    ESP_ERROR_CHECK(esp_timer_create(&timer_args, &s_sta_retry_timer));

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_ap();
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi, NULL));

    char ssid[33] = {0};
    char pass[65] = {0};
    s_sta_configured = nvs_load_sta(ssid, sizeof(ssid), pass, sizeof(pass));
    if (s_sta_configured) {
        strncpy(s_sta_ssid, ssid, sizeof(s_sta_ssid) - 1);
    }
    memset(pass, 0, sizeof(pass));
    start_ap();
    ESP_ERROR_CHECK(esp_wifi_start());
    start_mdns();
}

int tonerelay_wifi_scan_json(char *buf, size_t len)
{
    if (!buf || len < 32) {
        return -1;
    }
    wifi_scan_config_t scan = {
        .show_hidden = false,
        .scan_type = WIFI_SCAN_TYPE_ACTIVE,
    };
    esp_err_t err = esp_wifi_scan_start(&scan, true);
    if (err != ESP_OK) {
        return snprintf(buf, len, "{\"ok\":false,\"op\":\"wifi_scan\",\"error\":\"scan failed\"}");
    }
    uint16_t n = 0;
    esp_wifi_scan_get_ap_num(&n);
    if (n > 24) {
        n = 24;
    }
    wifi_ap_record_t recs[24];
    uint16_t got = n;
    if (esp_wifi_scan_get_ap_records(&got, recs) != ESP_OK) {
        got = 0;
    }

    size_t o = 0;
    o += (size_t)snprintf(buf + o, len - o, "{\"ok\":true,\"op\":\"wifi_scan\",\"aps\":[");
    bool first = true;
    for (uint16_t i = 0; i < got && o + 80 < len; i++) {
        if (recs[i].ssid[0] == 0) {
            continue;
        }
        char ssid[65];
        json_escape(ssid, sizeof(ssid), (const char *)recs[i].ssid);
        const char *auth = recs[i].authmode == WIFI_AUTH_OPEN ? "open" : "psk";
        o += (size_t)snprintf(
            buf + o,
            len - o,
            "%s{\"ssid\":\"%s\",\"rssi\":%d,\"auth\":\"%s\"}",
            first ? "" : ",",
            ssid,
            recs[i].rssi,
            auth
        );
        first = false;
    }
    o += (size_t)snprintf(buf + o, len - o, "]}");
    return (int)o;
}

int tonerelay_wifi_join(const char *ssid, const char *pass)
{
    if (!ssid || !ssid[0] || strlen(ssid) > 32) {
        return -1;
    }
    const char *pw = pass ? pass : "";
    if (strlen(pw) > 64) {
        return -1;
    }
    if (nvs_save_sta(ssid, pw) != ESP_OK) {
        return -2;
    }
    s_sta_configured = true;
    s_sta_up = false;
    s_sta_ip[0] = 0;
    s_retry = 0;
    if (s_sta_retry_timer) {
        esp_timer_stop(s_sta_retry_timer);
    }
    start_sta(ssid, pw);
    return 0;
}

int tonerelay_wifi_ap_password(const char *pass)
{
    if (!pass) {
        return -1;
    }
    size_t n = strlen(pass);
    if (n < AP_PASS_MIN || n > AP_PASS_MAX) {
        return -1;
    }
    if (nvs_save_ap_pass(pass) != ESP_OK) {
        return -2;
    }
    s_ap_secured = true;
    start_ap();
    ESP_LOGI(TAG, "SoftAP password set; clients must reconnect");
    return 0;
}

int tonerelay_wifi_status_json(char *buf, size_t len)
{
    if (!buf || len < 32) {
        return -1;
    }
    wifi_ap_record_t rec = {0};
    if (s_sta_up && esp_wifi_sta_get_ap_info(&rec) == ESP_OK) {
        s_sta_rssi = rec.rssi;
    }
    char ssid[65];
    json_escape(ssid, sizeof(ssid), s_sta_ssid);
    return snprintf(
        buf,
        len,
        "{\"ok\":true,\"op\":\"wifi_status\",\"setup_required\":%s,\"sta\":%s,"
        "\"sta_configured\":%s,\"ap_secured\":%s,\"catalog_ready\":%s,"
        "\"ssid\":\"%s\",\"ip\":\"%s\",\"rssi\":%d,\"ap\":\"%s\","
        "\"ap_ip\":\"192.168.4.1\",\"mdns\":\"tonerelay.local\"}",
        tonerelay_wifi_setup_required() ? "true" : "false",
        s_sta_up ? "true" : "false",
        s_sta_configured ? "true" : "false",
        s_ap_secured ? "true" : "false",
        tonerelay_catalog_ready() ? "true" : "false",
        ssid,
        s_sta_ip,
        s_sta_rssi,
        AP_SSID
    );
}

int tonerelay_wifi_forget(void)
{
    nvs_erase_sta();
    s_sta_configured = false;
    s_sta_up = false;
    s_sta_ssid[0] = 0;
    s_sta_ip[0] = 0;
    s_retry = 0;
    if (s_sta_retry_timer) {
        esp_timer_stop(s_sta_retry_timer);
    }
    esp_wifi_disconnect();
    start_ap();
    ESP_LOGI(TAG, "STA credentials cleared");
    return 0;
}

bool tonerelay_wifi_setup_required(void)
{
    return !s_ap_secured || !tonerelay_catalog_ready();
}

bool tonerelay_wifi_ap_secured(void)
{
    return s_ap_secured;
}

bool tonerelay_wifi_sta_configured(void)
{
    return s_sta_configured;
}

bool tonerelay_wifi_sta_up(void)
{
    return s_sta_up;
}
