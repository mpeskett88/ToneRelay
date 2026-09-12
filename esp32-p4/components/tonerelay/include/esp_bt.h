#pragma once
/* ESP32-P4 has no onboard Bluetooth controller. NimBLE runs host-only and
 * talks to the C6 through ESP-Hosted. esp-idf-sys still includes this header
 * whenever CONFIG_BT_ENABLED is set. */
