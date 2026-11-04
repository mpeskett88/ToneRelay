#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Start USB host, SoftAP/STA, HTTP, BLE, and the UART wifi console. */
void tonerelay_start(void);

/*
 * USB host Wire for hx-usb. Claim/release/claim interface 0, posted IN.
 * Return 0 on success.
 * helix_usb_recv: -1 timed out (must print as "read timed out"), -2 not open, -3 USB error.
 */
int helix_usb_start(void);
int helix_usb_open(uint16_t *pid_out);
int helix_usb_close(void);
int helix_usb_send(const uint8_t *data, size_t len, uint32_t timeout_ms);
int helix_usb_recv(uint8_t *buf, size_t buf_len, size_t *out_len, uint32_t timeout_ms);
bool helix_usb_present(void);
bool helix_usb_claimed(void);
uint16_t helix_usb_pid(void);
uint32_t helix_usb_enum_gen(void);
void helix_usb_stats(
    uint32_t *drops,
    uint32_t *in_ok,
    uint32_t *tx_ok,
    int32_t *last_n,
    int32_t *last_st,
    uint32_t *parked,
    uint32_t *queued
);
const char *helix_usb_last_error(void);
/* Product and serial string descriptors of the open pedal (ASCII, '?' for other characters). 0 on success. */
/* The product and serial strings read when the pedal enumerated (valid without a session). */
void helix_usb_cached_strings(char *product, size_t plen, char *serial, size_t slen);
int helix_usb_strings(char *product, size_t plen, char *serial, size_t slen);

/* A build's identity: the names the box shows the network (Wi-Fi setup network, host name, mDNS), its relay-only default and an optional
 * front page of its own. It is chosen when the firmware is built (see profiles/README.md): `profiles/tonerelay` is the default, and a
 * product built on ToneRelay supplies its own folder through TONERELAY_PROFILE_DIR. */
typedef struct {
    const char *name;      /* "tonerelay", or the product's name */
    const char *hostname;  /* mDNS host name, without .local */
    const char *instance;  /* mDNS instance name (the box id is added when with_id) */
    const char *service;   /* an extra mDNS service type such as "_myproduct" (the contract's "_tonerelay" is always advertised) */
    const char *ap_prefix; /* Wi-Fi setup network name (the box id is added when with_id) */
    bool with_id;
    bool setup_ap_only;    /* the setup network is up only while the box has no Wi-Fi of its own to use */
    bool relay_only_default; /* relay-only when nothing has been saved */
    /* The front page (GET /), or NULL for the stock ToneRelay page. Returns the HTML and sets its length. */
    const char *(*setup_page)(size_t *len);
} tonerelay_profile_t;
extern const tonerelay_profile_t TONERELAY_PROFILE; /* defined by the profile folder's profile.c */
const tonerelay_profile_t *tonerelay_profile(void);
void tonerelay_profile_id(char *out, size_t cap);
void tonerelay_profile_ap_ssid(char *out, size_t cap);
void tonerelay_profile_instance(char *out, size_t cap);

/* Version of the raw relay contract (docs/raw-relay-protocol.md): sent in the /raw hello and advertised over mDNS. */
#define TONERELAY_RELAY_PROTO 0

void tonerelay_wifi_start(void);
void tonerelay_c6_sync(void);
int tonerelay_wifi_scan_json(char *buf, size_t len);
int tonerelay_wifi_join(const char *ssid, const char *pass);
int tonerelay_wifi_ap_password(const char *pass);
int tonerelay_wifi_status_json(char *buf, size_t len);
int tonerelay_wifi_forget(void);
int tonerelay_wifi_forget_one(const char *ssid); /* 0 forgotten, 1 not saved, negative on error; forgetting the last one is a full forget */
int tonerelay_wifi_factory_reset(void); /* forget the Wi-Fi network and the hotspot password (the caller restarts) */
void tonerelay_reset_button_start(void); /* hold BOOT for 5 s to run the factory reset */
bool tonerelay_wifi_setup_required(void);
bool tonerelay_wifi_ap_secured(void);
bool tonerelay_wifi_sta_configured(void);
bool tonerelay_wifi_sta_up(void);
bool tonerelay_ble_up(void);

void tonerelay_catalog_start(void);
bool tonerelay_catalog_ready(void);
const char *tonerelay_catalog_name_ok(const char *name);
int tonerelay_catalog_put(const char *name, const uint8_t *data, size_t len);
FILE *tonerelay_catalog_open_put(const char *name);
int tonerelay_catalog_status_json(char *buf, size_t len);

void tonerelay_http_start(void);

/* Raw relay (docs/raw-relay-protocol.md). While relay-only is on, the box opens no session of its own. */
void tonerelay_relay_start(void);
bool tonerelay_relay_only(void);
void tonerelay_relay_pair_press(void); /* a short press of BOOT: confirms an open pairing window (see relay.c) */
void tonerelay_relay_token(char *out, size_t cap); /* the box's token (32 hex characters); see relay.c */
void tonerelay_ble_start(void);

/* BLE MIDI input (CONFIG_TONERELAY_BLE_MIDI; without it these do nothing). MIDI bytes written by a phone or DAW reach the sink, which
 * logs them until a destination is set. */
void tonerelay_midi_ble_start(void);
bool tonerelay_midi_ble_up(void);
/* One USB-MIDI event packet from the pedal, sent on as a BLE MIDI notification to the connected phone, if one has subscribed. */
void tonerelay_midi_ble_notify_usb(const uint8_t pkt[4]);
void tonerelay_midi_set_sink(void (*sink)(const uint8_t *bytes, size_t n));
void tonerelay_midi_ble_forget_bonds(void); /* forgets every paired phone and tablet (the factory reset calls it) */

/* MIDI to the pedal over its USB MIDI interface (usb_midi.c). Start it after helix_usb_start(); it needs no Helrig session. */
void tonerelay_usb_midi_start(void);
bool tonerelay_usb_midi_ready(void);
void tonerelay_usb_midi_send(const uint8_t *bytes, size_t n);

#ifdef __cplusplus
}
#endif
