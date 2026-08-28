import { describe, expect, it } from "vitest";
import { createGattReassembler, encodeGattChunks, rememberedTransport } from "./bridge";
import { bankPreset, canPickModel, categoryOf, categoryPaint, categoryTitle, choiceIndex, dspHeadroom, dspRefuseMessage, dumpCategory, hxCategoryKind, knobToParam, modelFits, paramLabel, uiToWire, usesChoiceSegment, wireToUi, type DumpBlock } from "./catalog";

describe("GATT chunks", () => {
  it("round-trips a payload larger than one chunk", () => {
    const payload = new TextEncoder().encode(`{"ok":true,"op":"ping","${"a".repeat(200)}":true}`);
    const chunks = encodeGattChunks(payload);
    expect(chunks.length).toBeGreaterThan(1);
    const asm = createGattReassembler();
    let done: Uint8Array | null = null;
    for (const c of chunks) {
      done = asm.push(c);
    }
    expect(done).not.toBeNull();
    expect(new TextDecoder().decode(done!)).toBe(new TextDecoder().decode(payload));
  });

  it("marks first and last flags", () => {
    const chunks = encodeGattChunks(new TextEncoder().encode("{}"));
    expect(chunks[0][0] & 0x01).toBe(1);
    expect(chunks[chunks.length - 1][0] & 0x02).toBe(2);
  });
});

describe("transport memory", () => {
  it("returns null when localStorage is missing", () => {
    expect(rememberedTransport()).toBeNull();
  });
});

describe("catalog helpers", () => {
  it("maps Drive UI 4.1 to wire 0.41", () => {
    expect(uiToWire(4.1, "ui10")).toBeCloseTo(0.41);
    expect(wireToUi(0.41, "ui10")).toBeCloseTo(4.1);
  });

  it("maps preset index 17 to bank 1 slot 1", () => {
    expect(bankPreset(17)).toEqual({ bank: 1, preset: 1 });
  });

  it("maps Helix model names to chain categories", () => {
    expect(categoryOf("HD2_AmpEssexA30")).toBe("amp");
    expect(categoryOf("HD2_Tremolo60sBiasTrem")).toBe("modulation");
    expect(categoryOf("HD2_AppDSPFlowSplitY")).toBe("split");
  });

  it("turns catalog param ids into labels", () => {
    expect(paramLabel("noiseGate")).toBe("Noise Gate");
    expect(paramLabel("threshold")).toBe("Threshold");
    expect(paramLabel("VolumeTaper")).toBe("Volume Taper");
    expect(paramLabel("A Level")).toBe("A Level");
  });

  it("maps enum wire values onto catalog menus", () => {
    expect(choiceIndex(3, 6)).toBe(3);
    expect(choiceIndex(3.2, 6)).toBe(3);
    expect(choiceIndex(true, 2)).toBe(1);
    expect(choiceIndex(false, 2)).toBe(0);
    expect(choiceIndex(-1, 4)).toBe(0);
    expect(choiceIndex(99, 4)).toBe(3);
    expect(usesChoiceSegment(6)).toBe(true);
    expect(usesChoiceSegment(7)).toBe(false);
    expect(usesChoiceSegment(0)).toBe(false);
    const param = knobToParam({
      index: 1,
      name: "Ratio",
      usb: "int",
      kind: "enum",
      choices: ["2:1", "3:1", "4:1", "6:1", "10:1", "20:1"],
      label: "6:1",
    });
    expect(param.choices?.[3]).toBe("6:1");
    expect(param.label).toBe("6:1");
  });

  it("uses saturated category fills for chain tiles", () => {
    expect(categoryPaint("drive").bg).toBe("#ff9a3a");
    expect(categoryPaint("delay").bg).toBe("#2ee67a");
    expect(categoryPaint("reverb").bg).toBe("#ff6e45");
    expect(categoryPaint("amp").bg).toBe("#ff5c5c");
    expect(categoryPaint("amp").fg).toBe("#061018");
    expect(categoryPaint("delay").fg).toBe("#061018");
    expect(categoryTitle("drive")).toBe("Distortion");
    expect(categoryPaint("ir").bg).toBe("#ff6eb4");
    expect(categoryTitle("compression")).toBe("Dynamics");
    expect(dumpCategory({ block: 1, subslot: 0, params: [], category: "Dynamics" })).toBe("compression");
    expect(dumpCategory({ block: 1, subslot: 0, params: [], category: "IR" })).toBe("ir");
    expect(hxCategoryKind("Distortion")).toBe("drive");
    expect(canPickModel("drive")).toBe(true);
    expect(canPickModel("input")).toBe(false);
    expect(dspRefuseMessage("the device refused: error -306")).toBe("Not enough DSP for that model.");
  });

  it("credits the replaced block when gating DSP", () => {
    const blocks: DumpBlock[] = [
      { block: 1, subslot: 0, params: [], load: 40 },
      { block: 3, subslot: 0, params: [], load: 20 },
      { block: 21, subslot: 0, params: [], load: 90 },
    ];
    const dump: DumpBlock[] = [{ block: 3, subslot: 0, params: [], load: 20 }];
    expect(dspHeadroom(blocks, dump)).toBe(60);
    expect(modelFits({ id: "a", name: "A", load: 50 }, 60)).toBe(true);
    expect(modelFits({ id: "b", name: "B", load: 70 }, 60)).toBe(false);
    expect(modelFits({ id: "c", name: "C" }, 1)).toBe(true);
    expect(dspHeadroom(blocks, [{ block: 8, subslot: 0, params: [] }])).toBe(40);
    expect(modelFits({ id: "s", name: "S", load: 10, load_stereo: 50 }, 40, true)).toBe(false);
    expect(modelFits({ id: "s", name: "S", load: 10, load_stereo: 50 }, 40, false)).toBe(true);
  });
});
