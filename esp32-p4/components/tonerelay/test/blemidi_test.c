/* Host test for blemidi.c:  cc -I.. -o blemidi_test blemidi_test.c ../blemidi.c && ./blemidi_test */
#include <stdio.h>
#include <string.h>

#include "blemidi.h"

static int failures;

static void check(const char *name, const uint8_t *pkt, size_t len, const uint8_t *want, size_t want_len)
{
    uint8_t out[64];
    size_t n = blemidi_parse(pkt, len, out, sizeof(out));
    if (n != want_len || memcmp(out, want, want_len) != 0) {
        printf("FAIL %s: got %zu bytes:", name, n);
        for (size_t i = 0; i < n; i++) printf(" %02X", out[i]);
        printf("\n");
        failures++;
    } else {
        printf("ok   %s\n", name);
    }
}

#define CHECK(name, ...) do { \
        const uint8_t p[] = __VA_ARGS__; \
        check(name, p, sizeof(p), want, sizeof(want)); \
    } while (0)

int main(void)
{
    { const uint8_t want[] = {0xC0, 0x05};
      CHECK("program change", {0x90, 0x81, 0xC0, 0x05}); }
    { const uint8_t want[] = {0xB0, 0x45, 0x7F};
      CHECK("control change", {0xA3, 0xD0, 0xB0, 0x45, 0x7F}); }
    { const uint8_t want[] = {0xC0, 0x01, 0xC0, 0x02};
      CHECK("two messages", {0x80, 0x81, 0xC0, 0x01, 0x82, 0xC0, 0x02}); }
    { const uint8_t want[] = {0xB0, 0x01, 0x10, 0x02, 0x20};
      CHECK("running status", {0x80, 0x81, 0xB0, 0x01, 0x10, 0x82, 0x02, 0x20}); }
    { const uint8_t want[] = {0xF8, 0xF8};
      CHECK("clock ticks", {0x80, 0x81, 0xF8, 0x82, 0xF8}); }
    { const uint8_t want[] = {0xB0, 0x01, 0xF8, 0x10};
      CHECK("clock inside a message", {0x80, 0x81, 0xB0, 0x01, 0x82, 0xF8, 0x10}); }
    { const uint8_t want[] = {0xF0, 0x7E, 0x01, 0xF7};
      CHECK("sysex in one packet", {0x80, 0x81, 0xF0, 0x7E, 0x01, 0x82, 0xF7}); }
    { const uint8_t want[] = {0xF0, 0x7E, 0x01};
      CHECK("sysex start", {0x80, 0x81, 0xF0, 0x7E, 0x01}); }
    { const uint8_t want[] = {0x02, 0xF7};
      CHECK("sysex continuation", {0x80, 0x02, 0x82, 0xF7}); }
    { const uint8_t want[] = {0};
      uint8_t out[8];
      if (blemidi_parse((const uint8_t[]){0x00, 0x81, 0xC0, 0x05}, 4, out, sizeof(out)) != 0) { printf("FAIL no header\n"); failures++; } else printf("ok   no header\n");
      if (blemidi_parse((const uint8_t[]){0xC0, 0x81, 0xC0, 0x05}, 4, out, sizeof(out)) != 0) { printf("FAIL bit 6 set\n"); failures++; } else printf("ok   bit 6 set\n");
      if (blemidi_parse((const uint8_t[]){0x80}, 1, out, sizeof(out)) != 0) { printf("FAIL header only\n"); failures++; } else printf("ok   header only\n");
      (void)want; }
    { uint8_t out[2];
      size_t n = blemidi_parse((const uint8_t[]){0x80, 0x81, 0xF0, 1, 2, 3, 4}, 7, out, sizeof(out));
      if (n != 2) { printf("FAIL cap\n"); failures++; } else printf("ok   output capped\n"); }
    { /* what iOS sent in the bench log */
      const uint8_t inq[] = {0xF0, 0x7E, 0x7F, 0x0D, 0x70, 0x02, 0x0F, 0x78, 0x53, 0x15, 0x7F, 0x7F, 0x7F, 0x7F, 0x11, 0x00, 0x00,
                             0x01, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x1C, 0x00, 0x00, 0x01, 0x00, 0x00, 0xF7};
      const uint8_t muid[4] = {1, 2, 3, 4};
      uint8_t out[64];
      size_t n = blemidi_ci_discovery_reply(inq, sizeof(inq), muid, out, sizeof(out));
      int ok = n == 33 && out[0] == 0xF0 && out[1] == 0x7E && out[3] == 0x0D && out[4] == 0x71 && out[5] == 0x02 &&
               memcmp(out + 6, muid, 4) == 0 && memcmp(out + 10, inq + 6, 4) == 0 && out[32] == 0xF7;
      for (size_t i = 1; i + 1 < n; i++) if (out[i] & 0x80) ok = 0; /* a SysEx body is 7-bit clean */
      printf(ok ? "ok   discovery reply\n" : "FAIL discovery reply (%zu bytes)\n", n); failures += !ok;
      const uint8_t other[] = {0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7};
      printf(blemidi_ci_discovery_reply(other, sizeof(other), muid, out, sizeof(out)) == 0 ? "ok   not discovery\n" : "FAIL not discovery\n");
      uint8_t pkt[64];
      const uint8_t msg[] = {0xF0, 0x7E, 0x01, 0xF7};
      n = blemidi_encode_sysex(msg, sizeof(msg), 0x1234, pkt, sizeof(pkt));
      uint8_t back[16];
      size_t m = blemidi_parse(pkt, n, back, sizeof(back));
      int ok2 = n == 7 && (pkt[0] & 0xC0) == 0x80 && m == sizeof(msg) && memcmp(back, msg, m) == 0;
      printf(ok2 ? "ok   sysex round trip\n" : "FAIL sysex round trip\n"); failures += !ok2;
      }
    { /* USB-MIDI packets */
      struct { const char *name; const uint8_t in[16]; size_t n; const uint8_t want[24]; size_t wn; } cases[] = {
        {"usb program change", {0xC0, 0x05}, 2, {0x0C, 0xC0, 0x05, 0x00}, 4},
        {"usb control change", {0xB0, 0x45, 0x7F}, 3, {0x0B, 0xB0, 0x45, 0x7F}, 4},
        {"usb running status", {0xB0, 0x01, 0x10, 0x02, 0x20}, 5, {0x0B, 0xB0, 0x01, 0x10, 0x0B, 0xB0, 0x02, 0x20}, 8},
        {"usb two program changes and a clock", {0xC6, 0x03, 0xC8, 0x00, 0xF8}, 5,
         {0x0C, 0xC6, 0x03, 0x00, 0x0C, 0xC8, 0x00, 0x00, 0x0F, 0xF8, 0x00, 0x00}, 12},
        {"usb clock inside a message", {0xB0, 0x01, 0xF8, 0x10}, 4, {0x0F, 0xF8, 0x00, 0x00, 0x0B, 0xB0, 0x01, 0x10}, 8},
        {"usb note on", {0x90, 0x3C, 0x7F}, 3, {0x09, 0x90, 0x3C, 0x7F}, 4},
        {"usb sysex, 4 bytes", {0xF0, 0x7E, 0x01, 0xF7}, 4, {0x04, 0xF0, 0x7E, 0x01, 0x05, 0xF7, 0x00, 0x00}, 8},
        {"usb sysex, 3 bytes", {0xF0, 0x01, 0xF7}, 3, {0x07, 0xF0, 0x01, 0xF7}, 4},
        {"usb sysex, 2 bytes", {0xF0, 0xF7}, 2, {0x06, 0xF0, 0xF7, 0x00}, 4},
        {"usb data without status", {0x10, 0x20}, 2, {0}, 0},
      };
      for (size_t c = 0; c < sizeof(cases) / sizeof(cases[0]); c++) {
          usbmidi_enc_t e; memset(&e, 0, sizeof(e));
          uint8_t out[64];
          size_t n = usbmidi_encode(&e, cases[c].in, cases[c].n, out, sizeof(out));
          int ok = n == cases[c].wn && memcmp(out, cases[c].want, n) == 0;
          printf(ok ? "ok   %s\n" : "FAIL %s\n", cases[c].name); failures += !ok;
      }
      /* a message in two pieces, and a SysEx across pieces */
      usbmidi_enc_t e; memset(&e, 0, sizeof(e));
      uint8_t out[64]; uint8_t a[] = {0xB0, 0x45}, b[] = {0x7F}, s1[] = {0xF0, 0x7E}, s2[] = {0x01, 0x02, 0xF7};
      size_t n = usbmidi_encode(&e, a, 2, out, sizeof(out));
      n += usbmidi_encode(&e, b, 1, out + n, sizeof(out) - n);
      int ok = n == 4 && out[0] == 0x0B && out[3] == 0x7F; printf(ok ? "ok   usb split message\n" : "FAIL usb split message\n"); failures += !ok;
      memset(&e, 0, sizeof(e));
      n = usbmidi_encode(&e, s1, 2, out, sizeof(out));
      n += usbmidi_encode(&e, s2, 3, out + n, sizeof(out) - n);
      ok = n == 8 && out[0] == 0x04 && out[1] == 0xF0 && out[2] == 0x7E && out[3] == 0x01 && out[4] == 0x06 && out[5] == 0x02 && out[6] == 0xF7;
      printf(ok ? "ok   usb split sysex\n" : "FAIL usb split sysex\n"); failures += !ok; }
    { /* pedal to BLE: program change and snapshot CC from the bench log, then things that are not passed on */
      uint8_t out[8]; size_t n;
      const uint8_t pc[4] = {0x0C, 0xC6, 0x71, 0x00}, cc[4] = {0x0B, 0xB6, 0x45, 0x02}, clk[4] = {0x0F, 0xF8, 0, 0}, sx[4] = {0x04, 0xF0, 0x7E, 0x01};
      n = blemidi_encode_usb_event(pc, 0x1234, out, sizeof(out));
      int ok = n == 4 && out[0] == (0x80 | ((0x1234 >> 7) & 0x3F)) && out[1] == (0x80 | (0x1234 & 0x7F)) && out[2] == 0xC6 && out[3] == 0x71;
      printf(ok ? "ok   pedal program change\n" : "FAIL pedal program change\n"); failures += !ok;
      n = blemidi_encode_usb_event(cc, 0, out, sizeof(out));
      ok = n == 5 && out[2] == 0xB6 && out[3] == 0x45 && out[4] == 0x02;
      printf(ok ? "ok   pedal control change\n" : "FAIL pedal control change\n"); failures += !ok;
      ok = blemidi_encode_usb_event(clk, 0, out, sizeof(out)) == 0 && blemidi_encode_usb_event(sx, 0, out, sizeof(out)) == 0 &&
           blemidi_encode_usb_event(pc, 0, out, 5) == 0;
      printf(ok ? "ok   pedal clock, sysex, small buffer not passed\n" : "FAIL pedal not-passed cases\n"); failures += !ok; }
    printf(failures ? "%d FAILED\n" : "all passed\n", failures);
    return failures != 0;
}
