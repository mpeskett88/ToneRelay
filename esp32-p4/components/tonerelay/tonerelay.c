#include "tonerelay.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#define TAG "tonerelay"

static void parse_wifi_line(char *line)
{
    while (*line == ' ' || *line == '\t') {
        line++;
    }
    size_t n = strlen(line);
    while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) {
        line[--n] = 0;
    }
    if (strncmp(line, "wifi ", 5) != 0) {
        if (strcmp(line, "wifi-forget") == 0) {
            tonerelay_wifi_forget();
            printf("wifi credentials cleared\n");
        }
        return;
    }
    char *rest = line + 5;
    char ssid[33] = {0};
    char pass[65] = {0};
    if (*rest == '"') {
        rest++;
        char *end = strchr(rest, '"');
        if (!end) {
            printf("wifi \"ssid\" password\n");
            return;
        }
        size_t sl = (size_t)(end - rest);
        if (sl >= sizeof(ssid)) {
            sl = sizeof(ssid) - 1;
        }
        memcpy(ssid, rest, sl);
        rest = end + 1;
        while (*rest == ' ') {
            rest++;
        }
        strncpy(pass, rest, sizeof(pass) - 1);
    } else {
        char *sp = strrchr(rest, ' ');
        if (!sp) {
            printf("wifi SSID password\n");
            return;
        }
        *sp = 0;
        strncpy(ssid, rest, sizeof(ssid) - 1);
        strncpy(pass, sp + 1, sizeof(pass) - 1);
    }
    if (!ssid[0]) {
        printf("wifi SSID password\n");
        return;
    }
    printf("joining ssid=%s\n", ssid);
    int rc = tonerelay_wifi_join(ssid, pass);
    memset(pass, 0, sizeof(pass));
    if (rc != 0) {
        printf("wifi join failed (%d)\n", rc);
        return;
    }
    for (int i = 0; i < 40; i++) {
        if (tonerelay_wifi_sta_up()) {
            printf("wifi joined\n");
            return;
        }
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    printf("wifi join started; waiting for IP\n");
}

static void console_task(void *arg)
{
    (void)arg;
    char line[192];
    printf("ToneRelay UART: wifi SSID password   |   wifi-forget\n");
    while (true) {
        if (!fgets(line, sizeof(line), stdin)) {
            clearerr(stdin);
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        parse_wifi_line(line);
        memset(line, 0, sizeof(line));
    }
}

void tonerelay_start(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    helix_usb_start();
    tonerelay_catalog_start();
    /* Hosted SDIO is prio 23. Give the USB host task time to debounce/enumerate
     * the already-plugged Helix before C6 traffic starts. */
    vTaskDelay(pdMS_TO_TICKS(400));
    tonerelay_wifi_start();
    tonerelay_c6_sync();
    tonerelay_http_start();
    /* C6 2.12.13 VHCI does not answer HCI reset; NimBLE then retries every 2s
     * and starves httpd. Wi-Fi GUI still works. Re-enable when C6 HCI works. */
    ESP_LOGW(TAG, "BLE skipped (C6 HCI unresponsive)");
    xTaskCreate(console_task, "console", 4096, NULL, 1, NULL);
    ESP_LOGI(TAG, "ToneRelay P4 started");
}
