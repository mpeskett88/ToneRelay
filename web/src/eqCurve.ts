/** Parametric EQ (`HD2_EQParametric`) curve math and Helix wire mapping. */

export const EQ_PARAMETRIC_ID = "HD2_EQParametric";

export const FREQ_MIN = 20;
export const FREQ_MAX = 20_000;
export const GAIN_MIN = -12;
export const GAIN_MAX = 12;
export const Q_MIN = 0.1;
export const Q_MAX = 10;

/** Helix Low Cut wire below this Hz is shown as Off. */
export const LOW_CUT_OFF_HZ = 20;
/** Helix High Cut wire at or above this Hz is shown as Off. */
export const HIGH_CUT_OFF_HZ = 20_000.1;
export const LOW_CUT_OFF_WIRE = 19.9;
export const HIGH_CUT_OFF_WIRE = 20_100;

const SAMPLE_RATE = 48_000;
const BUTTER_Q = Math.SQRT1_2;

export const PARAM = {
  LowFreq: 0,
  LowQ: 1,
  LowGain: 2,
  MidFreq: 3,
  MidQ: 4,
  MidGain: 5,
  HighFreq: 6,
  HighQ: 7,
  HighGain: 8,
  LowCut: 9,
  HighCut: 10,
  Level: 11,
} as const;

export type PeakBand = "low" | "mid" | "high";
export type HandleId = PeakBand | "lowCut" | "highCut";

export type PeakState = { freq: number; q: number; gain: number };

export type EqState = {
  low: PeakState;
  mid: PeakState;
  high: PeakState;
  lowCut: number;
  highCut: number;
  level: number;
};

export const BAND_RANGE: Record<PeakBand, { freqMin: number; freqMax: number }> = {
  low: { freqMin: 20, freqMax: 495 },
  mid: { freqMin: 125, freqMax: 8000 },
  high: { freqMin: 500, freqMax: 18_000 },
};

export const CUT_RANGE = {
  lowCut: { freqMin: LOW_CUT_OFF_WIRE, freqMax: 1000 },
  highCut: { freqMin: 1000, freqMax: HIGH_CUT_OFF_WIRE },
} as const;

export const LEVEL_RANGE = { min: -60, max: 12 } as const;

const DEFAULT_EQ: EqState = {
  low: { freq: 110, q: 0.7, gain: 0 },
  mid: { freq: 2000, q: 0.7, gain: 0 },
  high: { freq: 8000, q: 0.7, gain: 0 },
  lowCut: LOW_CUT_OFF_WIRE,
  highCut: HIGH_CUT_OFF_WIRE,
  level: 0,
};

export function isParametricEq(modelId: string | undefined, model?: number | null): boolean {
  if (modelId === EQ_PARAMETRIC_ID) {
    return true;
  }
  return model === 131 || model === 135;
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function isLowCutOff(hz: number): boolean {
  return hz < LOW_CUT_OFF_HZ;
}

export function isHighCutOff(hz: number): boolean {
  return hz >= HIGH_CUT_OFF_HZ;
}

export function freqToX(freq: number, width: number): number {
  const minL = Math.log10(FREQ_MIN);
  const maxL = Math.log10(FREQ_MAX);
  const f = clamp(freq, FREQ_MIN, FREQ_MAX);
  return ((Math.log10(f) - minL) / (maxL - minL)) * width;
}

export function xToFreq(x: number, width: number): number {
  const minL = Math.log10(FREQ_MIN);
  const maxL = Math.log10(FREQ_MAX);
  const t = clamp(width <= 0 ? 0 : x / width, 0, 1);
  return 10 ** (minL + t * (maxL - minL));
}

export function gainToY(gain: number, height: number): number {
  return ((GAIN_MAX - gain) / (GAIN_MAX - GAIN_MIN)) * height;
}

export function yToGain(y: number, height: number): number {
  const t = height <= 0 ? 0.5 : y / height;
  return GAIN_MAX - t * (GAIN_MAX - GAIN_MIN);
}

export function clampPeak(band: PeakBand, freq: number, gain: number, q: number): PeakState {
  const range = BAND_RANGE[band];
  return {
    freq: clamp(freq, range.freqMin, range.freqMax),
    gain: clamp(gain, GAIN_MIN, GAIN_MAX),
    q: clamp(q, Q_MIN, Q_MAX),
  };
}

export function clampLowCut(freq: number): number {
  if (freq < LOW_CUT_OFF_HZ) {
    return LOW_CUT_OFF_WIRE;
  }
  return clamp(freq, LOW_CUT_OFF_HZ, CUT_RANGE.lowCut.freqMax);
}

export function clampHighCut(freq: number): number {
  if (freq >= HIGH_CUT_OFF_HZ) {
    return HIGH_CUT_OFF_WIRE;
  }
  return clamp(freq, CUT_RANGE.highCut.freqMin, FREQ_MAX);
}

export function clampLevel(db: number): number {
  return clamp(db, LEVEL_RANGE.min, LEVEL_RANGE.max);
}

function numAt(params: Array<number | boolean>, index: number, fallback: number): number {
  const v = params[index];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function eqStateFromParams(params: Array<number | boolean>): EqState {
  return {
    low: {
      freq: numAt(params, PARAM.LowFreq, DEFAULT_EQ.low.freq),
      q: numAt(params, PARAM.LowQ, DEFAULT_EQ.low.q),
      gain: numAt(params, PARAM.LowGain, DEFAULT_EQ.low.gain),
    },
    mid: {
      freq: numAt(params, PARAM.MidFreq, DEFAULT_EQ.mid.freq),
      q: numAt(params, PARAM.MidQ, DEFAULT_EQ.mid.q),
      gain: numAt(params, PARAM.MidGain, DEFAULT_EQ.mid.gain),
    },
    high: {
      freq: numAt(params, PARAM.HighFreq, DEFAULT_EQ.high.freq),
      q: numAt(params, PARAM.HighQ, DEFAULT_EQ.high.q),
      gain: numAt(params, PARAM.HighGain, DEFAULT_EQ.high.gain),
    },
    lowCut: numAt(params, PARAM.LowCut, DEFAULT_EQ.lowCut),
    highCut: numAt(params, PARAM.HighCut, DEFAULT_EQ.highCut),
    level: numAt(params, PARAM.Level, DEFAULT_EQ.level),
  };
}

export function logFrequencies(count: number, minHz = FREQ_MIN, maxHz = FREQ_MAX): number[] {
  const n = Math.max(count, 2);
  const minL = Math.log10(minHz);
  const maxL = Math.log10(maxHz);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(10 ** (minL + (i / (n - 1)) * (maxL - minL)));
  }
  return out;
}

type Biquad = { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number };

function peaking(f0: number, q: number, gainDb: number): Biquad {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * Math.max(q, 0.01));
  const cos = Math.cos(w0);
  return {
    b0: 1 + alpha * A,
    b1: -2 * cos,
    b2: 1 - alpha * A,
    a0: 1 + alpha / A,
    a1: -2 * cos,
    a2: 1 - alpha / A,
  };
}

function highpass(f0: number): Biquad {
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * BUTTER_Q);
  const cos = Math.cos(w0);
  return {
    b0: (1 + cos) / 2,
    b1: -(1 + cos),
    b2: (1 + cos) / 2,
    a0: 1 + alpha,
    a1: -2 * cos,
    a2: 1 - alpha,
  };
}

function lowpass(f0: number): Biquad {
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * BUTTER_Q);
  const cos = Math.cos(w0);
  return {
    b0: (1 - cos) / 2,
    b1: 1 - cos,
    b2: (1 - cos) / 2,
    a0: 1 + alpha,
    a1: -2 * cos,
    a2: 1 - alpha,
  };
}

function magDb(f: number, c: Biquad): number {
  const w = (2 * Math.PI * f) / SAMPLE_RATE;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const nRe = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const nIm = -c.b1 * sin1 - c.b2 * sin2;
  const dRe = c.a0 + c.a1 * cos1 + c.a2 * cos2;
  const dIm = -c.a1 * sin1 - c.a2 * sin2;
  const den = dRe * dRe + dIm * dIm;
  if (den <= 0) {
    return -120;
  }
  const mag2 = (nRe * nRe + nIm * nIm) / den;
  if (mag2 <= 0) {
    return -120;
  }
  return 10 * Math.log10(mag2);
}

/** Combined magnitude in dB. Output Level is not included. */
export function curveDb(state: EqState, frequencies: number[]): number[] {
  const peaks: Biquad[] = [
    peaking(state.low.freq, state.low.q, state.low.gain),
    peaking(state.mid.freq, state.mid.q, state.mid.gain),
    peaking(state.high.freq, state.high.q, state.high.gain),
  ];
  const hp = isLowCutOff(state.lowCut) ? null : highpass(state.lowCut);
  const lp = isHighCutOff(state.highCut) ? null : lowpass(state.highCut);
  return frequencies.map((f) => {
    let db = 0;
    for (const c of peaks) {
      db += magDb(f, c);
    }
    if (hp) {
      db += magDb(f, hp);
    }
    if (lp) {
      db += magDb(f, lp);
    }
    return db;
  });
}

export function formatHz(hz: number): string {
  if (hz >= 1000) {
    const k = hz / 1000;
    return `${k >= 10 ? k.toFixed(0) : k.toFixed(1)} kHz`;
  }
  if (hz < 20) {
    return `${hz.toFixed(1)} Hz`;
  }
  return `${hz.toFixed(0)} Hz`;
}

export function formatCut(hz: number, kind: "low" | "high"): string {
  if (kind === "low" && isLowCutOff(hz)) {
    return "Off";
  }
  if (kind === "high" && isHighCutOff(hz)) {
    return "Off";
  }
  return formatHz(hz);
}

export function formatQ(q: number): string {
  return q.toFixed(1);
}

export function formatDb(db: number): string {
  const sign = db > 0 ? "+" : "";
  return `${sign}${db.toFixed(1)} dB`;
}

export function handleLabel(id: HandleId): string {
  switch (id) {
    case "low":
      return "Low";
    case "mid":
      return "Mid";
    case "high":
      return "High";
    case "lowCut":
      return "Low Cut";
    case "highCut":
      return "High Cut";
  }
}

export function isPeakBand(id: HandleId): id is PeakBand {
  return id === "low" || id === "mid" || id === "high";
}

export function handleFreq(state: EqState, id: HandleId): number {
  if (id === "lowCut") {
    return isLowCutOff(state.lowCut) ? FREQ_MIN : state.lowCut;
  }
  if (id === "highCut") {
    return isHighCutOff(state.highCut) ? FREQ_MAX : state.highCut;
  }
  return state[id].freq;
}

export function handleGain(state: EqState, id: HandleId): number {
  if (id === "lowCut" || id === "highCut") {
    return 0;
  }
  return state[id].gain;
}

export const GRID_HZ = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
export const GRID_DB = [-12, -6, 0, 6, 12];
