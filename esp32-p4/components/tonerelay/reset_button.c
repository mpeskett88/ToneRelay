/*
 * Factory reset by long press: hold the board's BOOT button for 5 seconds while the box is running and it forgets its Wi-Fi
 * networks, hotspot password, token and (with Bluetooth MIDI built in) every Bluetooth pairing, then restarts and raises its open setup network, as a new box does. The catalog on flash is kept.
 * A short press does nothing, except that it confirms an open pairing window (relay.c).
 *
 * BOOT is the chip's download-strap pin (GPIO35 on the ESP32-P4). Once the application runs it is an ordinary input. Holding
 * it while the board powers up or resets selects download mode instead, so the press has to start after the box has booted.
 */
#include "tonerelay.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define TAG "tr_reset"
#ifndef TONERELAY_RESET_GPIO
#define TONERELAY_RESET_GPIO GPIO_NUM_35
#endif
#define HOLD_US (5LL * 1000 * 1000)
#define POLL_MS 50
#define MIN_PRESS_US (80LL * 1000) /* a shorter contact is bounce, not a press */

static void reset_task(void *arg)
{
    (void)arg;
    const gpio_config_t io = {
        .pin_bit_mask = 1ULL << TONERELAY_RESET_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&io);
    ESP_LOGI(TAG, "reset button on GPIO%d, level %d (1 = released); hold it 5 s to forget the Wi-Fi network",
             (int)TONERELAY_RESET_GPIO, gpio_get_level(TONERELAY_RESET_GPIO));

    int64_t down_at = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
        if (gpio_get_level(TONERELAY_RESET_GPIO) != 0) {
            if (down_at != 0) {
                int64_t held = esp_timer_get_time() - down_at;
                if (held >= MIN_PRESS_US && held < HOLD_US) {
                    tonerelay_relay_pair_press(); /* a short press confirms an open pairing window */
                }
            }
            down_at = 0;
            continue;
        }
        int64_t now = esp_timer_get_time();
        if (down_at == 0) {
            down_at = now;
            ESP_LOGI(TAG, "button down");
        } else if (now - down_at >= HOLD_US) {
            ESP_LOGW(TAG, "held for 5 s: factory reset");
            tonerelay_wifi_factory_reset();
            tonerelay_midi_ble_forget_bonds();
            vTaskDelay(pdMS_TO_TICKS(300));
            esp_restart();
        }
    }
}

void tonerelay_reset_button_start(void)
{
    xTaskCreate(reset_task, "reset_btn", 3072, NULL, 3, NULL);
}
