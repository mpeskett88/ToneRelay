import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BridgeClient, BridgeError } from "./bridge";
import { CATEGORY_FILL, type DumpBlock } from "./catalog";
import {
  clampHighCut,
  clampLowCut,
  clampPeak,
  curveDb,
  FREQ_MAX,
  FREQ_MIN,
  formatCut,
  formatDb,
  formatHz,
  formatQ,
  freqToX,
  GAIN_MAX,
  GAIN_MIN,
  GRID_DB,
  GRID_HZ,
  gainToY,
  handleFreq,
  handleGain,
  handleLabel,
  isHighCutOff,
  isLowCutOff,
  isPeakBand,
  logFrequencies,
  PARAM,
  eqStateFromParams,
  xToFreq,
  yToGain,
  type EqState,
  type HandleId,
  type PeakBand,
} from "./eqCurve";

const CURVE_POINTS = 160;
const HIT_PX = 22;
const HANDLE_R = 8;
const HANDLES: HandleId[] = ["low", "mid", "high", "lowCut", "highCut"];
const EQ_YELLOW = CATEGORY_FILL.eq;

type Props = {
  dump: DumpBlock;
  client: BridgeClient;
  blocks: DumpBlock[];
  setBlocks: (blocks: DumpBlock[]) => void;
  setError: (msg: string | null) => void;
  onClose: () => void;
};

function peakOf(state: EqState, id: PeakBand) {
  return state[id];
}

function patchDumpParams(blocks: DumpBlock[], dump: DumpBlock, updates: Record<number, number>): DumpBlock[] {
  return blocks.map((b) => {
    if (b.block !== dump.block || b.subslot !== dump.subslot) {
      return b;
    }
    const src = b.params.slice();
    while (src.length < 12) {
      src.push(0);
    }
    return {
      ...b,
      params: src.map((v, i) => (Object.prototype.hasOwnProperty.call(updates, i) ? updates[i] : v)),
    };
  });
}

export default function EqGraph({ dump, client, blocks, setBlocks, setError, onClose }: Props) {
  const plotRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [selected, setSelected] = useState<HandleId>("mid");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const blocksRef = useRef(blocks);
  const gesturing = useRef(false);
  const pending = useRef(new Map<number, number>());
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{ handle: HandleId; pointerId: number } | null>(null);
  const pinchRef = useRef<{ startDist: number; startQ: number } | null>(null);
  const dumpRef = useRef(dump);
  dumpRef.current = dump;

  const live = blocks.find((b) => b.block === dump.block && b.subslot === dump.subslot) ?? dump;
  const [draft, setDraft] = useState(() => eqStateFromParams(live.params));
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const freqs = useMemo(() => logFrequencies(CURVE_POINTS), []);
  const dbs = useMemo(() => curveDb(draft, freqs), [draft, freqs]);

  useEffect(() => {
    if (gesturing.current) {
      return;
    }
    blocksRef.current = blocks;
    setDraft(eqStateFromParams(live.params));
  }, [blocks, live.params]);

  useLayoutEffect(() => {
    const el = plotRef.current;
    if (!el) {
      return;
    }
    const sync = () => {
      const box = el.getBoundingClientRect();
      const w = Math.max(1, Math.round(box.width));
      const h = Math.max(1, Math.round(box.height));
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function commit() {
    const current = dumpRef.current;
    const batch = new Map(pending.current);
    if (batch.size === 0) {
      return;
    }
    pending.current.clear();
    setBlocks(blocksRef.current);
    flushPending(current, batch, client, setError);
  }

  useEffect(() => {
    return () => {
      const current = dumpRef.current;
      const batch = new Map(pending.current);
      pending.current.clear();
      if (batch.size === 0) {
        return;
      }
      setBlocks(blocksRef.current);
      flushPending(current, batch, client, setError);
    };
  }, [client, setError, setBlocks]);

  function patchLocal(updates: Record<number, number>) {
    const current = dumpRef.current;
    const nextBlocks = patchDumpParams(blocksRef.current, current, updates);
    blocksRef.current = nextBlocks;
    const row =
      nextBlocks.find((b) => b.block === current.block && b.subslot === current.subslot) ?? current;
    const next = eqStateFromParams(row.params);
    draftRef.current = next;
    setDraft(next);
    for (const [key, value] of Object.entries(updates)) {
      pending.current.set(Number(key), value);
    }
  }

  function applyPeakXY(id: PeakBand, freq: number, gain: number) {
    const next = clampPeak(id, freq, gain, peakOf(draftRef.current, id).q);
    if (id === "low") {
      patchLocal({ [PARAM.LowFreq]: next.freq, [PARAM.LowGain]: next.gain });
    } else if (id === "mid") {
      patchLocal({ [PARAM.MidFreq]: next.freq, [PARAM.MidGain]: next.gain });
    } else {
      patchLocal({ [PARAM.HighFreq]: next.freq, [PARAM.HighGain]: next.gain });
    }
  }

  function applyPeakQ(id: PeakBand, q: number) {
    const cur = peakOf(draftRef.current, id);
    const next = clampPeak(id, cur.freq, cur.gain, q);
    if (id === "low") {
      patchLocal({ [PARAM.LowQ]: next.q });
    } else if (id === "mid") {
      patchLocal({ [PARAM.MidQ]: next.q });
    } else {
      patchLocal({ [PARAM.HighQ]: next.q });
    }
  }

  function applyDrag(handle: HandleId, clientX: number, clientY: number) {
    const el = plotRef.current;
    if (!el) {
      return;
    }
    const box = el.getBoundingClientRect();
    const freq = xToFreq(clientX - box.left, box.width);
    const gain = yToGain(clientY - box.top, box.height);
    if (handle === "lowCut") {
      patchLocal({ [PARAM.LowCut]: clampLowCut(freq) });
      return;
    }
    if (handle === "highCut") {
      patchLocal({ [PARAM.HighCut]: clampHighCut(freq) });
      return;
    }
    applyPeakXY(handle, freq, gain);
  }

  function hitHandle(clientX: number, clientY: number): HandleId | null {
    const el = plotRef.current;
    if (!el) {
      return null;
    }
    const box = el.getBoundingClientRect();
    let best: HandleId | null = null;
    let bestD = HIT_PX;
    for (const id of HANDLES) {
      const hx = box.left + freqToX(handleFreq(draft, id), box.width);
      const hy = box.top + gainToY(handleGain(draft, id), box.height);
      const d = Math.hypot(clientX - hx, clientY - hy);
      if (d <= bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  function onPointerDown(ev: ReactPointerEvent<SVGSVGElement>) {
    ev.preventDefault();
    gesturing.current = true;
    (ev.currentTarget as SVGSVGElement).setPointerCapture(ev.pointerId);
    pointers.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.current.size === 1) {
      const handle = hitHandle(ev.clientX, ev.clientY);
      if (handle) {
        setSelected(handle);
        selectedRef.current = handle;
        dragRef.current = { handle, pointerId: ev.pointerId };
      }
      pinchRef.current = null;
      return;
    }
    const sel = selectedRef.current;
    if (pointers.current.size >= 2 && isPeakBand(sel)) {
      dragRef.current = null;
      const pts = [...pointers.current.values()];
      pinchRef.current = {
        startDist: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
        startQ: peakOf(draftRef.current, sel).q,
      };
    }
  }

  function onPointerMove(ev: ReactPointerEvent<SVGSVGElement>) {
    if (!pointers.current.has(ev.pointerId)) {
      return;
    }
    ev.preventDefault();
    pointers.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const pinch = pinchRef.current;
    const sel = selectedRef.current;
    if (pinch && pointers.current.size >= 2 && isPeakBand(sel)) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const q = pinch.startQ * (dist / pinch.startDist);
      applyPeakQ(sel, q);
      return;
    }
    const drag = dragRef.current;
    if (drag && drag.pointerId === ev.pointerId) {
      applyDrag(drag.handle, ev.clientX, ev.clientY);
    }
  }

  function onPointerUp(ev: ReactPointerEvent<SVGSVGElement>) {
    pointers.current.delete(ev.pointerId);
    if (dragRef.current?.pointerId === ev.pointerId) {
      dragRef.current = null;
    }
    if (pointers.current.size < 2) {
      pinchRef.current = null;
    }
    if (pointers.current.size === 0) {
      commit();
      gesturing.current = false;
    }
  }

  const { w, h } = size;
  const curve = dbs
    .map((db, i) => {
      const x = (i / (dbs.length - 1)) * w;
      const y = gainToY(clampGainPlot(db), h);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className="eq-overlay" role="dialog" aria-modal="true" aria-label="Parametric EQ graph" data-testid="eq-overlay">
      <header className="eq-overlay-head">
        <div className="eq-overlay-copy">
          <h2>Parametric</h2>
          <p className="eq-readout" data-testid="eq-readout">
            {readout(draft, selected)}
          </p>
        </div>
        <button
          type="button"
          className="eq-overlay-close"
          data-testid="eq-graph-close"
          aria-label="Close EQ graph"
          onClick={onClose}
        >
          Close
        </button>
      </header>
      <p className="eq-rotate-hint">Rotate for more room</p>
      <svg
        ref={plotRef}
        className="eq-plot"
        data-testid="eq-plot"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {GRID_HZ.map((hz) => {
          const x = freqToX(hz, w);
          const major = hz === 20 || hz === 100 || hz === 1000 || hz === 10000 || hz === 20000;
          return (
            <line
              key={hz}
              x1={x}
              y1={0}
              x2={x}
              y2={h}
              className={major ? "eq-grid-major" : "eq-grid"}
            />
          );
        })}
        {GRID_DB.map((db) => {
          const y = gainToY(db, h);
          return (
            <line
              key={db}
              x1={0}
              y1={y}
              x2={w}
              y2={y}
              className={db === 0 ? "eq-grid-zero" : "eq-grid"}
            />
          );
        })}
        <path d={curve} className="eq-curve" />
        {HANDLES.map((id) => {
          const x = freqToX(handleFreq(draft, id), w);
          const y = gainToY(handleGain(draft, id), h);
          const off =
            (id === "lowCut" && isLowCutOff(draft.lowCut)) ||
            (id === "highCut" && isHighCutOff(draft.highCut));
          const cut = id === "lowCut" || id === "highCut";
          const on = selected === id;
          return (
            <g
              key={id}
              className={`eq-handle${off ? " is-off" : ""}${on ? " is-on" : ""}`}
              data-testid={`eq-handle-${id}`}
              transform={`translate(${x} ${y})`}
            >
              <circle className="eq-handle-hit" r={HIT_PX} />
              {cut ? (
                <rect className="eq-handle-mark" x={-HANDLE_R} y={-HANDLE_R} width={HANDLE_R * 2} height={HANDLE_R * 2} />
              ) : (
                <circle className="eq-handle-mark" r={HANDLE_R} fill={EQ_YELLOW} />
              )}
            </g>
          );
        })}
      </svg>
      <div className="eq-axis eq-axis-x" aria-hidden>
        <span>{formatHz(FREQ_MIN)}</span>
        <span>1 kHz</span>
        <span>{formatHz(FREQ_MAX)}</span>
      </div>
    </div>
  );
}

function clampGainPlot(db: number): number {
  if (db < GAIN_MIN) {
    return GAIN_MIN;
  }
  if (db > GAIN_MAX) {
    return GAIN_MAX;
  }
  return db;
}

function readout(state: EqState, selected: HandleId): string {
  if (selected === "lowCut") {
    return `Low Cut  ${formatCut(state.lowCut, "low")}`;
  }
  if (selected === "highCut") {
    return `High Cut  ${formatCut(state.highCut, "high")}`;
  }
  const p = state[selected];
  return `${handleLabel(selected)}  ${formatHz(p.freq)}  Q ${formatQ(p.q)}  ${formatDb(p.gain)}`;
}

function flushPending(
  dump: DumpBlock,
  batch: Map<number, number>,
  client: BridgeClient,
  setError: (msg: string | null) => void,
) {
  for (const [param, float] of batch) {
    client
      .request({
        op: "set_param",
        block: dump.block,
        param,
        subslot: dump.subslot,
        float,
      })
      .catch((err: unknown) => {
        setError(err instanceof BridgeError ? err.message : String(err));
      });
  }
}
