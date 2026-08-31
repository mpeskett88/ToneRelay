#!/usr/bin/env python3
"""Open the Parametric EQ graph, drag a handle, assert set_param, close."""

from playwright.sync_api import sync_playwright

MOCK_WS = r"""
(() => {
  window.__eqCommands = [];
  const params = [110, 0.7, 0, 2000, 0.7, 0, 8000, 0.7, 0, 19.9, 20100, 0];
  const knobs = [
    ["LowFreq", "Low Freq", 20, 495],
    ["LowQ", "Low Q", 0.1, 10],
    ["LowGain", "Low Gain", -12, 12],
    ["MidFreq", "Mid Freq", 125, 8000],
    ["MidQ", "Mid Q", 0.1, 10],
    ["MidGain", "Mid Gain", -12, 12],
    ["HighFreq", "High Freq", 500, 18000],
    ["HighQ", "High Q", 0.1, 10],
    ["HighGain", "High Gain", -12, 12],
    ["LowCut", "Low Cut", 19.9, 1000],
    ["HighCut", "High Cut", 1000, 20100],
    ["Level", "Level", -60, 12],
  ].map((row, i) => ({
    index: i, id: row[0], name: row[1], kind: "continuous", usb: "f32", min: row[2], max: row[3],
  }));
  function reply(cmd) {
    const base = { ok: true, op: cmd.op, id: cmd.id };
    if (cmd.op === "info") return { ...base, usb: true };
    if (cmd.op === "list_setlists") return { ...base, setlists: [{ index: 0, name: "User 1" }] };
    if (cmd.op === "list_presets") {
      return { ...base, presets: [{ index: 0, name: "EQ Test" }], setlist: 0, index: 0 };
    }
    if (cmd.op === "list_models") return { ...base, categories: [] };
    if (cmd.op === "events") return { ...base, dirty: false };
    if (cmd.op === "set_param") {
      const i = cmd.param;
      if (typeof i === "number" && typeof cmd.float === "number") params[i] = cmd.float;
      return base;
    }
    if (cmd.op === "get_state") {
      return {
        ...base,
        blocks: [
          { block: 0, subslot: 0, kind: 0, params: [], model_name: "Input", category: "Input", enabled: true },
          {
            block: 3, subslot: 0, params: params.slice(), model: 131,
            model_id: "HD2_EQParametric", model_name: "Parametric", category: "EQ",
            knobs, enabled: true, stereo: false, load: 2.44,
          },
          { block: 9, subslot: 0, kind: 1, params: [], model_name: "Output", category: "Output", enabled: true },
        ],
        paths: [], snapshots: [], setlist: 0, index: 0, name: "EQ Test",
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
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
    }
    _emit(type, ev) {
      for (const fn of this.listeners[type] || []) fn(ev);
    }
    send(text) {
      const cmd = JSON.parse(String(text));
      window.__eqCommands.push(cmd);
      const body = JSON.stringify(reply(cmd));
      queueMicrotask(() => this._emit("message", { data: body }));
    }
    close() {
      this.readyState = 3;
      this._emit("close", {});
    }
  }
  window.WebSocket = MockWS;
})();
"""


def run_flow(page, width, height):
    page.set_viewport_size({"width": width, "height": height})
    page.add_init_script("try { localStorage.clear(); } catch (e) {}")
    page.add_init_script(MOCK_WS)
    page.goto("http://127.0.0.1:5173/", wait_until="networkidle")

    page.get_by_test_id("connect-wifi").click()
    page.get_by_test_id("chain-cell-3").wait_for()
    page.get_by_test_id("chain-cell-3").click()
    page.get_by_test_id("eq-graph-open").click()
    page.get_by_test_id("eq-overlay").wait_for()
    page.screenshot(path=f"/tmp/eq-graph-{width}x{height}.png")

    hint = page.locator(".eq-rotate-hint")
    portrait = height > width
    if portrait:
        assert hint.is_visible(), "rotate hint should show in portrait"
    else:
        assert not hint.is_visible(), "rotate hint should hide in landscape"

    assert page.get_by_test_id("eq-q-slider").count() == 0
    assert page.get_by_test_id("eq-level-slider").count() == 0
    page.get_by_test_id("eq-plot").wait_for()
    handle = page.get_by_test_id("eq-handle-mid")
    box = handle.bounding_box()
    assert box, "mid handle has no box"
    cx = box["x"] + box["width"] / 2
    cy = box["y"] + box["height"] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx - 80, cy - 70, steps=8)
    mid_drag = page.evaluate("() => window.__eqCommands.filter((c) => c.op === 'set_param')")
    assert mid_drag == [], f"set_param fired before lift: {mid_drag}"
    page.mouse.up()
    page.wait_for_timeout(50)

    commands = page.evaluate("() => window.__eqCommands")
    writes = [c for c in commands if c.get("op") == "set_param"]
    assert writes, f"no set_param after lift ({width}x{height})"
    changed = [
        c
        for c in writes
        if c.get("param") in (3, 5) and isinstance(c.get("float"), (int, float))
    ]
    assert changed, f"drag did not write mid freq/gain: {writes}"
    freqs = [c["float"] for c in changed if c["param"] == 3]
    gains = [c["float"] for c in changed if c["param"] == 5]
    if freqs:
        assert freqs[-1] != 2000, f"mid freq unchanged: {freqs}"
    if gains:
        assert gains[-1] != 0, f"mid gain unchanged: {gains}"
    assert freqs or gains

    page.get_by_test_id("eq-graph-close").click()
    page.get_by_test_id("eq-overlay").wait_for(state="hidden")
    assert page.get_by_text("Low Freq").is_visible()
    assert page.get_by_test_id("eq-graph-open").is_visible()
    return {"writes": changed, "portrait": portrait}


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        results = []
        for width, height in ((390, 844), (844, 390)):
            context = browser.new_context()
            page = context.new_page()
            try:
                results.append(run_flow(page, width, height))
            finally:
                context.close()
        browser.close()
    print("ok", results)


if __name__ == "__main__":
    main()
