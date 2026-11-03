#pragma once

#include <stddef.h>
#include <stdint.h>

/*
 * BLE MIDI packets (MIDI over Bluetooth LE specification 1.0) to a plain MIDI byte stream.
 *
 * A packet is a header byte (bit 7 set, bit 6 clear, then the high timestamp bits) followed by messages. Every status byte is preceded
 * by a timestamp byte (bit 7 set), as is a SysEx end byte; data bytes of a running status may follow a timestamp too. A packet that
 * continues a SysEx has data bytes straight after the header.
 *
 * Writes the MIDI bytes of `pkt` to `out`, without the header and the timestamps, and returns how many. That is never more than
 * len - 1, so a buffer of len bytes always fits. Returns 0 for a packet that is not BLE MIDI.
 */
size_t blemidi_parse(const uint8_t *pkt, size_t len, uint8_t *out, size_t cap);

/*
 * MIDI-CI Discovery (a universal SysEx: F0 7E <device> 0D 70 ...). Apple's MIDI stack sends one when a Bluetooth MIDI device connects
 * and holds data back, or gives up, until it is answered. `msg` is the SysEx as blemidi_parse() returns it. If it is a complete
 * Discovery inquiry, writes the Discovery Reply (a device with no MIDI-CI features, so nothing more is negotiated) to `out` and
 * returns its length; returns 0 for anything else. `muid` is this device's 28-bit id as four 7-bit bytes (not 7F 7F 7F 7F).
 */
size_t blemidi_ci_discovery_reply(const uint8_t *msg, size_t len, const uint8_t muid[4], uint8_t *out, size_t cap);

/* One SysEx message (F0 ... F7) as a BLE MIDI packet: the header, a timestamp before F0 and one before F7. `ms` is any millisecond
 * counter. Returns the packet length, or 0 if `cap` is too small. */
size_t blemidi_encode_sysex(const uint8_t *msg, size_t len, uint32_t ms, uint8_t *out, size_t cap);

/*
 * MIDI bytes to USB-MIDI event packets (USB MIDI class 1.0: four bytes each, cable number 0). The encoder keeps what it needs between
 * calls (running status, a SysEx still open), so feed it the stream in any pieces. It writes whole packets to `out`, up to `cap` bytes
 * (4 * len is always enough), and returns how many bytes it wrote.
 */
typedef struct {
    uint8_t status;   /* running status, 0 if none */
    uint8_t need;     /* data bytes the status takes */
    uint8_t have;
    uint8_t data[2];
    uint8_t sysex;    /* inside F0 ... F7 */
    uint8_t npend;
    uint8_t pend[3];
} usbmidi_enc_t;

size_t usbmidi_encode(usbmidi_enc_t *e, const uint8_t *in, size_t len, uint8_t *out, size_t cap);
