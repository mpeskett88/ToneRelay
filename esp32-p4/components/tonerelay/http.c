#include "tonerelay.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define TAG "tr_http"
#define CMD_MAX (512 * 1024)

typedef struct {
    const char *path;
    const uint8_t *data;
    size_t len;
} www_file_t;

extern const www_file_t www_files[];
extern const size_t www_files_count;

char *hxbridge_handle_json(const char *json, int json_len);
char *hxbridge_catalog_reload(void);
void hxbridge_free(char *p);

static const char *FALLBACK =
    "<!DOCTYPE html><html><head><meta charset=utf-8>"
    "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
    "<title>ToneRelay</title>"
    "<style>body{font-family:sans-serif;background:#05070a;color:#d7f0ea;margin:1.5rem}"
    "input,button{font:inherit;min-height:44px;width:100%;margin:.4rem 0;box-sizing:border-box}"
    "button{background:#00e8c4;border:0;font-weight:700}</style></head><body>"
    "<h1>ToneRelay</h1><p>Connect this board to Wi-Fi. Open network <b>ToneRelay</b>."
    " GUI files were not embedded; this form still joins a network.</p>"
    "<input id=s placeholder=SSID><input id=p type=password placeholder=Password>"
    "<button onclick=\"fetch('/api/cmd',{method:'POST',headers:{'Content-Type':'application/json'},"
    "body:JSON.stringify({op:'wifi_join',ssid:document.getElementById('s').value,"
    "password:document.getElementById('p').value})}).then(r=>r.json()).then(j=>{"
    "document.getElementById('m').textContent=JSON.stringify(j)})\">Join Wi-Fi</button>"
    "<pre id=m></pre></body></html>";

static const char *mime_for(const char *path)
{
    const char *dot = strrchr(path, '.');
    if (!dot) {
        return "application/octet-stream";
    }
    if (strcmp(dot, ".html") == 0) {
        return "text/html; charset=utf-8";
    }
    if (strcmp(dot, ".js") == 0) {
        return "text/javascript; charset=utf-8";
    }
    if (strcmp(dot, ".css") == 0) {
        return "text/css; charset=utf-8";
    }
    if (strcmp(dot, ".json") == 0) {
        return "application/json";
    }
    if (strcmp(dot, ".svg") == 0) {
        return "image/svg+xml";
    }
    if (strcmp(dot, ".png") == 0) {
        return "image/png";
    }
    if (strcmp(dot, ".woff2") == 0) {
        return "font/woff2";
    }
    if (strcmp(dot, ".webmanifest") == 0) {
        return "application/manifest+json";
    }
    return "application/octet-stream";
}

static const www_file_t *find_www(const char *uri)
{
    char buf[160];
    const char *path = uri;
    const char *q = strchr(uri, '?');
    if (q) {
        size_t n = (size_t)(q - uri);
        if (n >= sizeof(buf)) {
            n = sizeof(buf) - 1;
        }
        memcpy(buf, uri, n);
        buf[n] = 0;
        path = buf;
    }
    if (strcmp(path, "/") == 0) {
        path = "/index.html";
    }
    /* iOS Add to Home Screen probes several names, often with HEAD first. */
    if (strcmp(path, "/favicon.ico") == 0 ||
        strcmp(path, "/apple-touch-icon-precomposed.png") == 0 ||
        strncmp(path, "/apple-touch-icon-", 18) == 0) {
        path = "/apple-touch-icon.png";
    }
    for (size_t i = 0; i < www_files_count; i++) {
        if (strcmp(www_files[i].path, path) == 0) {
            return &www_files[i];
        }
    }
    return NULL;
}

static esp_err_t send_json(httpd_req_t *req, const char *cmd)
{
    char *out = hxbridge_handle_json(cmd, (int)strlen(cmd));
    if (!out) {
        httpd_resp_set_status(req, "500 Internal Server Error");
        return httpd_resp_sendstr(req, "{\"ok\":false,\"error\":\"no reply\"}");
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t err = httpd_resp_sendstr(req, out);
    hxbridge_free(out);
    return err;
}

static esp_err_t api_info(httpd_req_t *req)
{
    return send_json(req, "{\"op\":\"info\"}");
}

/* USB counters only. Does not take the Rust Bridge mutex, so it still
 * answers while get_state / list_presets hold the session. */
static esp_err_t api_usb(httpd_req_t *req)
{
    uint32_t drops = 0;
    uint32_t in_ok = 0;
    uint32_t tx_ok = 0;
    uint32_t parked = 0;
    uint32_t queued = 0;
    int32_t last_n = 0;
    int32_t last_st = 0;
    helix_usb_stats(&drops, &in_ok, &tx_ok, &last_n, &last_st, &parked, &queued);
    char buf[384];
    int n = snprintf(
        buf,
        sizeof(buf),
        "{\"ok\":true,\"present\":%s,\"claimed\":%s,\"pid\":\"%04x\",\"enum_gen\":%u,"
        "\"drops\":%u,\"in_ok\":%u,\"tx_ok\":%u,\"parked\":%u,\"queued\":%u,"
        "\"last_in_n\":%d,\"last_in_status\":%d}",
        helix_usb_present() ? "true" : "false",
        helix_usb_claimed() ? "true" : "false",
        (unsigned)helix_usb_pid(),
        (unsigned)helix_usb_enum_gen(),
        (unsigned)drops,
        (unsigned)in_ok,
        (unsigned)tx_ok,
        (unsigned)parked,
        (unsigned)queued,
        (int)last_n,
        (int)last_st
    );
    if (n < 0 || n >= (int)sizeof(buf)) {
        httpd_resp_set_status(req, "500 Internal Server Error");
        return httpd_resp_sendstr(req, "{\"ok\":false}");
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, buf, n);
}

static esp_err_t api_cmd(httpd_req_t *req)
{
    int len = req->content_len;
    if (len <= 0 || len > CMD_MAX) {
        httpd_resp_set_status(req, "400 Bad Request");
        return httpd_resp_sendstr(req, "{\"ok\":false,\"error\":\"bad body\"}");
    }
    char *body = heap_caps_malloc((size_t)len + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!body) {
        body = malloc((size_t)len + 1);
    }
    if (!body) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "oom");
    }
    int got = 0;
    while (got < len) {
        int n = httpd_req_recv(req, body + got, (size_t)(len - got));
        if (n <= 0) {
            free(body);
            return ESP_FAIL;
        }
        got += n;
    }
    body[len] = 0;
    char *out = hxbridge_handle_json(body, len);
    free(body);
    if (!out) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no reply");
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t err = httpd_resp_sendstr(req, out);
    hxbridge_free(out);
    return err;
}

static const char *catalog_filename(const char *uri)
{
    const char *prefix = "/api/catalog/";
    size_t n = strlen(prefix);
    if (strncmp(uri, prefix, n) != 0) {
        return NULL;
    }
    const char *name = uri + n;
    return tonerelay_catalog_name_ok(name);
}

static esp_err_t api_catalog_get(httpd_req_t *req)
{
    char buf[1536];
    int n = tonerelay_catalog_status_json(buf, sizeof(buf));
    if (n < 0 || n >= (int)sizeof(buf)) {
        httpd_resp_set_status(req, "500 Internal Server Error");
        return httpd_resp_sendstr(req, "{\"ok\":false}");
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, buf, n);
}

static esp_err_t api_catalog_put(httpd_req_t *req)
{
    const char *name = catalog_filename(req->uri);
    if (!name) {
        httpd_resp_set_status(req, "400 Bad Request");
        return httpd_resp_sendstr(req, "{\"ok\":false,\"error\":\"unknown catalog file\"}");
    }
    int len = req->content_len;
    if (len <= 0 || len > 6 * 1024 * 1024) {
        httpd_resp_set_status(req, "400 Bad Request");
        return httpd_resp_sendstr(req, "{\"ok\":false,\"error\":\"bad size\"}");
    }
    FILE *f = tonerelay_catalog_open_put(name);
    if (!f) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "open failed");
    }
    char chunk[4096];
    int got = 0;
    while (got < len) {
        int want = (int)sizeof(chunk);
        if (want > len - got) {
            want = len - got;
        }
        int n = httpd_req_recv(req, chunk, (size_t)want);
        if (n <= 0) {
            fclose(f);
            return ESP_FAIL;
        }
        if (fwrite(chunk, 1, (size_t)n, f) != (size_t)n) {
            fclose(f);
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "write failed");
        }
        got += n;
    }
    fclose(f);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    char out[160];
    int n = snprintf(out, sizeof(out), "{\"ok\":true,\"name\":\"%s\",\"bytes\":%d}", name, got);
    return httpd_resp_send(req, out, n);
}

static esp_err_t api_catalog_commit(httpd_req_t *req)
{
    (void)req;
    char *out = hxbridge_catalog_reload();
    if (!out) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no reply");
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t err = httpd_resp_sendstr(req, out);
    hxbridge_free(out);
    return err;
}

static esp_err_t static_get(httpd_req_t *req)
{
    const www_file_t *f = find_www(req->uri);
    if (f) {
        httpd_resp_set_type(req, mime_for(f->path));
        if (strcmp(f->path, "/index.html") == 0) {
            httpd_resp_set_hdr(req, "Cache-Control", "no-store");
        } else if (strcmp(f->path, "/apple-touch-icon.png") == 0 ||
                   strncmp(f->path, "/icon-", 6) == 0) {
            httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=86400");
        } else {
            httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=31536000");
        }
        /* HEAD: same Content-Length, no body. iOS probes icons this way. */
        if (req->method == HTTP_HEAD) {
            return httpd_resp_send(req, NULL, (ssize_t)f->len);
        }
        return httpd_resp_send(req, (const char *)f->data, (ssize_t)f->len);
    }
    if (strcmp(req->uri, "/") == 0 || strcmp(req->uri, "/index.html") == 0) {
        httpd_resp_set_type(req, "text/html; charset=utf-8");
        httpd_resp_set_hdr(req, "Cache-Control", "no-store");
        if (req->method == HTTP_HEAD) {
            return httpd_resp_send(req, NULL, (ssize_t)strlen(FALLBACK));
        }
        return httpd_resp_sendstr(req, FALLBACK);
    }
    httpd_resp_set_status(req, "404 Not Found");
    if (req->method == HTTP_HEAD) {
        return httpd_resp_send(req, NULL, 0);
    }
    return httpd_resp_sendstr(req, "not found");
}

/* IDF's httpd_ws_send_frame does one send() for the whole payload and treats a
 * short write as success. get_state JSON is tens to hundreds of KB, so the
 * browser never sees a complete frame and waits until "timeout waiting for
 * get_state". HTTP responses already loop via httpd_send_all; WS did not. */
#define WS_CHUNK 2048

static esp_err_t sock_send_all(httpd_req_t *req, const uint8_t *buf, size_t len)
{
    int fd = httpd_req_to_sockfd(req);
    while (len > 0) {
        int n = httpd_socket_send(req->handle, fd, (const char *)buf, len, 0);
        if (n < 0) {
            return ESP_FAIL;
        }
        if (n == 0) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        buf += (size_t)n;
        len -= (size_t)n;
    }
    return ESP_OK;
}

static esp_err_t ws_send_text(httpd_req_t *req, const char *text)
{
    size_t total = strlen(text);
    size_t off = 0;
    if (total == 0) {
        uint8_t hdr[2] = {0x81, 0x00};
        return sock_send_all(req, hdr, 2);
    }
    while (off < total) {
        size_t n = total - off;
        if (n > WS_CHUNK) {
            n = WS_CHUNK;
        }
        int first = off == 0;
        int last = off + n >= total;
        uint8_t hdr[4];
        size_t hlen;
        hdr[0] = (uint8_t)((last ? 0x80U : 0) | (first ? 0x01U : 0x00U));
        if (n <= 125) {
            hdr[1] = (uint8_t)n;
            hlen = 2;
        } else {
            hdr[1] = 126;
            hdr[2] = (uint8_t)(n >> 8);
            hdr[3] = (uint8_t)n;
            hlen = 4;
        }
        if (sock_send_all(req, hdr, hlen) != ESP_OK) {
            return ESP_FAIL;
        }
        if (sock_send_all(req, (const uint8_t *)text + off, n) != ESP_OK) {
            return ESP_FAIL;
        }
        off += n;
    }
    return ESP_OK;
}

static esp_err_t ws_handler(httpd_req_t *req)
{
    if (req->method == HTTP_GET) {
        return ESP_OK;
    }
    httpd_ws_frame_t frame = {0};
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) {
        return err;
    }
    if (frame.len == 0 || frame.len > CMD_MAX) {
        return ESP_OK;
    }
    uint8_t *buf = heap_caps_malloc(frame.len + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!buf) {
        buf = malloc(frame.len + 1);
    }
    if (!buf) {
        return ESP_ERR_NO_MEM;
    }
    frame.payload = buf;
    err = httpd_ws_recv_frame(req, &frame, frame.len);
    if (err != ESP_OK) {
        free(buf);
        return err;
    }
    buf[frame.len] = 0;
    {
        const char *p = strstr((char *)buf, "\"op\"");
        if (p && (p = strchr(p + 4, '"')) != NULL) {
            p++;
            const char *end = strchr(p, '"');
            if (end && end - p > 0 && end - p <= 32) {
                ESP_LOGI(TAG, "ws op=%.*s", (int)(end - p), p);
            }
        }
    }
    char *out = hxbridge_handle_json((const char *)buf, (int)frame.len);
    free(buf);
    if (!out) {
        return ESP_FAIL;
    }
    size_t out_len = strlen(out);
    if (out_len > 4096) {
        ESP_LOGI(TAG, "ws reply %u bytes", (unsigned)out_len);
    }
    err = ws_send_text(req, out);
    hxbridge_free(out);
    return err;
}

void tonerelay_http_start(void)
{
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.stack_size = 24576;
    cfg.task_priority = 16;
    cfg.max_uri_handlers = 16;
    /* Default is 7 sockets with 3 reserved: only 4 HTTP clients. LRU purge
     * then drops the WebSocket when the SPA fetches JS/CSS/fonts. */
    cfg.lru_purge_enable = false;
    cfg.max_open_sockets = 10;
    cfg.recv_wait_timeout = 60;
    cfg.send_wait_timeout = 60;
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    cfg.server_port = 80;
    httpd_handle_t srv = NULL;
    if (httpd_start(&srv, &cfg) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        return;
    }

    const httpd_uri_t info = {
        .uri = "/api/info",
        .method = HTTP_GET,
        .handler = api_info,
    };
    const httpd_uri_t usb = {
        .uri = "/api/usb",
        .method = HTTP_GET,
        .handler = api_usb,
    };
    const httpd_uri_t cmd = {
        .uri = "/api/cmd",
        .method = HTTP_POST,
        .handler = api_cmd,
    };
    const httpd_uri_t cat_get = {
        .uri = "/api/catalog",
        .method = HTTP_GET,
        .handler = api_catalog_get,
    };
    const httpd_uri_t cat_put = {
        .uri = "/api/catalog/*",
        .method = HTTP_PUT,
        .handler = api_catalog_put,
    };
    const httpd_uri_t cat_commit = {
        .uri = "/api/catalog/commit",
        .method = HTTP_POST,
        .handler = api_catalog_commit,
    };
    const httpd_uri_t ws = {
        .uri = "/ws",
        .method = HTTP_GET,
        .handler = ws_handler,
        .is_websocket = true,
    };
    const httpd_uri_t any = {
        .uri = "/*",
        .method = HTTP_GET,
        .handler = static_get,
    };
    const httpd_uri_t any_head = {
        .uri = "/*",
        .method = HTTP_HEAD,
        .handler = static_get,
    };
    httpd_register_uri_handler(srv, &info);
    httpd_register_uri_handler(srv, &usb);
    httpd_register_uri_handler(srv, &cmd);
    httpd_register_uri_handler(srv, &cat_get);
    httpd_register_uri_handler(srv, &cat_commit);
    httpd_register_uri_handler(srv, &cat_put);
    httpd_register_uri_handler(srv, &ws);
    httpd_register_uri_handler(srv, &any);
    httpd_register_uri_handler(srv, &any_head);
    ESP_LOGI(TAG, "HTTP on :80 (%u web files)", (unsigned)www_files_count);
}
