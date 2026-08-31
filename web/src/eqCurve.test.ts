import { describe, expect, it } from "vitest";
import {
  BAND_RANGE,
  clampHighCut,
  clampLowCut,
  clampPeak,
  curveDb,
  eqStateFromParams,
  freqToX,
  gainToY,
  HIGH_CUT_OFF_WIRE,
  isHighCutOff,
  isLowCutOff,
  isParametricEq,
  logFrequencies,
  LOW_CUT_OFF_WIRE,
  PARAM,
  xToFreq,
  yToGain,
} from "./eqCurve";

describe("parametric identity", () => {
  it("matches catalog id and Helix.sym numbers", () => {
    expect(isParametricEq("HD2_EQParametric")).toBe(true);
    expect(isParametricEq(undefined, 131)).toBe(true);
    expect(isParametricEq(undefined, 135)).toBe(true);
    expect(isParametricEq("HD2_EQGraphic10Band", 129)).toBe(false);
  });
});

describe("axis mapping", () => {
  it("round-trips log frequency", () => {
    const width = 800;
    for (const hz of [20, 110, 1000, 8000, 20000]) {
      expect(xToFreq(freqToX(hz, width), width)).toBeCloseTo(hz, 5);
    }
  });

  it("round-trips linear gain", () => {
    const height = 300;
    for (const db of [-12, -3, 0, 6, 12]) {
      expect(yToGain(gainToY(db, height), height)).toBeCloseTo(db, 5);
    }
  });

  it("places 1 kHz past the geometric midpoint of 20 Hz–20 kHz", () => {
    const x = freqToX(1000, 1000);
    expect(x).toBeGreaterThan(500);
    expect(x).toBeLessThan(600);
  });
});

describe("Off cuts and clamps", () => {
  it("treats Helix Off wires as Off", () => {
    expect(isLowCutOff(LOW_CUT_OFF_WIRE)).toBe(true);
    expect(isLowCutOff(19.9)).toBe(true);
    expect(isLowCutOff(20)).toBe(false);
    expect(isLowCutOff(110)).toBe(false);
    expect(isHighCutOff(HIGH_CUT_OFF_WIRE)).toBe(true);
    expect(isHighCutOff(20_100)).toBe(true);
    expect(isHighCutOff(8000)).toBe(false);
  });

  it("parks a low-cut drag below 20 Hz as Off", () => {
    expect(clampLowCut(12)).toBe(LOW_CUT_OFF_WIRE);
    expect(clampLowCut(80)).toBe(80);
    expect(clampLowCut(2000)).toBe(1000);
  });

  it("parks a high-cut drag at the right edge as Off", () => {
    expect(clampHighCut(24_000)).toBe(HIGH_CUT_OFF_WIRE);
    expect(clampHighCut(12_000)).toBe(12_000);
    expect(clampHighCut(200)).toBe(1000);
  });

  it("clamps each peaking band to its Helix freq range", () => {
    expect(clampPeak("low", 800, 0, 0.7).freq).toBe(BAND_RANGE.low.freqMax);
    expect(clampPeak("mid", 50, 0, 0.7).freq).toBe(BAND_RANGE.mid.freqMin);
    expect(clampPeak("high", 40_000, 20, 99)).toEqual({
      freq: BAND_RANGE.high.freqMax,
      gain: 12,
      q: 10,
    });
  });
});

describe("eqStateFromParams", () => {
  it("reads native Hz/Q/dB by USB index", () => {
    const params = [110, 0.7, 3, 2000, 1.2, -2, 8000, 0.5, 1, 19.9, 20100, -6];
    const s = eqStateFromParams(params);
    expect(s.low).toEqual({ freq: 110, q: 0.7, gain: 3 });
    expect(s.mid.q).toBe(1.2);
    expect(s.high.gain).toBe(1);
    expect(s.lowCut).toBe(19.9);
    expect(s.level).toBe(-6);
    expect(PARAM.Level).toBe(11);
  });

  it("falls back to Helix defaults when a slot is missing", () => {
    const s = eqStateFromParams([]);
    expect(s.low.freq).toBe(110);
    expect(s.mid.freq).toBe(2000);
    expect(s.high.freq).toBe(8000);
    expect(s.lowCut).toBe(LOW_CUT_OFF_WIRE);
    expect(s.highCut).toBe(HIGH_CUT_OFF_WIRE);
  });
});

describe("curveDb", () => {
  const freqs = logFrequencies(64);

  function nearest(hz: number): number {
    let best = freqs[0];
    for (const f of freqs) {
      if (Math.abs(f - hz) < Math.abs(best - hz)) {
        best = f;
      }
    }
    return best;
  }

  it("peaks near +6 dB at the low band when other bands are flat", () => {
    const state = eqStateFromParams([110, 0.7, 6, 2000, 0.7, 0, 8000, 0.7, 0, 19.9, 20100, 0]);
    const dbs = curveDb(state, freqs);
    const i = freqs.indexOf(nearest(110));
    expect(dbs[i]).toBeGreaterThan(4);
    expect(dbs[i]).toBeLessThan(7);
  });

  it("does not roll off lows when Low Cut is Off", () => {
    const off = eqStateFromParams([110, 0.7, 0, 2000, 0.7, 0, 8000, 0.7, 0, 19.9, 20100, 0]);
    const dbs = curveDb(off, freqs);
    const i = freqs.indexOf(nearest(30));
    expect(Math.abs(dbs[i])).toBeLessThan(1);
  });

  it("rolls off below an enabled Low Cut", () => {
    const on = eqStateFromParams([110, 0.7, 0, 2000, 0.7, 0, 8000, 0.7, 0, 200, 20100, 0]);
    const dbs = curveDb(on, freqs);
    const i = freqs.indexOf(nearest(30));
    expect(dbs[i]).toBeLessThan(-12);
  });
});
