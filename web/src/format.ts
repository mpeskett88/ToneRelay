/** Resolved HX Edit formatting for one knob (aliases already followed). */
export type FormatRange = {
  lower: number;
  upper: number;
  pattern?: string;
  multiplier?: number;
};

export type FormatSpec = {
  scale?: number;
  offset?: number;
  pattern?: string;
  labels?: string[];
  ranges?: FormatRange[];
};

/** Print a wire value the way HX Edit would: "5.0", "100 %", "28 ms". */
export function formatValue(wire: number, spec: FormatSpec): string {
  const scaled = wire * (spec.scale ?? 1) + (spec.offset ?? 0);
  if (spec.labels && spec.labels.length > 0) {
    const i = Math.max(0, Math.round(scaled));
    return spec.labels[i] ?? trim(scaled);
  }
  if (spec.ranges && spec.ranges.length > 0) {
    const range = spec.ranges.find((r) => scaled >= r.lower && scaled < r.upper);
    if (!range) {
      return trim(scaled);
    }
    const v = scaled * (range.multiplier ?? 1);
    return range.pattern ? printf(range.pattern, v) : trim(v);
  }
  if (spec.pattern) {
    return printf(spec.pattern, scaled);
  }
  return trim(scaled);
}

function trim(v: number): string {
  if (Math.abs(v - rustRound(v)) < 1e-4) {
    return String(rustRound(v));
  }
  return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** Rust `f32::round`: half-way cases away from 0.0. */
function rustRound(v: number): number {
  return Math.sign(v) * Math.round(Math.abs(v)) || 0;
}

/** IEEE-754 round ties to even, matching Rust `{value:.N}`. */
function roundTiesToEven(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const floor = Math.floor(abs);
  const frac = abs - floor;
  let rounded = floor;
  if (frac > 0.5) {
    rounded = floor + 1;
  } else if (frac < 0.5) {
    rounded = floor;
  } else {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  }
  return sign * rounded;
}

function formatFloat(value: number, precision: number): string {
  if (precision <= 0) {
    return String(roundTiesToEven(value));
  }
  const factor = 10 ** precision;
  return (roundTiesToEven(value * factor) / factor).toFixed(precision);
}

/** The sliver of printf HelixControls uses: `%[+][.N]f`, `%d`, `%%`. */
function printf(pattern: string, value: number): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c !== "%") {
      out += c;
      continue;
    }
    if (pattern[i + 1] === "%") {
      out += "%";
      i++;
      continue;
    }
    let j = i + 1;
    const plus = pattern[j] === "+";
    if (plus) {
      j++;
    }
    let precision = 0;
    if (pattern[j] === ".") {
      j++;
      const digit = pattern[j];
      if (digit && digit >= "0" && digit <= "9") {
        precision = Number(digit);
        j++;
      }
    }
    const kind = pattern[j];
    if (kind === "f") {
      if (plus && value >= 0) {
        out += "+";
      }
      out += formatFloat(value, precision);
    } else if (kind === "d") {
      if (plus && value >= 0) {
        out += "+";
      }
      out += String(rustRound(value));
    } else if (kind) {
      out += trim(value);
      out += kind;
    } else {
      out += trim(value);
    }
    i = kind ? j : pattern.length;
  }
  return out;
}
