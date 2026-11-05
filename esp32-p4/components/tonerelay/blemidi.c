#include "blemidi.h"

#include <stdbool.h>

size_t blemidi_parse(const uint8_t *pkt, size_t len, uint8_t *out, size_t cap)
{
    if (len < 2 || (pkt[0] & 0xC0) != 0x80) {
        return 0;
    }
    size_t n = 0;
    bool after_timestamp = false;
    for (size_t i = 1; i < len; i++) {
        uint8_t b = pkt[i];
        if (b & 0x80) {
            /* A byte with bit 7 set is a timestamp unless a timestamp has just come: then it is the status byte. */
            if (!after_timestamp) {
                after_timestamp = true;
                continue;
            }
        }
        after_timestamp = false;
        if (n < cap) {
            out[n++] = b;
        }
    }
    return n;
}

size_t blemidi_ci_discovery_reply(const uint8_t *msg, size_t len, const uint8_t muid[4], uint8_t *out, size_t cap)
{
    /* F0 7E <device> 0D 70 <version> <source MUID x4> <destination MUID x4> ... F7 */
    if (len < 15 || cap < 33 || msg[0] != 0xF0 || msg[1] != 0x7E || msg[3] != 0x0D || msg[4] != 0x70 || msg[len - 1] != 0xF7) {
        return 0;
    }
    const uint8_t reply[] = {
        0xF0, 0x7E, 0x7F, 0x0D, 0x71, 0x02,
        muid[0], muid[1], muid[2], muid[3],     /* our MUID */
        msg[6], msg[7], msg[8], msg[9],         /* the inquirer's MUID */
        0x7D, 0x00, 0x00,                       /* manufacturer: the non-commercial id */
        0x00, 0x00,                             /* family */
        0x00, 0x00,                             /* model */
        0x00, 0x00, 0x00, 0x00,                 /* software revision */
        0x00,                                   /* no MIDI-CI categories: discovery only */
        0x00, 0x04, 0x00, 0x00,                 /* largest SysEx we take: 512 bytes (7-bit, least significant first) */
        0x00,                                   /* output path id */
        0x00,                                   /* function block */
        0xF7,
    };
    for (size_t i = 0; i < sizeof(reply); i++) {
        out[i] = reply[i];
    }
    return sizeof(reply);
}

size_t blemidi_encode_sysex(const uint8_t *msg, size_t len, uint32_t ms, uint8_t *out, size_t cap)
{
    if (len < 2 || cap < len + 3 || msg[0] != 0xF0 || msg[len - 1] != 0xF7) {
        return 0;
    }
    uint8_t high = 0x80 | ((ms >> 7) & 0x3F);
    uint8_t low = 0x80 | (ms & 0x7F);
    size_t n = 0;
    out[n++] = high;
    out[n++] = low;
    for (size_t i = 0; i < len - 1; i++) {
        out[n++] = msg[i];
    }
    out[n++] = low; /* the timestamp before F7 */
    out[n++] = msg[len - 1];
    return n;
}

#define USBMIDI_EMIT(c, b0, b1, b2)       \
    do {                                  \
        if (w + 4 <= cap) {               \
            out[w] = (uint8_t)(c);        \
            out[w + 1] = (uint8_t)(b0);   \
            out[w + 2] = (uint8_t)(b1);   \
            out[w + 3] = (uint8_t)(b2);   \
            w += 4;                       \
        }                                 \
    } while (0)

size_t usbmidi_encode(usbmidi_enc_t *e, const uint8_t *in, size_t len, uint8_t *out, size_t cap)
{
    size_t w = 0;
    for (size_t i = 0; i < len; i++) {
        uint8_t b = in[i];
        if (b >= 0xF8) { /* real-time messages go straight through, even inside another message */
            USBMIDI_EMIT(0x0F, b, 0, 0);
            continue;
        }
        if (b & 0x80) {
            if (b == 0xF7) {
                if (e->sysex) {
                    e->pend[e->npend++] = b;
                    USBMIDI_EMIT(0x04 + e->npend, e->pend[0], e->npend > 1 ? e->pend[1] : 0, e->npend > 2 ? e->pend[2] : 0);
                }
                e->sysex = 0;
                e->npend = 0;
                e->status = 0;
                e->have = 0;
                continue;
            }
            e->sysex = 0; /* any other status byte ends a SysEx that was never closed */
            e->npend = 0;
            e->have = 0;
            if (b == 0xF0) {
                e->sysex = 1;
                e->pend[e->npend++] = b;
                e->status = 0;
            } else if (b < 0xF0) {
                e->status = b;
                e->need = (b >= 0xC0 && b < 0xE0) ? 1 : 2;
            } else if (b == 0xF1 || b == 0xF3) {
                e->status = b;
                e->need = 1;
            } else if (b == 0xF2) {
                e->status = b;
                e->need = 2;
            } else {
                if (b == 0xF6) {
                    USBMIDI_EMIT(0x05, b, 0, 0);
                }
                e->status = 0;
            }
            continue;
        }
        if (e->sysex) {
            e->pend[e->npend++] = b;
            if (e->npend == 3) {
                USBMIDI_EMIT(0x04, e->pend[0], e->pend[1], e->pend[2]);
                e->npend = 0;
            }
            continue;
        }
        if (e->status == 0) {
            continue; /* a data byte with no status to go with */
        }
        e->data[e->have++] = b;
        if (e->have == e->need) {
            uint8_t cin = e->status >= 0xF0 ? (e->need == 1 ? 0x02 : 0x03) : (uint8_t)(e->status >> 4);
            USBMIDI_EMIT(cin, e->status, e->data[0], e->need == 2 ? e->data[1] : 0);
            e->have = 0;
            if (e->status >= 0xF0) {
                e->status = 0; /* system common messages have no running status */
            }
        }
    }
    return w;
}

size_t blemidi_encode_usb_events(const uint8_t *pkts, size_t len, uint32_t ms, uint8_t *out, size_t cap, size_t *used)
{
    size_t w = 0, i = 0;
    for (; i + 4 <= len; i += 4) {
        const uint8_t *p = pkts + i;
        uint8_t cin = p[0] & 0x0F;
        if (cin < 0x8 || cin > 0xE || (p[1] & 0xF0) != (uint8_t)(cin << 4)) {
            continue; /* not a channel message: not passed on */
        }
        size_t body = (cin == 0xC || cin == 0xD) ? 2 : 3;
        size_t need = (w == 0 ? 1 : 0) + 1 + body;
        if (w + need > cap) {
            break; /* the rest goes in the next packet */
        }
        if (w == 0) {
            out[w++] = 0x80 | ((ms >> 7) & 0x3F);
        }
        out[w++] = 0x80 | (ms & 0x7F);
        out[w++] = p[1];
        out[w++] = p[2] & 0x7F;
        if (body == 3) {
            out[w++] = p[3] & 0x7F;
        }
    }
    *used = i;
    return w;
}
