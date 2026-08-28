import { describe, expect, it } from "vitest";
import { buildChain, canMoveSlot, gridWireBefore, isParkedSplitMerge, nodeIdForUsb, roundPolyline } from "./chain";
import type { DumpBlock } from "./catalog";

function blk(block: number, subslot = 0, extra: Partial<DumpBlock> = {}): DumpBlock {
  return { block, subslot, params: [0], ...extra };
}

const essex: DumpBlock[] = [
  blk(0),
  blk(1),
  blk(2),
  blk(3),
  blk(4),
  blk(5),
  blk(6, 0),
  blk(6, 1),
  blk(7),
  blk(9),
  blk(10, 0, { kind: 2 }),
  blk(10, 1),
  blk(19, 0, { kind: 3 }),
  blk(19, 1),
  blk(20),
  blk(29),
];

describe("buildChain", () => {
  it("essex parked split has 8 upper cells, no 1B, no Path 2", () => {
    const boards = buildChain(essex);
    expect(boards.map((b) => b.id)).toEqual(["path1"]);
    expect(boards[0].rowA.map((c) => c.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(boards[0].rowB).toBeNull();
    expect(boards[0].split).toBeNull();
    expect(boards[0].rowA.find((c) => c.slot === 8)?.empty).toBe(true);
    expect(nodeIdForUsb(essex, 4)).toBe("4:0");
    expect(nodeIdForUsb(essex, 6)).toBe("6:0+6:1");
    expect(boards[0].rowA.filter((c) => !c.empty).map((c) => c.node?.title)).toEqual([
      "Wah UK 846",
      "Volume",
      "Deranged Master",
      "Essex A30",
      "60s Bias Trem",
      "Cab",
      "Dynamic Room",
    ]);
  });

  it("groups dual cab into one cell", () => {
    const cab = buildChain(essex)[0].rowA.find((c) => c.slot === 6);
    expect(cab?.node?.dumps.map((d) => d.subslot)).toEqual([0, 1]);
  });

  it("shows Path 2 with empties 22-28 when an effect occupies slot 21", () => {
    const boards = buildChain([...essex, blk(21)]);
    expect(boards.map((b) => b.id)).toContain("path2");
    const path2 = boards.find((b) => b.id === "path2")!;
    expect(path2.rowA.map((c) => c.slot)).toEqual([21, 22, 23, 24, 25, 26, 27, 28]);
    expect(path2.rowA.filter((c) => c.empty).map((c) => c.slot)).toEqual([22, 23, 24, 25, 26, 27, 28]);
    expect(path2.rowB).toBeNull();
  });

  it("shows Path 1B with gaps when an effect occupies slots 11-18", () => {
    const boards = buildChain([...essex, blk(15), blk(16), blk(17)]);
    expect(boards[0].rowB).not.toBeNull();
    expect(boards[0].rowB!.map((c) => c.slot)).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
    expect(boards[0].rowB!.filter((c) => c.empty).map((c) => c.slot)).toEqual([11, 12, 13, 14, 18]);
  });

  it("marks a bypassed dump as not enabled", () => {
    const boards = buildChain([
      blk(0, 0, { kind: 0 }),
      blk(3, 0, { enabled: false, model_name: "Deranged Master" }),
      blk(9, 0, { kind: 1 }),
    ]);
    expect(boards[0].rowA.find((c) => c.slot === 3)?.node?.enabled).toBe(false);
    expect(boards[0].input.node?.enabled).toBe(true);
  });

  it("uses live model_name when present", () => {
    const boards = buildChain([
      blk(0, 0, { kind: 0, model_name: "Input" }),
      blk(4, 0, { model_id: "HD2_AmpFoo", model_name: "German Mahadeva", category: "Amp" }),
      blk(9, 0, { kind: 1, model_name: "Output" }),
    ]);
    expect(boards[0].input.node?.title).toBe("Input");
    expect(boards[0].rowA.find((c) => c.slot === 4)?.node?.title).toBe("German Mahadeva");
    expect(boards[0].rowA.find((c) => c.slot === 4)?.node?.category).toBe("amp");
  });

  it("uses TonePush paths only to detect parked split, not to pack head", () => {
    const paths = [
      {
        id: 1,
        input: 0,
        output: 9,
        split: 10,
        join: 19,
        head: [1, 2, 3, 4, 5, 6, 7],
        tail: [],
        lanes: [],
      },
      { id: 2, input: 20, output: 29, split: null, join: null, head: [], tail: [], lanes: [] },
    ];
    const boards = buildChain(essex, paths);
    expect(boards.map((b) => b.id)).toEqual(["path1"]);
    expect(boards[0].rowA).toHaveLength(8);
    expect(boards[0].split).toBeNull();
    expect(boards[0].rowB).toBeNull();
  });

  it("places live split/merge as attach points, not extra cells", () => {
    const blocks = [
      blk(0, 0, { kind: 0, model_name: "Input" }),
      blk(1, 0, { model_name: "Wah" }),
      blk(6, 0, { model_name: "Amp", category: "Amp" }),
      blk(9, 0, { kind: 1, model_name: "Output" }),
      blk(10, 0, { kind: 2, model_name: "Split" }),
      blk(17, 0, { model_name: "Reverb", category: "Reverb" }),
      blk(19, 0, { kind: 3, model_name: "Merge" }),
    ];
    const paths = [
      {
        id: 1,
        input: 0,
        output: 9,
        split: 10,
        join: 19,
        split_at: 7,
        join_at: 7,
        head: [1, 6],
        tail: [],
        lanes: [
          { branch: 0, blocks: [], span: [7, 7] as [number, number] },
          { branch: 1, blocks: [17], span: [11, 19] as [number, number] },
        ],
      },
    ];
    const boards = buildChain(blocks, paths);
    expect(boards[0].rowA.map((c) => c.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(boards[0].split?.beforeLocal).toBe(7);
    expect(boards[0].merge?.beforeLocal).toBe(7);
    expect(gridWireBefore(7)).toBe(15);
    expect(boards[0].rowB?.filter((c) => !c.empty).map((c) => c.node?.title)).toEqual(["Reverb"]);
  });

  it("places Path 2 split and merge on each side of local slot 5", () => {
    const blocks = [
      blk(20, 0, { kind: 0 }),
      blk(25, 0, { model_name: "US Deluxe Vib", category: "Amp" }),
      blk(29, 0, { kind: 1 }),
      blk(30, 0, { kind: 2 }),
      blk(35, 0, { model_name: "Delay", category: "Delay" }),
      blk(39, 0, { kind: 3 }),
    ];
    const paths = [
      { id: 1, input: 0, output: 9, head: [], tail: [], lanes: [] },
      {
        id: 2,
        input: 20,
        output: 29,
        split: 30,
        join: 39,
        split_at: 5,
        join_at: 6,
        lanes: [
          { branch: 0, blocks: [], span: [5, 6] as [number, number] },
          { branch: 1, blocks: [35], span: [31, 39] as [number, number] },
        ],
      },
    ];
    const boards = buildChain(blocks, paths);
    const path2 = boards.find((b) => b.dsp === 1)!;
    expect(path2.split?.beforeLocal).toBe(5);
    expect(path2.merge?.beforeLocal).toBe(6);
    expect(gridWireBefore(5)).toBe(11);
    expect(gridWireBefore(6)).toBe(13);
    expect(path2.rowA.find((c) => c.slot === 25)?.node?.title).toBe("US Deluxe Vib");
  });
});

describe("isParkedSplitMerge", () => {
  it("treats USB 10 kind 2 with subslot 1 as parked", () => {
    expect(isParkedSplitMerge(essex[10], essex)).toBe(true);
    expect(isParkedSplitMerge(essex[12], essex)).toBe(true);
  });
});

describe("roundPolyline", () => {
  it("rounds a right-angle corner", () => {
    const d = roundPolyline(
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
      ],
      4,
    );
    expect(d.startsWith("M 0 0")).toBe(true);
    expect(d).toContain("Q 0 10");
    expect(d.endsWith("L 10 10")).toBe(true);
  });

  it("keeps a straight vertical without rounding", () => {
    const d = roundPolyline(
      [
        { x: 10, y: 0 },
        { x: 10, y: 20 },
        { x: 10, y: 40 },
      ],
      8,
    );
    expect(d).toBe("M 10 0 L 10 40");
    expect(d.includes("Q")).toBe(false);
  });
});

describe("canMoveSlot", () => {
  it("allows effect-to-empty on one DSP", () => {
    expect(canMoveSlot(7, 8)).toBe(true);
    expect(canMoveSlot(7, 21)).toBe(false);
    expect(canMoveSlot(7, 9)).toBe(false);
  });
});
