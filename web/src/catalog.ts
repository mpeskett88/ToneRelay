export type CatalogParam = {
  name: string;
  index: number;
  usb: "f32" | "bool" | "u8" | "int";
  source: string;
  notes?: string;
  min?: number;
  max?: number;
  kind?: string;
  label?: string;
  choices?: string[];
};

export type KnobMeta = {
  index: number;
  id?: string;
  name: string;
  kind?: string;
  usb: "f32" | "bool" | "u8" | "int";
  min?: number;
  max?: number;
  display?: string;
  label?: string;
  choices?: string[];
};

export type CatalogModel = {
  params: CatalogParam[];
};

export type Catalog = Record<string, CatalogModel>;

export type ModelPick = {
  id: string;
  name: string;
  load?: number;
  load_stereo?: number;
};

export type ModelShelf = {
  name: string;
  models: ModelPick[];
};

export type ModelCategory = {
  id: number;
  name: string;
  short_name?: string;
  colour?: string;
  paired: boolean;
  models: ModelPick[];
  shelves?: ModelShelf[];
};

export type DumpBlock = {
  block: number;
  subslot: number;
  kind?: number | null;
  params: Array<number | boolean>;
  assign?: number;
  model?: number;
  model_id?: string;
  model_name?: string;
  category?: string;
  knobs?: KnobMeta[];
  enabled?: boolean;
  stereo?: boolean;
  assign_label?: string;
  assign_menu?: Array<{ value: number; label: string }>;
  load?: number;
};

export type BlockCategory =
  | "input"
  | "output"
  | "wah"
  | "volume"
  | "drive"
  | "amp"
  | "cab"
  | "modulation"
  | "delay"
  | "reverb"
  | "compression"
  | "eq"
  | "filter"
  | "split"
  | "merge"
  | "ir"
  | "fx";

/**
 * Saturated HX Edit category hues on the cool chassis. Input/output stay
 * graphite so they read as path jacks, not effects.
 */
export const CATEGORY_FILL: Record<BlockCategory, string> = {
  drive: "#ff9a3a",
  compression: "#e8d020",
  eq: "#e8d020",
  modulation: "#3db4ff",
  delay: "#2ee67a",
  reverb: "#ff6e45",
  filter: "#c084ff",
  wah: "#b56bff",
  amp: "#ff5c5c",
  cab: "#ff5c5c",
  ir: "#ff6eb4",
  volume: "#2ad4c6",
  split: "#2ad4c6",
  merge: "#2ad4c6",
  fx: "#8a9aa3",
  input: "#0c1218",
  output: "#0c1218",
};

export type CategoryPaint = { bg: string; fg: string; bd: string };

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG-ish luminance */
function relativeLuminance(hex: string): number {
  const lin = hexRgb(hex).map((c) => {
    const t = c / 255;
    return t <= 0.03928 ? t / 12.92 : ((t + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function categoryPaint(category: BlockCategory): CategoryPaint {
  const bg = CATEGORY_FILL[category];
  const [r, g, b] = hexRgb(bg);
  const bd = `#${[r, g, b].map((c) => Math.round(0.75 * c).toString(16).padStart(2, "0")).join("")}`;
  if (category === "input" || category === "output") {
    return { bg, fg: "#d7f0ea", bd: "#1a2e36" };
  }
  return { bg, fg: relativeLuminance(bg) > 0.22 ? "#061018" : "#d7f0ea", bd };
}

export function categoryTitle(category: BlockCategory): string {
  switch (category) {
    case "drive":
      return "Distortion";
    case "compression":
      return "Dynamics";
    case "eq":
      return "EQ";
    case "modulation":
      return "Modulation";
    case "delay":
      return "Delay";
    case "reverb":
      return "Reverb";
    case "filter":
      return "Filter";
    case "wah":
      return "Wah";
    case "volume":
      return "Volume / Pan";
    case "amp":
      return "Amp";
    case "cab":
      return "Cab";
    case "ir":
      return "IR";
    case "input":
      return "Input";
    case "output":
      return "Output";
    case "split":
      return "Split";
    case "merge":
      return "Merge";
    default:
      return "Effect";
  }
}

export type EssexBlock = {
  block: number;
  subslot: number;
  model: string;
  title: string;
};

/** Live-verified Essex A30 path map (USB 98). */
export const ESSEX_BLOCKS: EssexBlock[] = [
  { block: 0, subslot: 0, model: "HD2_AppDSPFlow1Input", title: "Path 1 Input" },
  { block: 1, subslot: 0, model: "HD2_WahUKWah846", title: "Wah UK 846" },
  { block: 2, subslot: 0, model: "HD2_VolPanVol", title: "Volume" },
  { block: 3, subslot: 0, model: "HD2_DistDerangedMaster", title: "Deranged Master" },
  { block: 4, subslot: 0, model: "HD2_AmpEssexA30", title: "Essex A30" },
  { block: 5, subslot: 0, model: "HD2_Tremolo60sBiasTrem", title: "60s Bias Trem" },
  { block: 6, subslot: 0, model: "HD2_CabMicIr_2x12SilverBellWithPan", title: "Cab 1" },
  { block: 6, subslot: 1, model: "HD2_CabMicIr_2x12SilverBellWithPan", title: "Cab 2" },
  { block: 7, subslot: 0, model: "VIC_ReverbDynRoom", title: "Dynamic Room" },
  { block: 9, subslot: 0, model: "HD2_AppDSPFlowOutput", title: "Path 1 Output" },
  { block: 10, subslot: 0, model: "HD2_AppDSPFlowSplitY", title: "Split" },
  { block: 10, subslot: 1, model: "HD2_AppDSPFlow1Input", title: "Path 1B Input" },
  { block: 19, subslot: 0, model: "HD2_AppDSPFlowJoin", title: "Merge" },
  { block: 19, subslot: 1, model: "HD2_AppDSPFlowOutput", title: "Path 1B Output" },
  { block: 20, subslot: 0, model: "HD2_AppDSPFlow1Input", title: "Path 2 Input" },
  { block: 29, subslot: 0, model: "HD2_AppDSPFlowOutput", title: "Path 2 Output" },
];

export type UiScale = "ui10" | "percent" | "raw";

export function uiScale(param: CatalogParam): UiScale {
  const notes = param.notes ?? "";
  if (param.usb === "f32" && (notes.includes("UI/10") || param.name === "Drive" || param.name === "Bass" || param.name === "Treble" || param.name === "Cut" || param.name === "Presence" || param.name === "ChVol" || param.name === "Master" || param.name === "Sag" || param.name === "Hum" || param.name === "Ripple" || param.name === "Bias" || param.name === "BiasX" || param.name === "Intensity" || param.name === "Spread" || param.name === "Speed" || param.name === "MatrFreq")) {
    if (notes.includes("0–1") || notes.includes("0-1")) {
      return "percent";
    }
    if (notes.includes("dB") || notes.includes("Hz") || notes.includes("seconds") || notes.includes("inches") || notes.includes("degrees")) {
      return "raw";
    }
    return "ui10";
  }
  if (notes.includes("0–1") || notes.includes("0-1") || notes.includes("UI Position") || notes.includes("UI %")) {
    return "percent";
  }
  return "raw";
}

export function wireToUi(wire: number, scale: UiScale): number {
  if (scale === "ui10") {
    return wire * 10;
  }
  if (scale === "percent") {
    return wire * 100;
  }
  return wire;
}

export function uiToWire(ui: number, scale: UiScale): number {
  if (scale === "ui10") {
    return ui / 10;
  }
  if (scale === "percent") {
    return ui / 100;
  }
  return ui;
}

export function bankPreset(index: number): { bank: number; preset: number } {
  return { bank: Math.floor(index / 16), preset: index % 16 };
}

export function blockMeta(block: number, subslot: number): EssexBlock | undefined {
  return ESSEX_BLOCKS.find((b) => b.block === block && b.subslot === subslot);
}

export function categoryOf(model: string): BlockCategory {
  const m = model.toLowerCase();
  if (m.includes("split")) {
    return "split";
  }
  if (m.includes("join") || m.includes("merge")) {
    return "merge";
  }
  if (m.includes("input")) {
    return "input";
  }
  if (m.includes("output")) {
    return "output";
  }
  if (m.includes("wah")) {
    return "wah";
  }
  if (m.includes("volpan") || m.includes("volume")) {
    return "volume";
  }
  if (m.includes("dist") || m.includes("overdrive") || m.includes("fuzz")) {
    return "drive";
  }
  if (m.includes("amp")) {
    return "amp";
  }
  if (m.includes("cab") || m.includes("micir")) {
    return "cab";
  }
  if (m.includes("impulse") || m.includes("userir") || m.includes("ir2048")) {
    return "ir";
  }
  if (
    m.includes("trem") ||
    m.includes("chorus") ||
    m.includes("flange") ||
    m.includes("phaser") ||
    m.includes("univibe") ||
    m.includes("rotary")
  ) {
    return "modulation";
  }
  if (m.includes("delay") || m.includes("echo")) {
    return "delay";
  }
  if (m.includes("reverb")) {
    return "reverb";
  }
  if (m.includes("comp")) {
    return "compression";
  }
  if (m.includes("eq")) {
    return "eq";
  }
  if (m.includes("filter") || m.includes("pitch")) {
    return "filter";
  }
  return "fx";
}

/** Turns catalog ids like noiseGate into a short on-screen label. */
export function paramLabel(name: string): string {
  const spaced = name.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  if (!spaced) {
    return name;
  }
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function knobToParam(knob: KnobMeta): CatalogParam {
  return {
    name: knob.name,
    index: knob.index,
    usb: knob.usb,
    source: "live",
    min: knob.min,
    max: knob.max,
    kind: knob.kind,
    label: knob.label,
    choices: knob.choices,
  };
}

/** Wire enum/bool value → 0-based index into a catalog menu. */
export function choiceIndex(raw: number | boolean | undefined, count: number): number {
  if (count <= 0) {
    return 0;
  }
  let n = 0;
  if (typeof raw === "boolean") {
    n = raw ? 1 : 0;
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    n = Math.round(raw);
  }
  if (n < 0) {
    return 0;
  }
  if (n >= count) {
    return count - 1;
  }
  return n;
}

/** Menus this short show as a segmented row; longer lists stay a select. */
export const CHOICE_SEGMENT_MAX = 6;

export function usesChoiceSegment(count: number): boolean {
  return count > 0 && count <= CHOICE_SEGMENT_MAX;
}

export function dumpCategory(block: DumpBlock): BlockCategory | undefined {
  if (block.kind === 0) {
    return "input";
  }
  if (block.kind === 1) {
    return "output";
  }
  if (block.kind === 2) {
    return "split";
  }
  if (block.kind === 3) {
    return "merge";
  }
  const named = (block.category ?? "").toLowerCase();
  if (!named) {
    return undefined;
  }
  if (named.includes("wah")) {
    return "wah";
  }
  if (named.includes("vol")) {
    return "volume";
  }
  if (named.includes("dist") || named.includes("overdrive")) {
    return "drive";
  }
  if (named.includes("amp") || named.includes("preamp")) {
    return "amp";
  }
  if (named.includes("cab")) {
    return "cab";
  }
  if (named.includes("mod") || named.includes("trem") || named.includes("chorus")) {
    return "modulation";
  }
  if (named.includes("delay")) {
    return "delay";
  }
  if (named.includes("reverb") || named === "verb") {
    return "reverb";
  }
  if (named.includes("dyn") || named.includes("comp")) {
    return "compression";
  }
  if (named === "eq" || named.includes("equal")) {
    return "eq";
  }
  if (named.includes("filter") || named.includes("pitch")) {
    return "filter";
  }
  if (named === "ir" || named.includes("impulse")) {
    return "ir";
  }
  return undefined;
}

export function dumpModelId(block: DumpBlock): string {
  return block.model_id ?? blockMeta(block.block, block.subslot)?.model ?? "";
}

export function canPickModel(category: BlockCategory): boolean {
  return category !== "input" && category !== "output" && category !== "split" && category !== "merge";
}

export function hxCategoryKind(name: string): BlockCategory {
  return dumpCategory({ block: 0, subslot: 0, params: [], category: name }) ?? "fx";
}

export function dspRefuseMessage(error: string): string {
  if (error.includes("-306")) {
    return "Not enough DSP for that model.";
  }
  return error;
}

/** Helix path DSP budget, as HX Edit percent. Catalog `load` uses the same units. */
export const DSP_CAPACITY = 100;

export function dspIndex(block: number): number {
  return Math.floor(block / 20);
}

export function dspUsed(blocks: DumpBlock[], dsp: number): number {
  return blocks.reduce((sum, b) => {
    if (dspIndex(b.block) !== dsp) {
      return sum;
    }
    return sum + (typeof b.load === "number" && b.load > 0 ? b.load : 0);
  }, 0);
}

export function slotCredit(dumps: DumpBlock[]): number {
  return dumps.reduce((sum, d) => sum + (typeof d.load === "number" && d.load > 0 ? d.load : 0), 0);
}

/** Remaining DSP on this path after removing the block being replaced. */
export function dspHeadroom(blocks: DumpBlock[], dumps: DumpBlock[]): number {
  const block = dumps[0]?.block ?? 0;
  return DSP_CAPACITY - (dspUsed(blocks, dspIndex(block)) - slotCredit(dumps));
}

export function modelCost(model: ModelPick, stereo?: boolean): number {
  if (stereo) {
    return model.load_stereo ?? model.load ?? 0;
  }
  return model.load ?? 0;
}

/** Unknown cost (no catalog load) always fits. */
export function modelFits(model: ModelPick, headroom: number, stereo?: boolean): boolean {
  const cost = modelCost(model, stereo);
  if (cost <= 0) {
    return true;
  }
  return cost <= headroom + 1e-3;
}
