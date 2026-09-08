#!/usr/bin/env python3
"""Inspector shows HX Edit labels (5.0, 100 %, 28 ms), not wire floats."""

from playwright.sync_api import sync_playwright

MOCK_WS = r"""
(() => {
  window.__bridgeCommands = [];
  let trails = true;
  const knobs = [
    { index: 0, id: "Drive", name: "Drive", kind: "continuous", usb: "f32", min: 0, max: 1,
      format: { scale: 10, pattern: "%.1f" } },
    { index: 1, id: "Mix", name: "Mix", kind: "continuous", usb: "f32", min: 0, max: 1,
      format: { scale: 100, pattern: "%.0f %%" } },
    { index: 2, id: "Level", name: "Level", kind: "continuous", usb: "f32", min: -60, max: 6,
      format: { pattern: "%+.1f dB" } },
    { index: 3, id: "PreDelay", name: "PreDelay", kind: "continuous", usb: "f32", min: 0, max: 0.1,
      format: { scale: 1000, ranges: [
        { lower: 0, upper: 9.999, pattern: "%.1f ms" },
        { lower: 9.999, upper: 1000, pattern: "%.0f ms" },
      ] } },
  ];
  const params = [0.5, 1.0, 0.0, 0.028];
  function reply(cmd) {
    window.__bridgeCommands.push(cmd);
    const base = { ok: true, op: cmd.op, id: cmd.id };
    if (cmd.op === "info") return { ...base, usb: true };
    if (cmd.op === "list_setlists") return { ...base, setlists: [{ index: 0, name: "User 1" }] };
    if (cmd.op === "list_presets") {
      return { ...base, presets: [{ index: 0, name: "Format Test" }], setlist: 0, index: 0 };
    }
    if (cmd.op === "list_models") return { ...base, categories: [] };
    if (cmd.op === "list_favorites") return { ...base, favorites: [] };
    if (cmd.op === "events") return { ...base, dirty: false };
    if (cmd.op === "set_trails") {
      trails = !!cmd.value;
      return { ...base, block: cmd.block, value: trails };
    }
    if (cmd.op === "get_state") {
      return {
        ...base,
        blocks: [
          { block: 0, subslot: 0, kind: 0, params: [], model_name: "Input", category: "Input", enabled: true },
          {
            block: 4, subslot: 0, params, model: 1,
            model_id: "HD2_AmpEssexA30", model_name: "Essex A30", category: "Amp",
            knobs, enabled: true, trails, load: 22.74,
          },
          { block: 9, subslot: 0, kind: 1, params: [], model_name: "Output", category: "Output", enabled: true },
        ],
        paths: [], snapshots: [], setlist: 0, index: 0, name: "Format Test",
      };
    }
    return base;
  }
  class MockWS {
    constructor() {
      this.readyState = 0;
      this.listeners = {};
      queueMicrotask(() => {
        this.readyState = 1;
        this._emit("open", {});
      });
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
    }
    _emit(type, ev) { for (const fn of this.listeners[type] || []) fn(ev); }
    send(text) {
      const body = JSON.stringify(reply(JSON.parse(String(text))));
      queueMicrotask(() => this._emit("message", { data: body }));
    }
    close() { this.readyState = 3; this._emit("close", {}); }
  }
  window.WebSocket = MockWS;
})();
"""


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.add_init_script("try { localStorage.clear(); } catch (e) {}")
        page.add_init_script(MOCK_WS)
        page.goto("http://127.0.0.1:5173/", wait_until="networkidle")
        page.get_by_test_id("connect-wifi").click()
        page.get_by_test_id("chain-cell-4").click()
        page.locator(".param-value").first.wait_for()
        shown = page.locator(".param-value").all_inner_texts()
        assert "5.0" in shown, shown
        assert "100 %" in shown, shown
        assert "+0.0 dB" in shown, shown
        assert "28 ms" in shown, shown
        assert not any(v == "0.50" or v == "1.00" or v == "0.03" for v in shown), shown
        wrapped = page.locator(".param-value").evaluate_all(
            "els => els.filter((el) => el.getClientRects().length > 1).map((el) => el.textContent)"
        )
        assert wrapped == [], wrapped
        trails = page.get_by_test_id("trails-toggle")
        assert trails.get_attribute("aria-pressed") == "true"
        trails.click()
        assert trails.get_attribute("aria-pressed") == "false"
        writes = page.evaluate(
            "() => (window.__bridgeCommands || []).filter((c) => c.op === 'set_trails')"
        )
        assert writes and writes[-1].get("value") is False, writes
        context.close()
        browser.close()
    print("ok", shown)


if __name__ == "__main__":
    main()
