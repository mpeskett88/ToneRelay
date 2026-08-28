import {
  blockMeta,
  categoryOf,
  dumpCategory,
  dumpModelId,
  type BlockCategory,
  type DumpBlock,
} from "./catalog";

export type ChainNode = {
  id: string;
  title: string;
  category: BlockCategory;
  model: string;
  enabled: boolean;
  stereo?: boolean;
  dumps: DumpBlock[];
};

export type CellRole = "io" | "effect";

export type ChainCell = {
  slot: number;
  empty: boolean;
  role: CellRole;
  node: ChainNode | null;
};

export type JunctionPoint = {
  usb: number;
  beforeLocal: number;
  node: ChainNode;
};

export type DspBoard = {
  dsp: number;
  id: string;
  labelA: string;
  labelB: string;
  input: ChainCell;
  output: ChainCell;
  rowA: ChainCell[];
  rowB: ChainCell[] | null;
  split: JunctionPoint | null;
  merge: JunctionPoint | null;
};

export type TopoLane = {
  branch: number;
  blocks: number[];
  span?: [number, number];
};

export type TopoPath = {
  id: number;
  input?: number | null;
  output?: number | null;
  split?: number | null;
  join?: number | null;
  split_at?: number | null;
  join_at?: number | null;
  head?: number[];
  tail?: number[];
  lanes?: TopoLane[];
};

function localSlot(block: number): number {
  return block % 20;
}

function pathIndex(block: number): number {
  return Math.floor(block / 20);
}

function isSplit(b: DumpBlock): boolean {
  return b.kind === 2 && b.subslot === 0;
}

function isMerge(b: DumpBlock): boolean {
  return b.kind === 3 && b.subslot === 0;
}

/** Parked split/merge sit on USB 10/19 and expose Path 1B I/O on subslot 1. */
export function isParkedSplitMerge(b: DumpBlock, all: DumpBlock[]): boolean {
  if (isSplit(b) && b.block === 10) {
    return all.some((x) => x.block === 10 && x.subslot === 1);
  }
  if (isMerge(b) && b.block === 19) {
    return all.some((x) => x.block === 19 && x.subslot === 1);
  }
  return false;
}

function lookupModel(b: DumpBlock): string {
  return dumpModelId(b);
}

function nodeTitle(dumps: DumpBlock[], category: BlockCategory): string {
  if (dumps.length > 1 && category === "cab") {
    return "Cab";
  }
  const live = dumps[0].model_name;
  const meta = blockMeta(dumps[0].block, dumps[0].subslot);
  const title = live ?? meta?.title ?? `Slot ${dumps[0].block}`;
  if (title.endsWith(" Input") || title === "Input") {
    return "Input";
  }
  if (title.endsWith(" Output") || title === "Output") {
    return "Output";
  }
  return title;
}

function toNode(dumps: DumpBlock[]): ChainNode {
  const model = lookupModel(dumps[0]) || lookupModel(dumps[dumps.length - 1]);
  const category = dumpCategory(dumps[0]) ?? categoryOf(model || "fx");
  return {
    id: dumps.map((d) => `${d.block}:${d.subslot}`).join("+"),
    title: nodeTitle(dumps, category),
    category,
    model,
    enabled: dumps.every((d) => d.enabled !== false),
    stereo: dumps[0].stereo,
    dumps,
  };
}

export function nodeIdForUsb(blocks: DumpBlock[], usb: number): string | null {
  const dumps = dumpsAt(blocks, usb);
  if (dumps.length === 0) {
    return null;
  }
  return dumps.map((d) => `${d.block}:${d.subslot}`).join("+");
}

function dumpsAt(blocks: DumpBlock[], slot: number, subslot?: number): DumpBlock[] {
  return blocks
    .filter((b) => b.block === slot && (subslot === undefined || b.subslot === subslot))
    .sort((a, b) => a.subslot - b.subslot);
}

function dspHasEffects(blocks: DumpBlock[], dsp: number): boolean {
  return blocks.some((b) => {
    if (pathIndex(b.block) !== dsp) {
      return false;
    }
    const loc = localSlot(b.block);
    return (loc >= 1 && loc <= 8) || (loc >= 11 && loc <= 18);
  });
}

function attachLocal(path: TopoPath | undefined, which: "split" | "join"): number | null {
  const named = which === "split" ? path?.split_at : path?.join_at;
  if (typeof named === "number") {
    return ((named % 20) + 20) % 20;
  }
  const upper = path?.lanes?.find((lane) => lane.branch === 0);
  if (upper?.span && upper.span.length === 2) {
    const v = which === "split" ? upper.span[0] : upper.span[1];
    return ((v % 20) + 20) % 20;
  }
  if (which === "split") {
    if (upper?.blocks[0] != null) {
      return localSlot(upper.blocks[0]);
    }
    if (path?.tail?.[0] != null) {
      return localSlot(path.tail[0]);
    }
    return 9;
  }
  if (path?.tail?.[0] != null) {
    return localSlot(path.tail[0]);
  }
  return 9;
}

function isParkedAttach(local: number): boolean {
  return local === 0 || local === 10 || local === 19;
}

function isSplitLive(blocks: DumpBlock[], path: TopoPath | undefined, dsp: number): boolean {
  const hasB = blocks.some((b) => pathIndex(b.block) === dsp && localSlot(b.block) >= 11 && localSlot(b.block) <= 18);
  if (hasB) {
    return true;
  }
  if (path?.lanes?.some((lane) => lane.branch > 0 && lane.blocks.length > 0)) {
    return true;
  }
  const explicit = path?.split_at ?? path?.lanes?.find((lane) => lane.branch === 0)?.span?.[0];
  if (typeof explicit === "number") {
    return !isParkedAttach(((explicit % 20) + 20) % 20);
  }
  const split = blocks.find((b) => b.block === dsp * 20 + 10 && b.subslot === 0 && isSplit(b));
  if (!split) {
    return false;
  }
  return !isParkedSplitMerge(split, blocks);
}

function effectDumps(blocks: DumpBlock[], slot: number): DumpBlock[] {
  return dumpsAt(blocks, slot).filter((b) => {
    if (isSplit(b) || isMerge(b)) {
      return false;
    }
    const loc = localSlot(slot);
    if (b.subslot === 1 && (loc === 10 || loc === 19)) {
      return false;
    }
    return true;
  });
}

function effectCell(blocks: DumpBlock[], slot: number): ChainCell {
  const dumps = effectDumps(blocks, slot);
  if (dumps.length === 0) {
    return { slot, empty: true, role: "effect", node: null };
  }
  return { slot, empty: false, role: "effect", node: toNode(dumps) };
}

function ioCell(blocks: DumpBlock[], slot: number): ChainCell {
  const dumps = dumpsAt(blocks, slot, 0);
  if (dumps.length === 0) {
    const kind = localSlot(slot) === 0 ? 0 : 1;
    return {
      slot,
      empty: false,
      role: "io",
      node: toNode([{ block: slot, subslot: 0, kind, params: [] }]),
    };
  }
  return { slot, empty: false, role: "io", node: toNode(dumps) };
}

function junctionNode(blocks: DumpBlock[], usb: number, kind: 2 | 3): ChainNode {
  const dumps = dumpsAt(blocks, usb, 0);
  if (dumps.length > 0) {
    return toNode(dumps);
  }
  return toNode([{ block: usb, subslot: 0, kind, params: [], model_name: kind === 2 ? "Split" : "Merge" }]);
}

/** CSS grid column (1-based, including the path label) for the gap before this A-path slot. */
export function gridWireBefore(beforeLocal: number): number {
  if (beforeLocal >= 9) {
    return 19;
  }
  if (beforeLocal <= 1) {
    return 3;
  }
  return 1 + beforeLocal * 2;
}

/** CSS grid column for effect slot 1–8. */
export function gridSlotCol(local1to8: number): number {
  return 2 + local1to8 * 2;
}

/** Column for an A-path (1–8) or B-path (11–18) USB slot. */
export function gridSlotColFromUsb(slot: number): number {
  let loc = ((slot % 20) + 20) % 20;
  if (loc >= 11 && loc <= 18) {
    loc -= 10;
  }
  return gridSlotCol(loc);
}

/** Effect/empty slots only; Input/Output/Split/Join stay put. Same DSP. */
export function canMoveSlot(from: number, to: number): boolean {
  if (from === to || from < 0 || to < 0 || from > 39 || to > 39) {
    return false;
  }
  if (Math.floor(from / 20) !== Math.floor(to / 20)) {
    return false;
  }
  const local = (n: number) => n % 20;
  for (const slot of [from, to]) {
    if ([0, 9, 10, 19].includes(local(slot))) {
      return false;
    }
  }
  return true;
}

export type XY = { x: number; y: number };

/** SVG path for a polyline with quadratic rounded corners. */
export function roundPolyline(pts: XY[], radius: number): string {
  if (pts.length === 0) {
    return "";
  }
  if (pts.length < 3) {
    return `M ${pts[0].x} ${pts[0].y}` + (pts[1] ? ` L ${pts[1].x} ${pts[1].y}` : "");
  }
  const parts: string[] = [`M ${pts[0].x} ${pts[0].y}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const dx1 = cur.x - prev.x;
    const dy1 = cur.y - prev.y;
    const dx2 = next.x - cur.x;
    const dy2 = next.y - cur.y;
    const len1 = Math.hypot(dx1, dy1);
    const len2 = Math.hypot(dx2, dy2);
    if (len1 < 0.5 || len2 < 0.5) {
      parts.push(`L ${cur.x} ${cur.y}`);
      continue;
    }
    const cross = (dx1 * dy2 - dy1 * dx2) / (len1 * len2);
    if (Math.abs(cross) < 0.04) {
      continue;
    }
    const r = Math.min(radius, len1 / 2, len2 / 2);
    parts.push(`L ${cur.x - (dx1 / len1) * r} ${cur.y - (dy1 / len1) * r}`);
    parts.push(`Q ${cur.x} ${cur.y} ${cur.x + (dx2 / len2) * r} ${cur.y + (dy2 / len2) * r}`);
  }
  const last = pts[pts.length - 1];
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}

export function boardNodes(board: DspBoard): ChainNode[] {
  return [
    board.input.node,
    ...board.rowA.map((c) => c.node),
    board.split?.node ?? null,
    board.merge?.node ?? null,
    ...(board.rowB ?? []).map((c) => c.node),
    board.output.node,
  ].filter((n): n is ChainNode => n != null);
}

/**
 * One DSP: Input, eight A cells, Output, optional eight B cells.
 * Live split/merge are attach points on the A wire, not extra tiles.
 */
export function buildChain(blocks: DumpBlock[], paths?: TopoPath[]): DspBoard[] {
  const boards: DspBoard[] = [];
  for (const dsp of [0, 1]) {
    if (dsp === 1 && !dspHasEffects(blocks, 1)) {
      continue;
    }
    const topo = paths && paths.length > dsp ? paths[dsp] : undefined;
    const live = isSplitLive(blocks, topo, dsp);
    const base = dsp * 20;
    const n = dsp + 1;
    let split: JunctionPoint | null = null;
    let merge: JunctionPoint | null = null;
    if (live) {
      const splitLocal = attachLocal(topo, "split") ?? 9;
      const joinLocal = attachLocal(topo, "join") ?? 9;
      if (!isParkedAttach(splitLocal)) {
        split = {
          usb: topo?.split ?? base + 10,
          beforeLocal: Math.min(9, Math.max(1, splitLocal)),
          node: junctionNode(blocks, topo?.split ?? base + 10, 2),
        };
      }
      if (!isParkedAttach(joinLocal)) {
        merge = {
          usb: topo?.join ?? base + 19,
          beforeLocal: Math.min(9, Math.max(1, joinLocal)),
          node: junctionNode(blocks, topo?.join ?? base + 19, 3),
        };
      }
    }
    boards.push({
      dsp,
      id: `path${n}`,
      labelA: `${n}A`,
      labelB: `${n}B`,
      input: ioCell(blocks, base),
      output: ioCell(blocks, base + 9),
      rowA: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => effectCell(blocks, base + i)),
      rowB: live ? [11, 12, 13, 14, 15, 16, 17, 18].map((i) => effectCell(blocks, base + i)) : null,
      split,
      merge,
    });
  }
  return boards;
}
