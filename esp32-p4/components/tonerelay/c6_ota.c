#include "tonerelay.h"

#include <stdint.h>
#include <string.h>

#include "esp_hosted.h"
#include "esp_hosted_api_types.h"
#include "esp_hosted_ota.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define TAG "tr_c6"
#define CHUNK 1400

#if defined(TONERELAY_HAS_SLAVE_FW)
extern const uint8_t network_adapter_bin_start[] asm("_binary_network_adapter_bin_start");
extern const uint8_t network_adapter_bin_end[] asm("_binary_network_adapter_bin_end");
#endif

void tonerelay_c6_sync(void)
{
    esp_hosted_coprocessor_fwver_t ver = {0};
    int rc = esp_hosted_get_coprocessor_fwversion(&ver);
    bool need_ota = true;
    if (rc == ESP_OK) {
        ESP_LOGI(TAG, "C6 firmware %lu.%lu.%lu",
                 (unsigned long)ver.major1, (unsigned long)ver.minor1, (unsigned long)ver.patch1);
        need_ota = (ver.major1 == 0 && ver.minor1 == 0 && ver.patch1 == 0);
    } else {
        ESP_LOGW(TAG, "C6 version unread (%d); treating as 0.0.0", rc);
    }
    if (!need_ota) {
        return;
    }

#if !defined(TONERELAY_HAS_SLAVE_FW)
    ESP_LOGW(TAG, "C6 is 0.0.0 but no network_adapter.bin was built in");
    return;
#else
    const uint8_t *fw = network_adapter_bin_start;
    size_t len = (size_t)(network_adapter_bin_end - network_adapter_bin_start);
    if (len < 256) {
        ESP_LOGE(TAG, "embedded C6 image too small (%u)", (unsigned)len);
        return;
    }
    ESP_LOGW(TAG, "C6 reports 0.0.0; OTAing %u-byte hosted slave image", (unsigned)len);

    esp_err_t err = esp_hosted_slave_ota_begin();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "C6 OTA begin failed: %s", esp_err_to_name(err));
        return;
    }
    size_t off = 0;
    uint8_t chunk[CHUNK];
    while (off < len) {
        size_t n = len - off;
        if (n > CHUNK) {
            n = CHUNK;
        }
        memcpy(chunk, fw + off, n);
        err = esp_hosted_slave_ota_write(chunk, (uint32_t)n);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "C6 OTA write failed at %u: %s", (unsigned)off, esp_err_to_name(err));
            (void)esp_hosted_slave_ota_end();
            return;
        }
        off += n;
    }
    err = esp_hosted_slave_ota_end();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "C6 OTA end failed: %s", esp_err_to_name(err));
        return;
    }
    err = esp_hosted_slave_ota_activate();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "C6 OTA activate: %s (ok on old slave)", esp_err_to_name(err));
    }
    ESP_LOGI(TAG, "C6 OTA done; restarting host");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
#endif
}
