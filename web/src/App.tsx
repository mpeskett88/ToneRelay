import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import rawCatalog from "../../hxbridge/model_param_index.json";
import {
  BleTransport,
  BridgeClient,
  BridgeError,
  bluetoothAvailable,
  rememberTransport,
  rememberedTransport,
  WsTransport,
  type JsonValue,
  type Reply,
  type Transport,
} from "./bridge";
import {
  bankPreset,
  blockMeta,
  type Catalog,
  type CatalogParam,
  type DumpBlock,
  helixSlotLabel,
  knobToParam,
  choiceIndex,
  choiceWireBase,
  usesChoiceSegment,
  paramLabel,
  shownParamValue,
  uiScale,
  uiToWire,
  wireToUi,
  type BlockCategory,
  categoryPaint,
  categoryTitle,
  canPickModel,
  dspHeadroom,
  dspRefuseMessage,
  hxCategoryKind,
  modelFits,
  type FavoriteRow,
  type ModelCategory,
  type ModelShelf,
} from "./catalog";
import { SetupWizard, type WizardInfo } from "./SetupWizard";
import {
  boardNodes,
  buildChain,
  canMoveSlot,
  gridSlotColFromUsb,
  gridWireBefore,
  nodeIdForUsb,
  roundPolyline,
  type ChainCell,
  type ChainNode,
  type DspBoard,
  type JunctionPoint,
  type TopoPath,
} from "./chain";
import EqGraph from "./EqGraph";
import { isParametricEq } from "./eqCurve";
import { CategoryIcon, ExportIcon, GraphIcon, MoreIcon, PencilIcon, StarIcon, TrashIcon } from "./icons";

const catalog = rawCatalog as unknown as Catalog;

const SETLISTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const LONG_PRESS_MS = 400;
const PRESS_SLOP_PX = 14;
const EDGE_SCROLL_PX = 56;
const EDGE_SCROLL_MAX = 18;
const ERROR_BANNER_MS = 5000;

type DragGhost = {
  title: string;
  category: BlockCategory;
  enabled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};

function slotAtPoint(x: number, y: number): number | null {
  const hit = document.elementFromPoint(x, y);
  const el = hit instanceof Element ? hit.closest("[data-testid^='chain-cell-']") : null;
  if (!el) {
    return null;
  }
  const m = /chain-cell-(\d+)/.exec(el.getAttribute("data-testid") ?? "");
  return m ? Number(m[1]) : null;
}

type Preset = { index: number; name: string };
type Setlist = { index: number; name: string };
type BootInfo = {
  ok?: boolean;
  platform?: string;
  setup_required?: boolean;
  ap_secured?: boolean;
  catalog?: boolean;
  catalog_ready?: boolean;
  catalog_models?: number;
  usb?: boolean;
  present?: boolean;
  opening?: boolean;
  hold_open?: boolean;
  note?: string;
  wifi?: {
    sta?: boolean;
    ssid?: string;
    ip?: string;
    ap?: string;
    ap_ip?: string;
    mdns?: string;
  };
};

async function apiCmd(
  cmd: { op: string; [k: string]: JsonValue },
  timeoutMs = 20_000,
): Promise<Reply> {
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch("/api/cmd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new BridgeError(`setup request failed (${res.status})`);
    }
    return (await res.json()) as Reply;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new BridgeError(`timeout waiting for ${cmd.op}`);
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

function helixSlots(index?: number, name?: string): Preset[] {
  return Array.from({ length: 32 }, (_, i) => ({
    index: i,
    name: i === index ? (name ?? "") : "",
  }));
}

function setlistLabel(index: number, names: Setlist[]): string {
  const found = names.find((s) => s.index === index)?.name?.trim();
  return found ? found : `Setlist ${index + 1}`;
}

function isHlxDocument(value: unknown): value is JsonValue {
  if (!value || typeof value !== "object") {
    return false;
  }
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return false;
  }
  return "tone" in (data as object);
}

function hlxMetaName(hlx: JsonValue): string {
  if (!hlx || typeof hlx !== "object" || Array.isArray(hlx)) {
    return "Imported";
  }
  const data = (hlx as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Imported";
  }
  const meta = (data as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return "Imported";
  }
  const name = (meta as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : "Imported";
}

async function saveHlxFile(filename: string, hlx: JsonValue): Promise<void> {
  const text = `${JSON.stringify(hlx, null, 2)}\n`;
  const file = new File([text], filename, { type: "application/octet-stream" });
  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[] }) => Promise<void>;
  };
  if (typeof nav.canShare === "function" && nav.canShare({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file] });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function emptySlotNode(slot: number): ChainNode {
  return {
    id: `empty:${slot}`,
    title: "Empty",
    category: "fx",
    model: "",
    enabled: true,
    dumps: [{ block: slot, subslot: 0, params: [] }],
  };
}

let resumeStarted = false;

export default function App() {
  const bleOk = bluetoothAvailable();
  const [client, setClient] = useState<BridgeClient | null>(null);
  const [transportName, setTransportName] = useState<"wifi" | "bluetooth" | null>(null);
  const [error, setErrorText] = useState<string | null>(null);
  const [errorAt, setErrorAt] = useState(0);
  const setError = useCallback((msg: string | null) => {
    setErrorText(msg);
    setErrorAt(msg ? Date.now() : 0);
  }, []);
  useEffect(() => {
    if (!error) {
      return;
    }
    const timer = window.setTimeout(() => setErrorText(null), ERROR_BANNER_MS);
    return () => window.clearTimeout(timer);
  }, [error, errorAt]);
  const [busy, setBusy] = useState<string | null>(null);
  const [usb, setUsb] = useState<boolean | null>(null);
  const [present, setPresent] = useState(false);
  const [helixPrompt, setHelixPrompt] = useState(true);
  const [helixSilent, setHelixSilent] = useState(false);
  const helixSilentRef = useRef(false);
  const [bootInfo, setBootInfo] = useState<BootInfo | null>(null);
  const skipResumeAfterSetup = useRef(false);
  const stayInWizard = useRef(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [setlists, setSetlists] = useState<Setlist[]>([]);
  const [setlist, setSetlist] = useState(0);
  const [loadedSetlist, setLoadedSetlist] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [loadedName, setLoadedName] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<DumpBlock[]>([]);
  const [paths, setPaths] = useState<TopoPath[]>([]);
  const [snapshots, setSnapshots] = useState<string[]>([]);
  const [snapshotIndex, setSnapshotIndex] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [snapOpen, setSnapOpen] = useState(false);
  const snapMenuRef = useRef<HTMLDivElement>(null);
  const [modelCats, setModelCats] = useState<ModelCategory[]>([]);
  const [placeMode, setPlaceMode] = useState(false);
  const [pendingHlx, setPendingHlx] = useState<{ name: string; hlx: JsonValue } | null>(null);
  const [confirmIndex, setConfirmIndex] = useState<number | null>(null);
  const [renameEdit, setRenameEdit] = useState<{ index: number; draft: string } | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const stateEpoch = useRef(0);

  function bumpState() {
    stateEpoch.current += 1;
  }

  useLayoutEffect(() => {
    function syncAppHeight() {
      const vv = window.visualViewport;
      const layout = window.innerHeight;
      const visibleBottom = vv ? vv.height + vv.offsetTop : layout;
      // Keyboard (or similar overlay): visual viewport is much shorter. Use it
      // so the inspector stays above the keys.
      if (vv && layout - visibleBottom > 120) {
        document.documentElement.style.setProperty("--app-height", `${Math.round(vv.height)}px`);
        return;
      }
      // iOS visualViewport — and sometimes innerHeight — stop at the
      // home-indicator line, which is exactly where the bottom rounded
      // corners begin. screen.width/height stay portrait-oriented on iOS, so
      // pick the side that matches the current orientation. Ignore screen
      // size on desktop, where it is the monitor, not the window.
      const portrait = layout >= window.innerWidth;
      const screenH = portrait
        ? Math.max(window.screen.width, window.screen.height)
        : Math.min(window.screen.width, window.screen.height);
      const h = Math.abs(screenH - layout) < 100 ? Math.max(layout, screenH) : layout;
      document.documentElement.style.setProperty("--app-height", `${Math.round(h)}px`);
    }
    const viewport = window.visualViewport;
    syncAppHeight();
    window.addEventListener("resize", syncAppHeight);
    window.addEventListener("orientationchange", syncAppHeight);
    viewport?.addEventListener("resize", syncAppHeight);
    viewport?.addEventListener("scroll", syncAppHeight);
    return () => {
      window.removeEventListener("resize", syncAppHeight);
      window.removeEventListener("orientationchange", syncAppHeight);
      viewport?.removeEventListener("resize", syncAppHeight);
      viewport?.removeEventListener("scroll", syncAppHeight);
    };
  }, []);

  useEffect(() => {
    if (!snapOpen) {
      return;
    }
    const onPtr = (ev: PointerEvent) => {
      if (snapMenuRef.current?.contains(ev.target as Node)) {
        return;
      }
      setSnapOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setSnapOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPtr);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPtr);
      window.removeEventListener("keydown", onKey);
    };
  }, [snapOpen]);

  async function applyState(state: {
    blocks?: DumpBlock[];
    paths?: TopoPath[];
    snapshots?: string[];
    snapshot?: number;
    setlist?: number;
    index?: number;
    name?: string;
  }) {
    setBlocks(state.blocks ?? []);
    setPaths(state.paths ?? []);
    setSnapshots(Array.isArray(state.snapshots) ? state.snapshots : []);
    if (typeof state.snapshot === "number") {
      setSnapshotIndex(state.snapshot);
    }
    if (typeof state.setlist === "number") {
      setLoadedSetlist(state.setlist);
    }
    if (typeof state.index === "number") {
      setSelected(state.index);
    }
    if (typeof state.name === "string" && state.name) {
      setLoadedName(state.name);
    }
  }

  async function loadPresetNames(sl: number) {
    try {
      const listed = await apiCmd({ op: "list_presets", setlist: sl }, 12_000);
      if (!listed.ok) {
        return;
      }
      const rows = (listed.presets as Preset[]) ?? [];
      if (rows.length > 0) {
        setPresets(rows);
      }
    } catch {
      /* Current slot name is already on screen. */
    }
  }

  async function loadChainOverHttp() {
    try {
      const state = await apiCmd({ op: "get_state" }, 20_000);
      if (!state.ok) {
        return;
      }
      await applyState(state as {
        blocks?: DumpBlock[];
        paths?: TopoPath[];
        snapshots?: string[];
        setlist?: number;
        index?: number;
        name?: string;
      });
      if (typeof state.setlist === "number") {
        setSetlist(state.setlist);
      }
    } catch {
      /* Editor is already up; the chain can load on a later refresh. */
    }
  }

  async function connect(kind: "bluetooth" | "wifi", auto = false) {
    setError(null);
    setBusy(kind === "bluetooth" ? "Opening Bluetooth…" : "Opening Wi-Fi…");
    let toClose: BridgeClient | null = null;
    try {
      let transport: Transport;
      if (kind === "bluetooth") {
        if (auto) {
          const resumed = await BleTransport.reconnect();
          if (!resumed) {
            return;
          }
          transport = resumed;
        } else {
          transport = await BleTransport.connect();
        }
      } else {
        transport = await WsTransport.connect();
      }
      const next = new BridgeClient(transport);
      toClose = next;
      let info = await next.request({ op: "info" });
      if (!info.usb && info.present) {
        setBusy("Waiting for Helix…");
        const hardStop = Date.now() + 8_000;
        while (!info.usb && Date.now() < hardStop) {
          await new Promise((r) => window.setTimeout(r, 500));
          info = await next.request({ op: "info" });
        }
      }
      setUsb(Boolean(info.usb));
      setPresent(info.present === true);
      const onEsp = info.platform === "esp32-p4";
      if (!info.usb) {
        setClient(next);
        setTransportName(transport.name);
        rememberTransport(transport.name);
        toClose = null;
        setHelixPrompt(true);
        return;
      }
      setHelixPrompt(false);
      setHelixSilent(false);
      helixSilentRef.current = false;
      setBusy("Reading preset…");
      let meta: Reply | null = null;
      try {
        meta = await apiCmd({ op: "preset_info" }, 20_000);
      } catch (err) {
        meta = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (!meta.ok) {
        const why = String(meta.error ?? "preset_info failed");
        const silent = /timed out waiting for a reply/i.test(why);
        setError(
          silent
            ? "Helix is on USB but not answering. Unplug its 9V adapter, wait for boot, then retry."
            : why,
        );
        setHelixSilent(silent);
        helixSilentRef.current = silent;
        setHelixPrompt(true);
        try {
          if (!(onEsp && !info.catalog && !info.catalog_ready)) {
            const models = await apiCmd({ op: "list_models" }, 8_000);
            if (models.ok) {
              const cats = (models.categories as ModelCategory[]) ?? [];
              setModelCats(
                cats.filter(
                  (c) => c.models.length > 0 || (c.shelves ?? []).some((s) => s.models.length > 0),
                ),
              );
            }
          }
        } catch {
          setModelCats([]);
        }
        setClient(next);
        setTransportName(transport.name);
        rememberTransport(transport.name);
        toClose = null;
        return;
      }
      if (typeof meta.setlist === "number") {
        setSetlist(meta.setlist);
        setLoadedSetlist(meta.setlist);
      }
      if (typeof meta.index === "number") {
        setSelected(meta.index);
        const nm = typeof meta.name === "string" ? meta.name : "";
        setPresets(helixSlots(meta.index, nm));
      }
      if (typeof meta.name === "string" && meta.name) {
        setLoadedName(meta.name);
      }
      try {
        const listedSets = await apiCmd({ op: "list_setlists" }, 12_000);
        const rows = (listedSets.setlists as Setlist[]) ?? [];
        if (listedSets.ok && Array.isArray(rows) && rows.length > 0) {
          setSetlists(rows);
        }
      } catch {
        setSetlists([]);
      }
      try {
        if (onEsp && !info.catalog && !info.catalog_ready) {
          setModelCats([]);
        } else {
          const models = await apiCmd({ op: "list_models" }, 8_000);
          if (models.ok) {
            const cats = (models.categories as ModelCategory[]) ?? [];
            setModelCats(
              cats.filter(
                (c) => c.models.length > 0 || (c.shelves ?? []).some((s) => s.models.length > 0),
              ),
            );
          }
        }
      } catch {
        setModelCats([]);
      }
      await loadChainOverHttp();
      setClient(next);
      setTransportName(transport.name);
      rememberTransport(transport.name);
      toClose = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (toClose) {
        await toClose.close();
      }
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    let on = true;
    fetch("/api/info")
      .then((r) => (r.ok ? r.json() : null))
      .then((info: BootInfo | null) => {
        if (on && info && typeof info === "object") {
          setBootInfo(info);
          if (info.setup_required) {
            skipResumeAfterSetup.current = true;
            stayInWizard.current = true;
          }
          if (typeof info.usb === "boolean") {
            setUsb(info.usb);
          }
          if (typeof info.present === "boolean") {
            setPresent(info.present);
          }
        }
      })
      .catch(() => {
        /* Pi or file:// splash still works without this. */
      });
    return () => {
      on = false;
    };
  }, []);

  useEffect(() => {
    if (resumeStarted) {
      return;
    }
    if (!bootInfo) {
      return;
    }
    if (bootInfo.setup_required || skipResumeAfterSetup.current) {
      return;
    }
    const remembered = rememberedTransport();
    if (!remembered) {
      return;
    }
    resumeStarted = true;
    void connect(remembered, true);
  }, [bootInfo]);

  useEffect(() => {
    if (!client) {
      return;
    }
    let on = true;
    let inflight = false;
    const tick = async () => {
      if (inflight) {
        return;
      }
      inflight = true;
      try {
        const epoch = stateEpoch.current;
        const ev = await client.request({ op: "events" });
        if (!on || !ev.dirty || epoch !== stateEpoch.current) {
          return;
        }
        const state = await client.request({ op: "get_state" });
        if (!on || !state.ok || epoch !== stateEpoch.current) {
          return;
        }
        await applyState(state as {
          blocks?: DumpBlock[];
          paths?: TopoPath[];
          snapshots?: string[];
          snapshot?: number;
          setlist?: number;
          index?: number;
        });
        if (typeof state.setlist === "number") {
          setLoadedSetlist(state.setlist);
        }
      } catch {
        /* poll is best-effort */
      } finally {
        inflight = false;
      }
    };
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      on = false;
      window.clearInterval(id);
    };
  }, [client, setlist, loadedSetlist]);

  useEffect(() => {
    if (!client) {
      return;
    }
    let on = true;
    let sawUsb = usb === true;
    const tick = async () => {
      try {
        const info = (await fetch("/api/info").then((r) => r.json())) as BootInfo;
        if (!on || !info || typeof info !== "object") {
          return;
        }
        setBootInfo(info);
        const nowUsb = Boolean(info.usb);
        setUsb(nowUsb);
        setPresent(info.present === true);
        if (!nowUsb) {
          setHelixPrompt(true);
          setHelixSilent(false);
          helixSilentRef.current = false;
          sawUsb = false;
        } else if (helixSilentRef.current) {
          /* Session is open but RPC timed out; wait for USB to drop after a 9V pull. */
        } else {
          setHelixPrompt(false);
          if (!sawUsb) {
            sawUsb = true;
            await loadChainOverHttp();
          }
        }
      } catch {
        /* poll is best-effort */
      }
    };
    const id = window.setInterval(() => void tick(), 2500);
    return () => {
      on = false;
      window.clearInterval(id);
    };
  }, [client]);

  async function selectPreset(index: number) {
    if (!client) {
      return;
    }
    const { bank, preset } = bankPreset(index);
    setError(null);
    bumpState();
    setBusy("Selecting preset…");
    setMenuOpen(false);
    try {
      await client.request({ op: "select_preset", bank, preset, setlist });
      setSelected(index);
      setLoadedSetlist(setlist);
      const chosen = presets.find((p) => p.index === index)?.name;
      if (chosen) {
        setLoadedName(chosen);
      }
      const state = await client.request({ op: "get_state" });
      await applyState(state as {
        blocks?: DumpBlock[];
        paths?: TopoPath[];
        snapshots?: string[];
        setlist?: number;
        index?: number;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function changeSetlist(next: number) {
    if (!client || next === setlist) {
      return;
    }
    setError(null);
    setBusy("Loading setlist…");
    try {
      const listed = await apiCmd({ op: "list_presets", setlist: next }, 12_000);
      if (!listed.ok) {
        throw new BridgeError(String(listed.error ?? "list_presets failed"));
      }
      setSetlist(next);
      setPresets((listed.presets as Preset[]) ?? []);
      setConfirmIndex(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function savePreset() {
    if (!client || selected === null || loadedSetlist === null) {
      return;
    }
    const name = loadedName ?? presets.find((p) => p.index === selected)?.name;
    if (!name) {
      setError("Cannot save: preset name is unknown");
      return;
    }
    setError(null);
    setBusy("Saving…");
    try {
      await client.request({
        op: "save_preset",
        setlist: loadedSetlist,
        index: selected,
        name,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function renamePreset() {
    if (!client || renameEdit == null) {
      return;
    }
    const name = renameEdit.draft.trim();
    if (!name) {
      return;
    }
    const index = renameEdit.index;
    setError(null);
    setBusy("Renaming…");
    try {
      await client.request({ op: "rename_preset", setlist, index, name });
      setPresets((rows) => rows.map((p) => (p.index === index ? { ...p, name } : p)));
      if (loadedSetlist === setlist && selected === index) {
        setLoadedName(name);
      }
      setRenameEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function cancelImport() {
    setPlaceMode(false);
    setPendingHlx(null);
    setConfirmIndex(null);
    if (importFileRef.current) {
      importFileRef.current.value = "";
    }
  }

  async function exportPreset(index: number) {
    if (!client) {
      return;
    }
    setError(null);
    setBusy("Exporting…");
    try {
      const reply = await client.request({ op: "export_preset", setlist, index });
      const hlx = reply.hlx;
      if (!isHlxDocument(hlx)) {
        setError("Export did not return an .hlx document");
        return;
      }
      const filename =
        typeof reply.filename === "string" && reply.filename.endsWith(".hlx")
          ? reply.filename
          : `${typeof reply.name === "string" && reply.name ? reply.name : "preset"}.hlx`;
      await saveHlxFile(filename, hlx);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onImportFile(ev: ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) {
      return;
    }
    setError(null);
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      if (!isHlxDocument(parsed)) {
        setError("That file is not an .hlx preset");
        return;
      }
      setPendingHlx({ name: hlxMetaName(parsed), hlx: parsed });
      setPlaceMode(true);
      setConfirmIndex(null);
      setMenuOpen(true);
    } catch {
      setError("That file is not an .hlx preset");
    }
  }

  async function confirmImport() {
    if (!client || !pendingHlx || confirmIndex === null) {
      return;
    }
    const index = confirmIndex;
    setError(null);
    setBusy("Importing…");
    try {
      const reply = await client.request({
        op: "import_preset",
        setlist,
        index,
        hlx: pendingHlx.hlx,
      });
      try {
        const listed = await client.request({ op: "list_presets", setlist });
        setPresets((listed.presets as Preset[]) ?? []);
        const state = await client.request({ op: "get_state" });
        await applyState(state as {
          blocks?: DumpBlock[];
          paths?: TopoPath[];
          snapshots?: string[];
          setlist?: number;
          index?: number;
        });
      } catch {
        /* import already landed; list/state refresh is best-effort */
      }
      const skipped = Array.isArray(reply.skipped)
        ? reply.skipped.filter((s): s is string => typeof s === "string")
        : [];
      if (skipped.length > 0) {
        setError(`Imported with gaps: ${skipped.slice(0, 4).join("; ")}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      cancelImport();
      setBusy(null);
    }
  }

  async function selectSnapshot(index: number) {
    if (!client) {
      return;
    }
    setError(null);
    bumpState();
    setSnapshotIndex(index);
    try {
      const reply = await client.request({ op: "select_snapshot", index });
      const epoch = stateEpoch.current;
      if (epoch !== stateEpoch.current) {
        return;
      }
      const enabled = Array.isArray(reply.enabled)
        ? reply.enabled.filter((v): v is boolean => typeof v === "boolean")
        : null;
      if (enabled && enabled.length > 0) {
        setBlocks((prev) =>
          prev.map((b) =>
            enabled[b.block] === undefined ? b : { ...b, enabled: enabled[b.block] },
          ),
        );
        return;
      }
      const state = await client.request({ op: "get_state" });
      if (epoch !== stateEpoch.current || !state.ok) {
        return;
      }
      await applyState(state as {
        blocks?: DumpBlock[];
        paths?: TopoPath[];
        snapshots?: string[];
        snapshot?: number;
        setlist?: number;
        index?: number;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!client) {
    const onEsp = bootInfo?.platform === "esp32-p4";
    const needsSetup = onEsp && Boolean(bootInfo?.setup_required);
    if (needsSetup) {
      stayInWizard.current = true;
    }
    if (stayInWizard.current) {
      return (
        <div className="app">
          <header className="top">
            <h1>ToneRelay</h1>
          </header>
          <SetupWizard
            info={(bootInfo ?? {}) as WizardInfo}
            onInfo={(next) => setBootInfo(next)}
            onEnterEditor={() => void connect("wifi")}
            connecting={busy}
            connectError={error}
          />
        </div>
      );
    }
    return (
      <div className="app">
        <header className="top">
          <h1>ToneRelay</h1>
        </header>
        <div className="connect">
          <p className="eyebrow">{onEsp ? "ESP32-P4" : "Helix floor"}</p>
          <h2>Connect over Wi-Fi</h2>
          <p className="hint">
            {bleOk
              ? onEsp
                ? "This board is on the LAN. Open the editor over Wi-Fi, or Bluetooth from Chrome on HTTPS."
                : "Wi-Fi is the usual path on this Pi, including iPhone. Bluetooth still works in Chrome, but only on HTTPS."
              : "This browser has no Web Bluetooth. Use Wi-Fi to reach the Helix."}
          </p>
          <div className="stack">
            <button
              className="primary"
              data-testid="connect-wifi"
              disabled={Boolean(busy)}
              onClick={() => connect("wifi")}
            >
              Wi-Fi
            </button>
            {bleOk && (
              <button className="secondary" disabled={Boolean(busy)} onClick={() => connect("bluetooth")}>
                Bluetooth
              </button>
            )}
            {busy && <p className="busy">{busy}</p>}
            {error && <p className="error">{error}</p>}
          </div>
          <p className="disclaimer">
            ToneRelay is an independent project. It is not affiliated with, authorized,
            endorsed, or sponsored by Line 6 or Yamaha Guitar Group. Line 6, Helix, HX,
            and HX Edit are trademarks of their respective owners. Use at your own risk.
          </p>
        </div>
      </div>
    );
  }

  const presetName = presets.find((p) => p.index === selected)?.name ?? loadedName;

  return (
    <div className={`app ${menuOpen ? "menu-open" : ""}`}>
      <header className="top">
        <button
          className="menu-btn"
          type="button"
          aria-label={menuOpen ? "Close preset list" : "Open preset list"}
          aria-expanded={menuOpen}
          onClick={() => {
            setSnapOpen(false);
            setRenameEdit(null);
            setMenuOpen((v) => {
              const next = !v;
              if (next) {
                void loadPresetNames(setlist);
              }
              return next;
            });
          }}
        >
          <span />
          <span />
          <span />
        </button>
        <h1>ToneRelay</h1>
        <span className="badge">
          <span className={usb === false ? "live-pill cold" : "live-pill"}>
            {usb === false ? "No Helix" : "Live"}
          </span>
          {transportName === "bluetooth" ? "Bluetooth" : "Wi-Fi"}
          {presetName ? ` · ${presetName}` : ""}
          {` · ${setlistLabel(setlist, setlists)}`}
        </span>
        {snapshots.length > 0 && (
          <div className="snap-menu" ref={snapMenuRef}>
            <button
              type="button"
              className="snap-menu-btn"
              data-testid="snap-menu"
              aria-haspopup="listbox"
              aria-expanded={snapOpen}
              aria-label={
                snapshotIndex != null
                  ? `Snapshots, ${snapshots[snapshotIndex] || `S${snapshotIndex + 1}`}`
                  : "Snapshots"
              }
              onClick={() => setSnapOpen((v) => !v)}
            >
              {snapshotIndex != null
                ? snapshots[snapshotIndex] || `S${snapshotIndex + 1}`
                : "Snap"}
            </button>
            {snapOpen && (
              <ul className="snap-menu-list" role="listbox" aria-label="Snapshots">
                {snapshots.map((name, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      role="option"
                      data-testid={`snap-menu-item-${i}`}
                      className={i === snapshotIndex ? "snap active" : "snap"}
                      aria-selected={i === snapshotIndex}
                      onClick={() => {
                        setSnapOpen(false);
                        void selectSnapshot(i);
                      }}
                    >
                      {name || `S${i + 1}`}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {busy && <span className="busy">{busy}</span>}
      </header>
      {error && <p className="error banner" data-testid="error-banner">{error}</p>}
      <div className="stage">
        <aside className="panel list" id="preset-drawer">
          <h2>Presets</h2>
          <div className="list-actions">
            <button
              className="save-preset"
              type="button"
              data-testid="save-preset"
              disabled={Boolean(busy) || selected === null || loadedSetlist === null || placeMode}
              onClick={() => {
                void savePreset();
              }}
            >
              Save
            </button>
            <button
              className="import-preset"
              type="button"
              data-testid="import-preset"
              disabled={Boolean(busy)}
              onClick={() => {
                importFileRef.current?.click();
              }}
            >
              Import
            </button>
          </div>
          <input
            ref={importFileRef}
            type="file"
            accept=".hlx,application/json,application/octet-stream"
            hidden
            data-testid="import-file"
            onChange={(ev) => {
              void onImportFile(ev);
            }}
          />
          {placeMode && pendingHlx && (
            <div className="place-banner">
              <p>Tap a slot to replace with {pendingHlx.name}</p>
              <button type="button" data-testid="import-cancel" disabled={Boolean(busy)} onClick={cancelImport}>
                Cancel
              </button>
            </div>
          )}
          <label className="setlist-pick">
            <span>Setlist</span>
            <select
              value={setlist}
              disabled={Boolean(busy)}
              aria-label="Setlist"
              onChange={(ev) => {
                void changeSetlist(Number(ev.target.value));
              }}
            >
              {(setlists.length > 0 ? setlists : SETLISTS.map((n) => ({ index: n - 1, name: String(n) }))).map((s) => (
                <option key={s.index} value={s.index}>
                  {s.name.trim() ? s.name : `Setlist ${s.index + 1}`}
                </option>
              ))}
            </select>
          </label>
          {presets.map((p) => {
            const active = loadedSetlist === setlist && selected === p.index;
            return (
              <div
                key={p.index}
                className={`preset-row${active ? " active" : ""}${placeMode ? " placing" : ""}`}
              >
                <button
                  data-testid={`preset-${p.index}`}
                  className={active ? "preset active" : "preset"}
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (placeMode) {
                      setConfirmIndex(p.index);
                      return;
                    }
                    selectPreset(p.index);
                  }}
                >
                  <span>{p.index}</span>
                  <span>{p.name}</span>
                </button>
                <button
                  className="preset-export"
                  type="button"
                  data-testid={`rename-preset-${p.index}`}
                  aria-label={`Rename ${p.name || helixSlotLabel(p.index)}`}
                  disabled={Boolean(busy) || placeMode}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setRenameEdit({ index: p.index, draft: p.name.slice(0, 16) });
                  }}
                >
                  <PencilIcon />
                </button>
                <button
                  className="preset-export"
                  type="button"
                  data-testid={`export-preset-${p.index}`}
                  aria-label={`Export ${p.name || helixSlotLabel(p.index)}`}
                  disabled={Boolean(busy) || placeMode}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void exportPreset(p.index);
                  }}
                >
                  <ExportIcon />
                </button>
              </div>
            );
          })}
        </aside>
        {menuOpen && (
          <button className="scrim" type="button" aria-label="Close preset list" onClick={() => setMenuOpen(false)} />
        )}
        {helixPrompt && (!usb || helixSilent) && (
          <>
            <button
              className="model-scrim"
              type="button"
              aria-label="Dismiss Helix prompt"
              onClick={() => setHelixPrompt(false)}
            />
            <div className="overwrite-sheet" role="dialog" aria-modal="true" aria-label="Helix not connected">
              <h2>{helixSilent || present ? "Helix not answering" : "Helix not connected"}</h2>
              {helixSilent || present ? (
                <>
                  <p>Unplug its 9V adapter, wait for the Helix to boot, then plug USB into the NANO USB-A port.</p>
                  <p className="hint">A USB replug is not enough once it has gone silent.</p>
                </>
              ) : (
                <p>Plug the Helix into the NANO USB-A port.</p>
              )}
              <div className="overwrite-actions">
                <button type="button" className="overwrite-cancel" onClick={() => setHelixPrompt(false)}>
                  OK
                </button>
              </div>
            </div>
          </>
        )}
        {confirmIndex !== null && pendingHlx && (
          <>
            <button
              className="model-scrim"
              type="button"
              aria-label="Cancel overwrite"
              onClick={() => setConfirmIndex(null)}
            />
            <div className="overwrite-sheet" role="dialog" aria-modal="true" aria-label="Overwrite preset">
              <h2>Overwrite slot</h2>
              <p>
                Replace {helixSlotLabel(confirmIndex)}
                {presets.find((p) => p.index === confirmIndex)?.name
                  ? ` “${presets.find((p) => p.index === confirmIndex)?.name}”`
                  : ""}{" "}
                with “{pendingHlx.name}”? This overwrites the slot.
              </p>
              <p className="hint">
                The chain and name are replaced. Snapshots and assignments may stay as they are.
              </p>
              <div className="overwrite-actions">
                <button type="button" className="overwrite-cancel" disabled={Boolean(busy)} onClick={() => setConfirmIndex(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="overwrite-confirm"
                  data-testid="import-confirm"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    void confirmImport();
                  }}
                >
                  Replace
                </button>
              </div>
            </div>
          </>
        )}
        {renameEdit && (
          <>
            <button
              className="model-scrim"
              type="button"
              aria-label="Cancel rename"
              onClick={() => setRenameEdit(null)}
            />
            <form
              className="overwrite-sheet"
              data-testid="rename-preset-form"
              role="dialog"
              aria-modal="true"
              aria-label="Rename preset"
              onSubmit={(ev) => {
                ev.preventDefault();
                void renamePreset();
              }}
            >
              <h2>Rename preset</h2>
              <label className="fav-save-label">
                Name
                <input
                  className="fav-save-input"
                  value={renameEdit.draft}
                  maxLength={16}
                  autoComplete="off"
                  autoFocus
                  data-testid="rename-preset-name"
                  onChange={(ev) => setRenameEdit({ ...renameEdit, draft: ev.target.value })}
                />
              </label>
              <div className="overwrite-actions">
                <button
                  type="button"
                  className="overwrite-cancel"
                  data-testid="rename-preset-cancel"
                  disabled={Boolean(busy)}
                  onClick={() => setRenameEdit(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="overwrite-confirm ok"
                  data-testid="rename-preset-save"
                  disabled={Boolean(busy) || renameEdit.draft.trim() === ""}
                >
                  Save
                </button>
              </div>
            </form>
          </>
        )}
        <Editor
          client={client}
          blocks={blocks}
          paths={paths}
          snapshots={snapshots}
          snapshotIndex={snapshotIndex}
          modelCats={modelCats}
          setBlocks={setBlocks}
          setError={setError}
          onSnapshot={selectSnapshot}
          onMutate={bumpState}
        />
      </div>
    </div>
  );
}

function Editor({
  client,
  blocks,
  paths,
  snapshots,
  snapshotIndex,
  modelCats,
  setBlocks,
  setError,
  onSnapshot,
  onMutate,
}: {
  client: BridgeClient;
  blocks: DumpBlock[];
  paths: TopoPath[];
  snapshots: string[];
  snapshotIndex: number | null;
  modelCats: ModelCategory[];
  setBlocks: (blocks: DumpBlock[]) => void;
  setError: (msg: string | null) => void;
  onSnapshot: (index: number) => void;
  onMutate: () => void;
}) {
  const boards = useMemo(() => buildChain(blocks, paths), [blocks, paths]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [emptySlot, setEmptySlot] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [favorites, setFavorites] = useState<FavoriteRow[]>([]);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropHover, setDropHover] = useState<number | null>(null);
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const pressTimer = useRef<number | null>(null);
  const dragged = useRef(false);
  const capturing = useRef(false);
  const dragFromRef = useRef<number | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const stopTrack = useRef<(() => void) | null>(null);
  const chainBoardRef = useRef<HTMLDivElement | null>(null);
  const pressTarget = useRef<HTMLElement | null>(null);
  const dropHoverRef = useRef<number | null>(null);

  const allNodes = useMemo(() => boards.flatMap(boardNodes), [boards]);
  const active = useMemo(() => allNodes.find((n) => n.id === activeId) ?? allNodes[0] ?? null, [allNodes, activeId]);
  const inspect = emptySlot != null ? emptySlotNode(emptySlot) : active;

  useEffect(() => {
    if (emptySlot != null) {
      return;
    }
    if (activeId && allNodes.some((n) => n.id === activeId)) {
      return;
    }
    setActiveId(allNodes[0]?.id ?? null);
  }, [allNodes, activeId, emptySlot]);

  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    let on = true;
    void client
      .request({ op: "list_favorites" })
      .then((r) => {
        if (on) {
          setFavorites((r.favorites as FavoriteRow[]) ?? []);
        }
      })
      .catch(() => {
        if (on) {
          setFavorites([]);
        }
      });
    return () => {
      on = false;
    };
  }, [pickerOpen, client]);

  const pickerCats = useMemo(() => {
    if (favorites.length === 0) {
      return modelCats;
    }
    const favCat: ModelCategory = {
      id: 23,
      name: "Favorites",
      paired: false,
      models: favorites.map((f) => ({
        id: f.model_id ?? `fav:${f.index}`,
        name: f.name,
        load: f.load,
        load_stereo: f.load_stereo,
        favorite: f.index,
        category: f.category,
      })),
    };
    return [favCat, ...modelCats];
  }, [favorites, modelCats]);

  function selectNode(id: string) {
    setEmptySlot(null);
    setPickerOpen(false);
    setActiveId(id);
  }

  function clearPress() {
    capturing.current = false;
    if (pressTarget.current) {
      pressTarget.current.style.touchAction = "";
      pressTarget.current = null;
    }
    if (pressTimer.current) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    stopTrack.current?.();
    stopTrack.current = null;
  }

  const dropOn = useCallback(
    async (to: number) => {
      const from = dragFromRef.current;
      dragFromRef.current = null;
      setDragFrom(null);
      setGhost(null);
      setDropHover(null);
      dropHoverRef.current = null;
      clearPress();
      if (from == null || !canMoveSlot(from, to)) {
        return;
      }
      try {
        onMutate();
        await client.request({ op: "move_block", from, to });
        const state = await client.request({ op: "get_state" });
        setBlocks((state.blocks as DumpBlock[]) ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, onMutate, setBlocks, setError],
  );

  function tapEmpty(slot: number) {
    if (dragFromRef.current != null) {
      void dropOn(slot);
      return;
    }
    setEmptySlot(slot);
    setActiveId(null);
    setPickerOpen(true);
  }

  const toggleBypass = useCallback(
    async (node: ChainNode) => {
      const dump = node.dumps[0];
      if (dump == null) {
        return;
      }
      const next = node.enabled === false;
      const prev = blocks;
      onMutate();
      setBlocks(blocks.map((b) => (b.block === dump.block ? { ...b, enabled: next } : b)));
      try {
        await client.request({ op: "set_bypass", block: dump.block, enabled: next });
      } catch (err) {
        setBlocks(prev);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [blocks, client, onMutate, setBlocks, setError],
  );

  function startPress(cell: ChainCell, ev: ReactPointerEvent) {
    if (cell.empty || cell.role !== "effect" || cell.node == null) {
      return;
    }
    dragged.current = false;
    capturing.current = false;
    pointer.current = { x: ev.clientX, y: ev.clientY };
    const origin = { x: ev.clientX, y: ev.clientY };
    const pointerId = ev.pointerId;
    const target = ev.currentTarget as HTMLElement;
    const node = cell.node;
    const slot = cell.slot;
    clearPress();
    pressTarget.current = target;
    target.style.touchAction = "none";
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) {
        return;
      }
      pointer.current = { x: t.clientX, y: t.clientY };
      const dist = Math.hypot(t.clientX - origin.x, t.clientY - origin.y);
      if (capturing.current || dist < PRESS_SLOP_PX) {
        if (e.cancelable) {
          e.preventDefault();
        }
        return;
      }
      clearPress();
    };
    const onPointerTrack = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      if (capturing.current && e.cancelable) {
        e.preventDefault();
      }
    };
    window.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    window.addEventListener("pointermove", onPointerTrack, { passive: false });
    stopTrack.current = () => {
      window.removeEventListener("touchmove", onTouchMove, { capture: true });
      window.removeEventListener("pointermove", onPointerTrack);
    };
    pressTimer.current = window.setTimeout(() => {
      capturing.current = true;
      dragged.current = true;
      dragFromRef.current = slot;
      setDragFrom(slot);
      if (ev.pointerType !== "touch") {
        try {
          target.setPointerCapture(pointerId);
        } catch {
          /* capture is optional; touchmove preventDefault still holds the board */
        }
      }
      const r = target.getBoundingClientRect();
      setGhost({
        title: node.title,
        category: node.category,
        enabled: node.enabled,
        x: pointer.current.x,
        y: pointer.current.y,
        w: r.width,
        h: r.height,
      });
    }, LONG_PRESS_MS);
  }

  useEffect(() => {
    if (dragFrom == null) {
      return;
    }
    const hoverAt = (x: number, y: number) => {
      const slot = slotAtPoint(x, y);
      dropHoverRef.current = slot;
      setDropHover(slot);
      return slot;
    };
    let done = false;
    const finishDrag = (x: number, y: number) => {
      if (done) {
        return;
      }
      done = true;
      capturing.current = false;
      const slot = slotAtPoint(x, y) ?? dropHoverRef.current;
      if (slot != null) {
        void dropOn(slot);
      } else {
        dragFromRef.current = null;
        setDragFrom(null);
        setGhost(null);
        setDropHover(null);
        dropHoverRef.current = null;
        clearPress();
      }
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.cancelable) {
        ev.preventDefault();
      }
      pointer.current = { x: ev.clientX, y: ev.clientY };
      setGhost((g) => (g ? { ...g, x: ev.clientX, y: ev.clientY } : g));
      hoverAt(ev.clientX, ev.clientY);
    };
    const onUp = (ev: PointerEvent) => {
      const x = ev.clientX || pointer.current.x;
      const y = ev.clientY || pointer.current.y;
      finishDrag(x, y);
    };
    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      const x = t?.clientX ?? pointer.current.x;
      const y = t?.clientY ?? pointer.current.y;
      pointer.current = { x, y };
      finishDrag(x, y);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) {
        e.preventDefault();
      }
      const t = e.touches[0];
      if (!t) {
        return;
      }
      pointer.current = { x: t.clientX, y: t.clientY };
      setGhost((g) => (g ? { ...g, x: t.clientX, y: t.clientY } : g));
      hoverAt(t.clientX, t.clientY);
    };
    const nudge = () => {
      const board = chainBoardRef.current;
      if (board) {
        const box = board.getBoundingClientRect();
        const { x, y } = pointer.current;
        const near =
          x >= box.left - 12 && x <= box.right + 12 && y >= box.top - 12 && y <= box.bottom + 12;
        if (near) {
          let dx = 0;
          let dy = 0;
          if (x < box.left + EDGE_SCROLL_PX) {
            dx = -EDGE_SCROLL_MAX * Math.min(1, (box.left + EDGE_SCROLL_PX - x) / EDGE_SCROLL_PX);
          } else if (x > box.right - EDGE_SCROLL_PX) {
            dx = EDGE_SCROLL_MAX * Math.min(1, (x - (box.right - EDGE_SCROLL_PX)) / EDGE_SCROLL_PX);
          }
          if (y < box.top + EDGE_SCROLL_PX) {
            dy = -EDGE_SCROLL_MAX * Math.min(1, (box.top + EDGE_SCROLL_PX - y) / EDGE_SCROLL_PX);
          } else if (y > box.bottom - EDGE_SCROLL_PX) {
            dy = EDGE_SCROLL_MAX * Math.min(1, (y - (box.bottom - EDGE_SCROLL_PX)) / EDGE_SCROLL_PX);
          }
          if (dx !== 0 || dy !== 0) {
            board.scrollLeft += dx;
            board.scrollTop += dy;
            hoverAt(x, y);
          }
        }
      }
      raf = window.requestAnimationFrame(nudge);
    };
    let raf = 0;
    raf = window.requestAnimationFrame(nudge);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("touchend", onTouchEnd, { capture: true });
    window.addEventListener("touchcancel", onTouchEnd, { capture: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("touchend", onTouchEnd, { capture: true });
      window.removeEventListener("touchcancel", onTouchEnd, { capture: true });
      window.removeEventListener("touchmove", onTouchMove, { capture: true });
    };
  }, [dragFrom, dropOn]);

  const ghostPaint = ghost ? categoryPaint(ghost.category) : null;

  return (
    <section className="editor-pane">
      <div
        ref={chainBoardRef}
        className={`chain-board${dragFrom != null ? " is-dragging" : ""}`}
        role="list"
        aria-label="Signal path"
      >
        {boards.length === 0 && <p className="hint">No blocks in this dump.</p>}
        {boards.map((board) => (
          <DspGrid
            key={board.id}
            board={board}
            active={active}
            dragFrom={dragFrom}
            dropHover={dropHover}
            startPress={startPress}
            tapEmpty={tapEmpty}
            clearPress={clearPress}
            dragged={dragged}
            emptySlot={emptySlot}
            setActiveId={selectNode}
            onBypass={toggleBypass}
          />
        ))}
      </div>
      {ghost && ghostPaint && (
        <div
          className={`drag-ghost${ghost.enabled === false ? " bypassed" : ""}`}
          style={{
            left: ghost.x,
            top: ghost.y,
            width: ghost.w,
            height: ghost.h,
            backgroundColor: ghostPaint.bg,
            color: ghostPaint.fg,
            borderColor: ghostPaint.bd,
          }}
          aria-hidden
        >
          <span className="node-head">
            <CategoryIcon category={ghost.category} />
          </span>
          <span className="node-name">{ghost.title}</span>
        </div>
      )}
      {snapshots.length > 0 && (
        <div className="snap-strip" role="list" aria-label="Snapshots">
          {snapshots.map((name, i) => (
            <button
              key={i}
              type="button"
              role="listitem"
              data-testid={`snapshot-${i}`}
              className={i === snapshotIndex ? "snap active" : "snap"}
              aria-pressed={i === snapshotIndex}
              onClick={() => onSnapshot(i)}
            >
              {name || `S${i + 1}`}
            </button>
          ))}
        </div>
      )}
      <div className="inspector">
        {inspect ? (
          <Inspector
            node={inspect}
            client={client}
            blocks={blocks}
            setBlocks={setBlocks}
            setError={setError}
            onMutate={onMutate}
            onOpenPicker={
              canPickModel(inspect.category)
                ? () => {
                    setPickerOpen(true);
                  }
                : undefined
            }
            onClear={
              !inspect.id.startsWith("empty:") && canPickModel(inspect.category)
                ? async () => {
                    const dump = inspect.dumps[0];
                    if (dump == null) {
                      return;
                    }
                    try {
                      onMutate();
                      await client.request({ op: "clear_block", block: dump.block });
                      const state = await client.request({ op: "get_state" });
                      const next = (state.blocks as DumpBlock[]) ?? [];
                      setBlocks(next);
                      setError(null);
                      setPickerOpen(false);
                      setEmptySlot(dump.block);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  }
                : undefined
            }
            onSaveFavorite={
              !inspect.id.startsWith("empty:") && canPickModel(inspect.category)
                ? async (name: string) => {
                    const dump = inspect.dumps[0];
                    if (dump == null) {
                      return;
                    }
                    await client.request({ op: "save_favorite", block: dump.block, name });
                    setFavorites([]);
                  }
                : undefined
            }
          />
        ) : (
          <p className="hint">Select a block on the path.</p>
        )}
      </div>
      {pickerOpen && inspect && canPickModel(inspect.category) && (
        <ModelSheet
          key={inspect.id}
          node={inspect}
          blocks={blocks}
          categories={pickerCats}
          setError={setError}
          onClose={() => setPickerOpen(false)}
          onChoose={async (modelId, paired, stereo, favorite) => {
            const dump = inspect.dumps[0];
            if (dump == null) {
              return;
            }
            try {
              onMutate();
              if (typeof favorite === "number") {
                await client.request({
                  op: "apply_favorite",
                  block: dump.block,
                  index: favorite,
                });
              } else {
                await client.request({
                  op: "set_model",
                  block: dump.block,
                  model_id: modelId,
                  ...(paired ? { pair: true } : {}),
                  ...(stereo === undefined ? {} : { stereo }),
                });
              }
              const state = await client.request({ op: "get_state" });
              const next = (state.blocks as DumpBlock[]) ?? [];
              setBlocks(next);
              setEmptySlot(null);
              setError(null);
              const id = nodeIdForUsb(next, dump.block);
              if (id) {
                setActiveId(id);
              }
              setPickerOpen(false);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              setError(dspRefuseMessage(msg));
            }
          }}
          onRenameFavorite={async (index, name) => {
            await client.request({ op: "rename_favorite", index, name });
            setFavorites((rows) => rows.map((r) => (r.index === index ? { ...r, name } : r)));
            setError(null);
          }}
          onDeleteFavorite={async (index) => {
            await client.request({ op: "delete_favorite", index });
            setFavorites((rows) => rows.filter((r) => r.index !== index));
            setError(null);
          }}
        />
      )}
    </section>
  );
}

function DspGrid({
  board,
  active,
  emptySlot,
  dragFrom,
  dropHover,
  startPress,
  tapEmpty,
  clearPress,
  dragged,
  setActiveId,
  onBypass,
}: {
  board: DspBoard;
  active: ChainNode | null;
  emptySlot: number | null;
  dragFrom: number | null;
  dropHover: number | null;
  startPress: (cell: ChainCell, ev: ReactPointerEvent) => void;
  tapEmpty: (slot: number) => void;
  clearPress: () => void;
  dragged: { current: boolean };
  setActiveId: (id: string) => void;
  onBypass: (node: ChainNode) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inRef = useRef<HTMLElement | null>(null);
  const outRef = useRef<HTMLElement | null>(null);
  const splitRef = useRef<HTMLButtonElement>(null);
  const mergeRef = useRef<HTMLButtonElement>(null);
  const bFirstRef = useRef<HTMLElement | null>(null);
  const bLastRef = useRef<HTMLElement | null>(null);
  const [traceA, setTraceA] = useState("");
  const [traceB, setTraceB] = useState("");

  useLayoutEffect(() => {
    const root = rootRef.current;
    const input = inRef.current;
    const output = outRef.current;
    if (!root || !input || !output) {
      setTraceA("");
      setTraceB("");
      return;
    }
    const draw = () => {
      const box = root.getBoundingClientRect();
      const rel = (el: DOMRect) => ({
        left: el.left - box.left,
        right: el.right - box.left,
        midX: el.left + el.width / 2 - box.left,
        midY: el.top + el.height / 2 - box.top,
      });
      const inn = rel(input.getBoundingClientRect());
      const out = rel(output.getBoundingClientRect());
      const yA = inn.midY;
      setTraceA(`M ${inn.right} ${yA} L ${out.left} ${yA}`);
      const split = splitRef.current;
      const merge = mergeRef.current;
      const first = bFirstRef.current;
      const last = bLastRef.current;
      if (!board.rowB || !split || !merge || !first || !last) {
        setTraceB("");
        return;
      }
      const s = rel(split.getBoundingClientRect());
      const m = rel(merge.getBoundingClientRect());
      const b0 = rel(first.getBoundingClientRect());
      const b1 = rel(last.getBoundingClientRect());
      const yB = b0.midY;
      const yRail = (yA + yB) / 2;
      const gutter = 20;
      const snap = 8;
      let xLeft = Math.min(s.midX, b0.left - gutter);
      let xRight = Math.max(m.midX, b1.right + gutter);
      if (Math.abs(xLeft - s.midX) <= snap) {
        xLeft = s.midX;
      }
      if (Math.abs(xRight - m.midX) <= snap) {
        xRight = m.midX;
      }
      const pts: { x: number; y: number }[] = [{ x: s.midX, y: yA }];
      if (xLeft !== s.midX) {
        pts.push({ x: s.midX, y: yRail }, { x: xLeft, y: yRail });
      }
      pts.push({ x: xLeft, y: yB }, { x: xRight, y: yB });
      if (xRight !== m.midX) {
        pts.push({ x: xRight, y: yRail }, { x: m.midX, y: yRail });
      }
      pts.push({ x: m.midX, y: yA });
      setTraceB(roundPolyline(pts, 16));
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(root);
    return () => ro.disconnect();
  }, [board]);

  const sameGap = board.split != null && board.merge != null && board.split.beforeLocal === board.merge.beforeLocal;

  function gapPoints(beforeLocal: number): JunctionPoint[] {
    const out: JunctionPoint[] = [];
    if (board.split && board.split.beforeLocal === beforeLocal) {
      out.push(board.split);
    }
    if (board.merge && board.merge.beforeLocal === beforeLocal) {
      out.push(board.merge);
    }
    return out;
  }

  return (
    <div className={`dsp-grid${board.rowB ? " has-b" : ""}`} ref={rootRef}>
      <svg className="branch-trace" aria-hidden>
        {traceA && <path className="spine" d={traceA} />}
        {traceB && <path className="loop" d={traceB} />}
      </svg>
      <span className="path-label" style={{ gridColumn: 1, gridRow: 1 }} aria-label={`Path ${board.labelA}`}>
        {board.labelA}
      </span>
      <BlockCell
        cell={board.input}
        col={2}
        row={1}
        active={active}
        dragFrom={dragFrom}
        dropHover={dropHover}
        startPress={startPress}
        tapEmpty={tapEmpty}
        clearPress={clearPress}
        dragged={dragged}
        emptySlot={emptySlot}
        setActiveId={setActiveId}
        bindRef={inRef}
        onBypass={onBypass}
      />
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((after) => {
        const beforeLocal = after + 1;
        const col = gridWireBefore(beforeLocal);
        const points = gapPoints(beforeLocal);
        if (points.length === 0) {
          return <span key={`w${after}`} className="wire" style={{ gridColumn: col, gridRow: 1 }} aria-hidden />;
        }
        return (
          <span
            key={`j${after}`}
            className={`junction-gap${sameGap && points.length > 1 ? " stacked" : ""}`}
            style={{ gridColumn: col, gridRow: 1 }}
          >
            {points.map((pt) => {
              const isSplit = pt === board.split;
              return (
                <button
                  key={pt.usb}
                  type="button"
                  ref={isSplit ? splitRef : mergeRef}
                  data-testid={`junction-${isSplit ? "split" : "merge"}-${board.dsp}`}
                  className={`junction ${isSplit ? "split" : "merge"}${emptySlot == null && pt.node.id === active?.id ? " selected" : ""}`}
                  aria-label={pt.node.title}
                  aria-pressed={emptySlot == null && pt.node.id === active?.id}
                  onClick={() => setActiveId(pt.node.id)}
                >
                  <CategoryIcon category={isSplit ? "split" : "merge"} />
                </button>
              );
            })}
          </span>
        );
      })}
      {board.rowA.map((cell) => (
        <BlockCell
          key={cell.slot}
          cell={cell}
          col={gridSlotColFromUsb(cell.slot)}
          row={1}
          active={active}
          dragFrom={dragFrom}
          dropHover={dropHover}
          startPress={startPress}
          tapEmpty={tapEmpty}
          clearPress={clearPress}
          dragged={dragged}
          emptySlot={emptySlot}
          setActiveId={setActiveId}
          onBypass={onBypass}
        />
      ))}
      <BlockCell
        cell={board.output}
        col={20}
        row={1}
        active={active}
        dragFrom={dragFrom}
        dropHover={dropHover}
        startPress={startPress}
        tapEmpty={tapEmpty}
        clearPress={clearPress}
        dragged={dragged}
        emptySlot={emptySlot}
        setActiveId={setActiveId}
        bindRef={outRef}
        onBypass={onBypass}
      />
      {board.rowB && (
        <>
          <span className="path-label" style={{ gridColumn: 1, gridRow: 2 }} aria-label={`Path ${board.labelB}`}>
            {board.labelB}
          </span>
          {board.rowB.map((cell, i) => (
            <BlockCell
              key={cell.slot}
              cell={cell}
              col={gridSlotColFromUsb(cell.slot)}
              row={2}
              active={active}
              dragFrom={dragFrom}
              dropHover={dropHover}
              startPress={startPress}
              tapEmpty={tapEmpty}
              clearPress={clearPress}
              dragged={dragged}
              emptySlot={emptySlot}
              setActiveId={setActiveId}
              bindRef={i === 0 ? bFirstRef : i === 7 ? bLastRef : undefined}
              onBypass={onBypass}
            />
          ))}
        </>
      )}
    </div>
  );
}

function BlockCell({
  cell,
  col,
  row,
  active,
  emptySlot,
  dragFrom,
  dropHover,
  startPress,
  tapEmpty,
  clearPress,
  dragged,
  setActiveId,
  bindRef,
  onBypass,
}: {
  cell: ChainCell;
  col: number;
  row: number;
  active: ChainNode | null;
  emptySlot: number | null;
  dragFrom: number | null;
  dropHover: number | null;
  startPress: (c: ChainCell, ev: ReactPointerEvent) => void;
  tapEmpty: (slot: number) => void;
  clearPress: () => void;
  dragged: { current: boolean };
  setActiveId: (id: string) => void;
  bindRef?: { current: HTMLElement | null };
  onBypass: (node: ChainNode) => void;
}) {
  const node = cell.node;
  const paint = node ? categoryPaint(node.category) : null;
  const selected =
    emptySlot != null ? cell.empty && cell.slot === emptySlot : Boolean(node && node.id === active?.id);
  const style = { gridColumn: col, gridRow: row } as const;
  if (cell.role === "io" && node) {
    return (
      <button
        type="button"
        ref={(el) => {
          if (bindRef) {
            bindRef.current = el;
          }
        }}
        data-testid={`chain-cell-${cell.slot}`}
        className={`junction io${selected ? " selected" : ""}`}
        style={style}
        aria-pressed={selected}
        aria-label={node.title}
        title={node.title}
        onPointerUp={() => {
          clearPress();
          setActiveId(node.id);
        }}
      >
        <CategoryIcon category={node.category} />
      </button>
    );
  }
  if (cell.empty || !node) {
    return (
      <button
        type="button"
        ref={(el) => {
          if (bindRef) {
            bindRef.current = el;
          }
        }}
        data-testid={`chain-cell-${cell.slot}`}
        className={`node empty${selected ? " selected" : ""}${dragFrom != null && canMoveSlot(dragFrom, cell.slot) ? " drop" : ""}${dropHover === cell.slot ? " over" : ""}`}
        style={style}
        aria-label={`Empty slot ${cell.slot}`}
        aria-pressed={selected}
        onPointerUp={() => tapEmpty(cell.slot)}
      />
    );
  }
  return (
    <div
      role="listitem"
      ref={(el) => {
        if (bindRef) {
          bindRef.current = el;
        }
      }}
      data-testid={`chain-cell-${cell.slot}`}
      className={`${selected ? "node selected" : "node"}${dragFrom === cell.slot ? " dragging" : ""}${node.enabled === false ? " bypassed" : ""}`}
      style={{
        ...style,
        backgroundColor: paint!.bg,
        color: paint!.fg,
        borderColor: paint!.bd,
      }}
      onPointerDown={(ev) => startPress(cell, ev)}
      onPointerUp={() => {
        if (dragFrom != null) {
          return;
        }
        clearPress();
        if (!dragged.current) {
          setActiveId(node.id);
        }
      }}
      onPointerCancel={() => {
        if (dragFrom != null) {
          return;
        }
        clearPress();
      }}
      onContextMenu={(ev) => ev.preventDefault()}
      aria-pressed={selected}
      aria-label={`${node.title}, ${categoryTitle(node.category)}${typeof node.stereo === "boolean" ? (node.stereo ? ", stereo" : ", mono") : ""}${node.enabled === false ? ", bypassed" : ""}`}
      title={node.title}
    >
      {typeof node.stereo === "boolean" && (
        <span className="node-width" data-testid={node.stereo ? "width-S" : "width-M"}>
          {node.stereo ? "S" : "M"}
        </span>
      )}
      {cell.role === "effect" && (
        <button
          type="button"
          className={node.enabled === false ? "node-bypass off" : "node-bypass"}
          data-testid={`bypass-${cell.slot}`}
          aria-pressed={node.enabled !== false}
          aria-label={`${node.title} ${node.enabled === false ? "off" : "on"}`}
          onPointerDown={(ev) => {
            ev.stopPropagation();
          }}
          onPointerUp={(ev) => ev.stopPropagation()}
          onClick={(ev) => {
            ev.stopPropagation();
            onBypass(node);
          }}
        >
          <span className="bypass-chip">{node.enabled === false ? "Off" : "On"}</span>
        </button>
      )}
      <span className="node-head">
        <CategoryIcon category={node.category} />
      </span>
      <span className="node-name">{node.title}</span>
    </div>
  );
}

function ModelSheet({
  node,
  blocks,
  categories,
  setError,
  onClose,
  onChoose,
  onRenameFavorite,
  onDeleteFavorite,
}: {
  node: ChainNode;
  blocks: DumpBlock[];
  categories: ModelCategory[];
  setError: (msg: string | null) => void;
  onClose: () => void;
  onChoose: (modelId: string, paired: boolean, stereo?: boolean, favorite?: number) => Promise<void>;
  onRenameFavorite: (index: number, name: string) => Promise<void>;
  onDeleteFavorite: (index: number) => Promise<void>;
}) {
  const [openCat, setOpenCat] = useState<ModelCategory | null>(null);
  const [openShelf, setOpenShelf] = useState<ModelShelf | null>(null);
  const [busy, setBusy] = useState(false);
  const [favEdit, setFavEdit] = useState<{
    index: number;
    name: string;
    mode: "rename" | "delete";
    draft: string;
  } | null>(null);
  const currentId = node.dumps[0]?.model_id ?? node.model;
  const liveCat = openCat == null ? null : (categories.find((c) => c.id === openCat.id) ?? openCat);
  const shelves = (liveCat?.shelves ?? []).filter((s) => s.models.length > 0);
  const showingShelves = liveCat != null && openShelf == null && shelves.length > 0;
  const models = openShelf?.models ?? liveCat?.models ?? [];
  const title = openShelf?.name ?? liveCat?.name ?? "Model";
  const shelfStereo =
    openShelf?.name === "Stereo" ? true : openShelf?.name === "Mono" ? false : undefined;
  const headroom = dspHeadroom(blocks, node.dumps);
  const freePct = Math.max(0, Math.min(100, Math.round(headroom)));

  useEffect(() => {
    if (favEdit == null) {
      return;
    }
    const testId =
      favEdit.mode === "rename" ? `fav-rename-form-${favEdit.index}` : `fav-delete-form-${favEdit.index}`;
    document.querySelector(`[data-testid="${testId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [favEdit]);

  useEffect(() => {
    if (openCat == null) {
      return;
    }
    const next = categories.find((c) => c.id === openCat.id);
    if (next == null) {
      setOpenCat(null);
      setOpenShelf(null);
      setFavEdit(null);
    }
  }, [categories, openCat]);

  function goBack() {
    if (favEdit) {
      setFavEdit(null);
      return;
    }
    if (openShelf) {
      setOpenShelf(null);
      return;
    }
    setOpenCat(null);
  }

  async function pick(modelId: string, paired: boolean, stereo?: boolean, favorite?: number) {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onChoose(modelId, paired, stereo, favorite);
    } finally {
      setBusy(false);
    }
  }

  async function renameFavorite() {
    if (favEdit == null || busy) {
      return;
    }
    const name = favEdit.draft.trim();
    if (!name) {
      return;
    }
    setBusy(true);
    try {
      await onRenameFavorite(favEdit.index, name);
      setFavEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteFavorite() {
    if (favEdit == null || busy) {
      return;
    }
    setBusy(true);
    try {
      await onDeleteFavorite(favEdit.index);
      setFavEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="model-scrim" type="button" aria-label="Close model list" onClick={onClose} />
      <div className="model-sheet" role="dialog" aria-modal="true" aria-label={title} data-testid="model-sheet">
        <header className="model-sheet-head">
          {openCat ? (
            <button
              type="button"
              className="model-sheet-nav"
              onClick={goBack}
              aria-label={openShelf ? "Back to shelves" : "Back to categories"}
            >
              Back
            </button>
          ) : (
            <span className="model-sheet-nav spacer" />
          )}
          <h2>{title}</h2>
          <button type="button" className="model-sheet-nav" onClick={onClose} aria-label="Close model list">
            Close
          </button>
        </header>
        <div className="model-sheet-list">
          {categories.length === 0 && <p className="hint">Model catalog is not loaded.</p>}
          {openCat != null && !showingShelves && (
            <p className="hint" data-testid="dsp-headroom">
              {freePct}% DSP free
            </p>
          )}
          {openCat == null &&
            categories.map((cat) => {
              const kind = hxCategoryKind(cat.name);
              const paint = categoryPaint(kind);
              const fill = cat.id === 23 ? "#e8b84a" : cat.colour || paint.bg;
              const current = cat.name.toLowerCase() === categoryTitle(node.category).toLowerCase();
              return (
                <button
                  key={cat.id}
                  type="button"
                  className={current ? "preset active" : "preset"}
                  data-testid={`model-cat-${cat.id}`}
                  onClick={() => {
                    setOpenCat(cat);
                    setOpenShelf(null);
                    setFavEdit(null);
                  }}
                >
                  <span
                    className="inspector-mark model-cat-mark"
                    style={{ backgroundColor: fill, color: cat.id === 23 ? "#1a1408" : paint.fg }}
                  >
                    {cat.id === 23 ? <StarIcon /> : <CategoryIcon category={kind} />}
                  </span>
                  <span>{cat.name}</span>
                </button>
              );
            })}
          {showingShelves &&
            shelves.map((shelf) => (
              <button
                key={shelf.name}
                type="button"
                className="preset"
                data-testid={`model-shelf-${shelf.name}`}
                onClick={() => setOpenShelf(shelf)}
              >
                <span />
                <span>{shelf.name}</span>
              </button>
            ))}
          {liveCat != null &&
            !showingShelves &&
            models.map((m) => {
              const current =
                m.favorite == null &&
                m.id === currentId &&
                (shelfStereo === undefined || node.stereo === shelfStereo);
              const tight = !current && !modelFits(m, headroom, shelfStereo);
              const favIndex = m.favorite;
              if (favIndex != null) {
                const editing = favEdit?.index === favIndex;
                const kind = hxCategoryKind(m.category ?? "fx");
                const paint = categoryPaint(kind);
                return (
                  <div key={`fav:${favIndex}`} className="fav-row">
                    <div className="preset-row">
                      <button
                        type="button"
                        className={tight ? "preset dsp-tight" : "preset"}
                        data-testid={`model-fav-${favIndex}`}
                        disabled={busy}
                        aria-disabled={tight || busy}
                        onClick={() => {
                          if (tight) {
                            return;
                          }
                          void pick(m.id, liveCat.paired, shelfStereo, favIndex);
                        }}
                      >
                        <span
                          className="fav-cat-mark"
                          style={{ backgroundColor: paint.bg, color: paint.fg }}
                          aria-hidden
                        >
                          <CategoryIcon category={kind} />
                        </span>
                        <span>{m.name}</span>
                      </button>
                      <button
                        type="button"
                        className="inspector-fav"
                        data-testid={`fav-rename-${favIndex}`}
                        aria-label={`Rename ${m.name}`}
                        aria-expanded={editing && favEdit.mode === "rename"}
                        disabled={busy}
                        onClick={() => {
                          setFavEdit(
                            editing && favEdit.mode === "rename"
                              ? null
                              : { index: favIndex, name: m.name, mode: "rename", draft: m.name },
                          );
                        }}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className="inspector-clear"
                        data-testid={`fav-delete-${favIndex}`}
                        aria-label={`Delete ${m.name}`}
                        aria-expanded={editing && favEdit.mode === "delete"}
                        disabled={busy}
                        onClick={() => {
                          setFavEdit(
                            editing && favEdit.mode === "delete"
                              ? null
                              : { index: favIndex, name: m.name, mode: "delete", draft: m.name },
                          );
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                    {editing && favEdit.mode === "rename" && (
                      <form
                        className="fav-save"
                        data-testid={`fav-rename-form-${favIndex}`}
                        onSubmit={(ev) => {
                          ev.preventDefault();
                          void renameFavorite();
                        }}
                      >
                        <label className="fav-save-label">
                          Favorite name
                          <input
                            className="fav-save-input"
                            value={favEdit.draft}
                            maxLength={32}
                            autoComplete="off"
                            data-testid={`fav-rename-name-${favIndex}`}
                            onChange={(ev) => setFavEdit({ ...favEdit, draft: ev.target.value })}
                          />
                        </label>
                        <div className="fav-save-actions">
                          <button type="button" className="fav-save-cancel" onClick={() => setFavEdit(null)}>
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="fav-save-ok"
                            disabled={busy || favEdit.draft.trim() === ""}
                          >
                            Rename
                          </button>
                        </div>
                      </form>
                    )}
                    {editing && favEdit.mode === "delete" && (
                      <div className="fav-save" data-testid={`fav-delete-form-${favIndex}`}>
                        <p className="hint">Delete {favEdit.name} from the Helix?</p>
                        <div className="fav-save-actions">
                          <button type="button" className="fav-save-cancel" onClick={() => setFavEdit(null)}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="fav-save-ok danger"
                            data-testid={`fav-delete-confirm-${favIndex}`}
                            disabled={busy}
                            onClick={() => void deleteFavorite()}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <button
                  key={m.id}
                  type="button"
                  className={current ? "preset active" : tight ? "preset dsp-tight" : "preset"}
                  data-testid={`model-id-${m.id}`}
                  disabled={busy}
                  aria-disabled={tight || busy}
                  onClick={() => {
                    if (tight) {
                      return;
                    }
                    void pick(m.id, liveCat.paired, shelfStereo);
                  }}
                >
                  <span />
                  <span>{m.name}</span>
                </button>
              );
            })}
        </div>
      </div>
    </>
  );
}

function Inspector({
  node,
  client,
  blocks,
  setBlocks,
  setError,
  onMutate,
  onOpenPicker,
  onClear,
  onSaveFavorite,
}: {
  node: ChainNode;
  client: BridgeClient;
  blocks: DumpBlock[];
  setBlocks: (blocks: DumpBlock[]) => void;
  setError: (msg: string | null) => void;
  onMutate: () => void;
  onOpenPicker?: () => void;
  onClear?: () => void | Promise<void>;
  onSaveFavorite?: (name: string) => void | Promise<void>;
}) {
  const paint = categoryPaint(node.category);
  const category = categoryTitle(node.category);
  const empty = node.id.startsWith("empty:");
  const eqDump = node.dumps.find((d) => isParametricEq(d.model_id, d.model));
  const [eqOpen, setEqOpen] = useState(false);
  const [favOpen, setFavOpen] = useState(false);
  const [favName, setFavName] = useState("");
  const [favBusy, setFavBusy] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  useEffect(() => {
    setEqOpen(false);
    setFavOpen(false);
    setActionsOpen(false);
    setClearOpen(false);
  }, [node.id]);
  const showCategory = !empty && category.toLowerCase() !== node.title.toLowerCase();
  const canGraph = Boolean(eqDump && !empty);
  const hasActions = canGraph || Boolean(onSaveFavorite) || Boolean(onClear);
  const head = (
    <>
      <span className="inspector-mark" style={{ backgroundColor: paint.bg, color: paint.fg }}>
        <CategoryIcon category={node.category} />
      </span>
      <div className="inspector-copy">
        <h2 title={node.title}>{node.title}</h2>
        {empty ? <p className="hint">Tap to add a model</p> : showCategory && <p className="hint">{category}</p>}
      </div>
    </>
  );
  return (
    <>
      <div className="inspector-title">
        {onOpenPicker ? (
          <button
            type="button"
            className="inspector-head inspector-pick"
            style={{ borderLeftColor: paint.bg }}
            data-testid="model-pick"
            aria-haspopup="dialog"
            aria-label={empty ? "Add a model" : `Change model, ${node.title}`}
            onClick={onOpenPicker}
          >
            {head}
          </button>
        ) : (
          <header className="inspector-head" style={{ borderLeftColor: paint.bg }}>
            {head}
          </header>
        )}
        {hasActions ? (
          <button
            type="button"
            className="inspector-more"
            data-testid="inspector-actions"
            aria-label="Block actions"
            aria-haspopup="true"
            aria-expanded={actionsOpen}
            onClick={() => {
              setFavOpen(false);
              setClearOpen(false);
              setActionsOpen((v) => !v);
            }}
          >
            <MoreIcon />
          </button>
        ) : null}
      </div>
      {actionsOpen && hasActions ? (
        <div className="inspector-actions" data-testid="inspector-actions-menu">
          {canGraph ? (
            <button
              type="button"
              className="inspector-action"
              data-testid="eq-graph-open"
              onClick={() => {
                setActionsOpen(false);
                setEqOpen(true);
              }}
            >
              <GraphIcon />
              EQ graph
            </button>
          ) : null}
          {onSaveFavorite ? (
            <button
              type="button"
              className="inspector-action"
              data-testid="save-favorite"
              onClick={() => {
                setActionsOpen(false);
                setFavName(node.title);
                setFavOpen(true);
              }}
            >
              <StarIcon />
              Save as favorite
            </button>
          ) : null}
          {onClear ? (
            <button
              type="button"
              className="inspector-action danger"
              data-testid="clear-block"
              onClick={() => {
                setActionsOpen(false);
                setClearOpen(true);
              }}
            >
              <TrashIcon />
              Remove block
            </button>
          ) : null}
        </div>
      ) : null}
      {clearOpen && onClear ? (
        <div className="fav-save" data-testid="clear-block-form">
          <p className="hint">Remove {node.title} from this slot?</p>
          <div className="fav-save-actions">
            <button type="button" className="fav-save-cancel" onClick={() => setClearOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="fav-save-ok danger"
              data-testid="clear-block-confirm"
              onClick={() => {
                void Promise.resolve(onClear()).finally(() => {
                  setClearOpen(false);
                });
              }}
            >
              Remove
            </button>
          </div>
        </div>
      ) : null}
      {favOpen && onSaveFavorite ? (
        <form
          className="fav-save"
          data-testid="save-favorite-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            const name = favName.trim();
            if (!name || favBusy) {
              return;
            }
            setFavBusy(true);
            void Promise.resolve(onSaveFavorite(name))
              .then(() => {
                setFavOpen(false);
                setError(null);
              })
              .catch((err) => {
                setError(err instanceof Error ? err.message : String(err));
              })
              .finally(() => {
                setFavBusy(false);
              });
          }}
        >
          <label className="fav-save-label">
            Favorite name
            <input
              className="fav-save-input"
              value={favName}
              maxLength={32}
              autoComplete="off"
              data-testid="save-favorite-name"
              onChange={(ev) => setFavName(ev.target.value)}
            />
          </label>
          <div className="fav-save-actions">
            <button type="button" className="fav-save-cancel" onClick={() => setFavOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="fav-save-ok" disabled={favBusy || favName.trim() === ""}>
              Save
            </button>
          </div>
        </form>
      ) : null}
      {eqOpen && eqDump ? (
        <EqGraph
          dump={eqDump}
          client={client}
          blocks={blocks}
          setBlocks={setBlocks}
          setError={setError}
          onClose={() => setEqOpen(false)}
        />
      ) : null}
      {empty
        ? null
        : node.dumps.map((dump, i) => {
        const meta = blockMeta(dump.block, dump.subslot);
        const model = dump.model_id ?? meta?.model ?? node.model;
        const heading =
          node.dumps.length > 1 ? (dump.model_name ?? meta?.title ?? `Cab ${i + 1}`) : null;
        const params =
          dump.knobs && dump.knobs.length > 0
            ? dump.knobs.map(knobToParam)
            : (catalog[model]?.params ?? []).filter((p) => p.source === "live");
        return (
          <div className="block-params" key={`${dump.block}:${dump.subslot}`}>
            {heading && <h3>{heading}</h3>}
            {typeof dump.assign === "number" && (
              <AssignRow dump={dump} client={client} setError={setError} onMutate={onMutate} />
            )}
            {params.map((p) => (
              <ParamRow
                key={p.index}
                param={p}
                dump={dump}
                client={client}
                blocks={blocks}
                setBlocks={setBlocks}
                setError={setError}
                onMutate={onMutate}
              />
            ))}
            {typeof dump.trails === "boolean" && (
              <TrailsRow
                dump={dump}
                client={client}
                blocks={blocks}
                setBlocks={setBlocks}
                setError={setError}
                onMutate={onMutate}
              />
            )}
            {params.length === 0 &&
              dump.params.map((v, pi) => (
                <div className="row" key={pi}>
                  <label>{pi}</label>
                  <span className="param-value">{String(v)}</span>
                </div>
              ))}
          </div>
        );
      })}
    </>
  );
}

function TrailsRow({
  dump,
  client,
  blocks,
  setBlocks,
  setError,
  onMutate,
}: {
  dump: DumpBlock;
  client: BridgeClient;
  blocks: DumpBlock[];
  setBlocks: (blocks: DumpBlock[]) => void;
  setError: (msg: string | null) => void;
  onMutate: () => void;
}) {
  const on = dump.trails === true;
  return (
    <div className="row">
      <label>Trails</label>
      <button
        className={on ? "toggle on" : "toggle"}
        type="button"
        aria-pressed={on}
        aria-label="Trails"
        data-testid="trails-toggle"
        onClick={() => {
          const next = !on;
          setBlocks(
            blocks.map((b) =>
              b.block === dump.block && b.subslot === dump.subslot ? { ...b, trails: next } : b,
            ),
          );
          onMutate();
          client.request({ op: "set_trails", block: dump.block, value: next }).catch((err: unknown) => {
            setError(err instanceof BridgeError ? err.message : String(err));
          });
        }}
      >
        {on ? "On" : "Off"}
      </button>
      <span />
    </div>
  );
}

function AssignRow({
  dump,
  client,
  setError,
  onMutate,
}: {
  dump: DumpBlock;
  client: BridgeClient;
  setError: (msg: string | null) => void;
  onMutate: () => void;
}) {
  const value = dump.assign ?? 0;
  const menu = dump.assign_menu;
  if (menu && menu.length > 0) {
    return (
      <div className="row assign-row">
        <label>Assign</label>
        <select
          className="select-pill"
          aria-label="Input or output assign"
          defaultValue={value}
          onChange={(ev) => {
            const n = Number(ev.target.value);
            onMutate();
            client.request({ op: "set_assign", block: dump.block, value: n }).catch((err: unknown) => {
              setError(err instanceof BridgeError ? err.message : String(err));
            });
          }}
        >
          {menu.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <span />
      </div>
    );
  }
  return (
    <div className="row">
      <label>Assign</label>
      <input
        type="number"
        min={0}
        max={16}
        aria-label="Input or output assign"
        defaultValue={value}
        onBlur={(ev) => {
          const n = Number(ev.target.value);
          if (!Number.isInteger(n)) {
            return;
          }
          onMutate();
          client.request({ op: "set_assign", block: dump.block, value: n }).catch((err: unknown) => {
            setError(err instanceof BridgeError ? err.message : String(err));
          });
        }}
      />
      <span />
    </div>
  );
}

function ParamRow({
  param,
  dump,
  client,
  blocks,
  setBlocks,
  setError,
  onMutate,
}: {
  param: CatalogParam;
  dump: DumpBlock;
  client: BridgeClient;
  blocks: DumpBlock[];
  setBlocks: (blocks: DumpBlock[]) => void;
  setError: (msg: string | null) => void;
  onMutate: () => void;
}) {
  const raw = dump.params[param.index];
  const debounce = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (debounce.current) {
        window.clearTimeout(debounce.current);
      }
    };
  }, []);

  function patch(value: number | boolean) {
    setBlocks(
      blocks.map((b) =>
        b.block === dump.block && b.subslot === dump.subslot
          ? { ...b, params: b.params.map((v, i) => (i === param.index ? value : v)) }
          : b,
      ),
    );
  }

  async function send(op: string, extra: Record<string, number | boolean>) {
    try {
      onMutate();
      await client.request({
        op,
        block: dump.block,
        param: param.index,
        subslot: dump.subslot,
        ...extra,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const name = paramLabel(param.name);
  const choices = param.choices;

  if (choices && choices.length > 0) {
    const base = choiceWireBase(param.min);
    const n = choiceIndex(
      typeof raw === "number" ? raw - base : typeof raw === "boolean" ? raw : undefined,
      choices.length,
    );
    const labeledBool = param.usb === "bool";
    const pick = (v: number) => {
      if (labeledBool) {
        const on = v !== 0;
        patch(on);
        void send("set_bool", { value: on });
      } else {
        const wire = v + base;
        patch(wire);
        void send("set_int", { value: wire });
      }
    };
    if (usesChoiceSegment(choices.length)) {
      return (
        <div className="row choice-row">
          <label>{name}</label>
          <div className="choice-seg" role="radiogroup" aria-label={name}>
            {choices.map((label, i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={i === n}
                onClick={() => pick(i)}
              >
                {label}
              </button>
            ))}
          </div>
          <span />
        </div>
      );
    }
    return (
      <div className="row assign-row">
        <label>{name}</label>
        <select
          className="select-pill"
          aria-label={name}
          value={n}
          onChange={(ev) => pick(Number(ev.target.value))}
        >
          {choices.map((label, i) => (
            <option key={i} value={i}>
              {label}
            </option>
          ))}
        </select>
        <span />
      </div>
    );
  }

  if (param.usb === "bool") {
    const on = Boolean(raw);
    return (
      <div className="row">
        <label>{paramLabel(param.name)}</label>
        <button
          className={on ? "toggle on" : "toggle"}
          aria-pressed={on}
          onClick={() => {
            patch(!on);
            void send("set_bool", { value: !on });
          }}
        >
          {on ? "On" : "Off"}
        </button>
        <span />
      </div>
    );
  }

  if (param.usb === "u8" || param.usb === "int") {
    const n = typeof raw === "number" ? raw : 0;
    return (
      <div className="row">
        <label>{paramLabel(param.name)}</label>
        <input
          type="number"
          min={0}
          max={127}
          aria-label={paramLabel(param.name)}
          value={n}
          onChange={(ev) => {
            const v = Number(ev.target.value);
            if (!Number.isInteger(v)) {
              return;
            }
            patch(v);
            void send("set_int", { value: v });
          }}
        />
        <span className="param-value">{param.format ? shownParamValue(n, param) : n}</span>
      </div>
    );
  }

  const scale = uiScale(param);
  const wire = typeof raw === "number" ? raw : 0;
  const useNative = typeof param.min === "number" && typeof param.max === "number";
  const ui = useNative ? wire : wireToUi(wire, scale);
  const max = useNative ? param.max! : scale === "ui10" ? 10 : scale === "percent" ? 100 : 20;
  const min = useNative ? param.min! : scale === "raw" && (param.notes ?? "").includes("dB") ? -60 : 0;
  const step = useNative ? (max - min) / 200 || 0.001 : 0.1;

  return (
    <div className="row">
      <label>{paramLabel(param.name)}</label>
      <input
        type="range"
        aria-label={paramLabel(param.name)}
        min={min}
        max={max}
        step={step}
        value={ui}
        onChange={(ev) => {
          const nextUi = Number(ev.target.value);
          const nextWire = useNative ? nextUi : uiToWire(nextUi, scale);
          patch(nextWire);
          if (debounce.current) {
            window.clearTimeout(debounce.current);
          }
          debounce.current = window.setTimeout(() => {
            void send("set_param", { float: nextWire });
          }, 100);
        }}
      />
      <span className="param-value">{shownParamValue(wire, param)}</span>
    </div>
  );
}
