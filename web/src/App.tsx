import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import rawCatalog from "../../hxbridge/model_param_index.json";
import {
  BleTransport,
  BridgeClient,
  BridgeError,
  bluetoothAvailable,
  rememberTransport,
  rememberedTransport,
  WsTransport,
  type Transport,
} from "./bridge";
import {
  bankPreset,
  blockMeta,
  type Catalog,
  type CatalogParam,
  type DumpBlock,
  knobToParam,
  choiceIndex,
  usesChoiceSegment,
  paramLabel,
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
  type ModelCategory,
  type ModelShelf,
} from "./catalog";
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
import { CategoryIcon, TrashIcon } from "./icons";

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

function setlistLabel(index: number, names: Setlist[]): string {
  const found = names.find((s) => s.index === index)?.name?.trim();
  return found ? found : `Setlist ${index + 1}`;
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
  const [modelCats, setModelCats] = useState<ModelCategory[]>([]);

  useLayoutEffect(() => {
    function syncAppHeight() {
      const h = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${Math.round(h)}px`);
    }
    syncAppHeight();
    window.addEventListener("resize", syncAppHeight);
    window.addEventListener("orientationchange", syncAppHeight);
    window.visualViewport?.addEventListener("resize", syncAppHeight);
    window.visualViewport?.addEventListener("scroll", syncAppHeight);
    return () => {
      window.removeEventListener("resize", syncAppHeight);
      window.removeEventListener("orientationchange", syncAppHeight);
      window.visualViewport?.removeEventListener("resize", syncAppHeight);
      window.visualViewport?.removeEventListener("scroll", syncAppHeight);
    };
  }, []);

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

  async function connect(kind: "bluetooth" | "wifi", auto = false) {
    setError(null);
    setBusy(kind === "bluetooth" ? "Opening Bluetooth…" : "Opening Wi-Fi…");
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
      const info = await next.request({ op: "info" });
      setUsb(Boolean(info.usb));
      setClient(next);
      setTransportName(transport.name);
      rememberTransport(transport.name);
      setBusy("Loading presets…");
      try {
        const listedSets = await next.request({ op: "list_setlists" });
        const rows = (listedSets.setlists as Setlist[]) ?? [];
        if (Array.isArray(rows) && rows.length > 0) {
          setSetlists(rows);
        }
      } catch {
        setSetlists([]);
      }
      const listed = await next.request({ op: "list_presets" });
      const rows = (listed.presets as Preset[]) ?? [];
      const sl = typeof listed.setlist === "number" ? listed.setlist : 0;
      setPresets(rows);
      setSetlist(sl);
      setLoadedSetlist(sl);
      if (typeof listed.index === "number") {
        setSelected(listed.index);
      }
      setBusy("Reading preset…");
      const state = await next.request({ op: "get_state" });
      await applyState(state as {
        blocks?: DumpBlock[];
        paths?: TopoPath[];
        snapshots?: string[];
        setlist?: number;
        index?: number;
      });
      if (typeof state.setlist === "number") {
        setSetlist(state.setlist);
      }
      try {
        const models = await next.request({ op: "list_models" });
        const cats = (models.categories as ModelCategory[]) ?? [];
        setModelCats(
          cats.filter(
            (c) => c.models.length > 0 || (c.shelves ?? []).some((s) => s.models.length > 0),
          ),
        );
      } catch {
        setModelCats([]);
      }
    } catch (err) {
      if (!auto) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (resumeStarted) {
      return;
    }
    const remembered = rememberedTransport();
    if (!remembered) {
      return;
    }
    resumeStarted = true;
    void connect(remembered, true);
  }, []);

  useEffect(() => {
    if (!client) {
      return;
    }
    let on = true;
    const tick = async () => {
      try {
        const ev = await client.request({ op: "events" });
        if (!on || !ev.dirty) {
          return;
        }
        const state = await client.request({ op: "get_state" });
        if (!on) {
          return;
        }
        await applyState(state as {
          blocks?: DumpBlock[];
          paths?: TopoPath[];
          snapshots?: string[];
          setlist?: number;
          index?: number;
        });
        const active = typeof state.setlist === "number" ? state.setlist : loadedSetlist;
        if (typeof active === "number") {
          setLoadedSetlist(active);
          if (active === setlist) {
            const listed = await client.request({ op: "list_presets", setlist: active });
            if (!on) {
              return;
            }
            setPresets((listed.presets as Preset[]) ?? []);
          }
        }
      } catch {
        /* poll is best-effort */
      }
    };
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      on = false;
      window.clearInterval(id);
    };
  }, [client, setlist, loadedSetlist]);

  async function selectPreset(index: number) {
    if (!client) {
      return;
    }
    const { bank, preset } = bankPreset(index);
    setError(null);
    setBusy("Selecting preset…");
    setMenuOpen(false);
    try {
      await client.request({ op: "select_preset", bank, preset, setlist });
      setSelected(index);
      setLoadedSetlist(setlist);
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
      const listed = await client.request({ op: "list_presets", setlist: next });
      setSetlist(next);
      setPresets((listed.presets as Preset[]) ?? []);
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

  async function selectSnapshot(index: number) {
    if (!client) {
      return;
    }
    setError(null);
    setSnapshotIndex(index);
    try {
      await client.request({ op: "select_snapshot", index });
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
    }
  }

  if (!client) {
    return (
      <div className="app">
        <header className="top">
          <h1>ToneRelay</h1>
        </header>
        <div className="connect">
          <p className="eyebrow">Helix floor</p>
          <h2>Connect over Wi-Fi</h2>
          <p className="hint">
            {bleOk
              ? "Wi-Fi is the usual path on this Pi, including iPhone. Bluetooth still works in Chrome, but only on HTTPS."
              : "This browser has no Web Bluetooth. Use Wi-Fi to reach the Helix on this Pi."}
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

  const presetName = presets.find((p) => p.index === selected)?.name;

  return (
    <div className={`app ${menuOpen ? "menu-open" : ""}`}>
      <header className="top">
        <button
          className="menu-btn"
          type="button"
          aria-label={menuOpen ? "Close preset list" : "Open preset list"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
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
        {busy && <span className="busy">{busy}</span>}
      </header>
      {error && <p className="error banner" data-testid="error-banner">{error}</p>}
      <div className="stage">
        <aside className="panel list" id="preset-drawer">
          <h2>Presets</h2>
          <button
            className="save-preset"
            type="button"
            data-testid="save-preset"
            disabled={Boolean(busy) || selected === null || loadedSetlist === null}
            onClick={() => {
              void savePreset();
            }}
          >
            Save
          </button>
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
          {presets.map((p) => (
            <button
              key={p.index}
              data-testid={`preset-${p.index}`}
              className={loadedSetlist === setlist && selected === p.index ? "preset active" : "preset"}
              onClick={() => selectPreset(p.index)}
            >
              <span>{p.index}</span>
              <span>{p.name}</span>
            </button>
          ))}
        </aside>
        {menuOpen && (
          <button className="scrim" type="button" aria-label="Close preset list" onClick={() => setMenuOpen(false)} />
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
}) {
  const boards = useMemo(() => buildChain(blocks, paths), [blocks, paths]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [emptySlot, setEmptySlot] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
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
        await client.request({ op: "move_block", from, to });
        const state = await client.request({ op: "get_state" });
        setBlocks((state.blocks as DumpBlock[]) ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, setBlocks, setError],
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
      try {
        await client.request({ op: "set_bypass", block: dump.block, enabled: next });
        setBlocks(
          blocks.map((b) => (b.block === dump.block ? { ...b, enabled: next } : b)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [blocks, client, setBlocks, setError],
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
          categories={modelCats}
          onClose={() => setPickerOpen(false)}
          onChoose={async (modelId, paired, stereo) => {
            const dump = inspect.dumps[0];
            if (dump == null) {
              return;
            }
            try {
              await client.request({
                op: "set_model",
                block: dump.block,
                model_id: modelId,
                ...(paired ? { pair: true } : {}),
                ...(stereo === undefined ? {} : { stereo }),
              });
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
  onClose,
  onChoose,
}: {
  node: ChainNode;
  blocks: DumpBlock[];
  categories: ModelCategory[];
  onClose: () => void;
  onChoose: (modelId: string, paired: boolean, stereo?: boolean) => Promise<void>;
}) {
  const [openCat, setOpenCat] = useState<ModelCategory | null>(null);
  const [openShelf, setOpenShelf] = useState<ModelShelf | null>(null);
  const [busy, setBusy] = useState(false);
  const currentId = node.dumps[0]?.model_id ?? node.model;
  const shelves = (openCat?.shelves ?? []).filter((s) => s.models.length > 0);
  const showingShelves = openCat != null && openShelf == null && shelves.length > 0;
  const models = openShelf?.models ?? openCat?.models ?? [];
  const title = openShelf?.name ?? openCat?.name ?? "Model";
  const shelfStereo =
    openShelf?.name === "Stereo" ? true : openShelf?.name === "Mono" ? false : undefined;
  const headroom = dspHeadroom(blocks, node.dumps);
  const freePct = Math.max(0, Math.min(100, Math.round(headroom)));

  function goBack() {
    if (openShelf) {
      setOpenShelf(null);
      return;
    }
    setOpenCat(null);
  }

  async function pick(modelId: string, paired: boolean, stereo?: boolean) {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onChoose(modelId, paired, stereo);
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
              const fill = cat.colour || paint.bg;
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
                  }}
                >
                  <span className="inspector-mark model-cat-mark" style={{ backgroundColor: fill, color: paint.fg }}>
                    <CategoryIcon category={kind} />
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
          {openCat != null &&
            !showingShelves &&
            models.map((m) => {
              const current =
                m.id === currentId &&
                (shelfStereo === undefined || node.stereo === shelfStereo);
              const tight = !current && !modelFits(m, headroom, shelfStereo);
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
                    void pick(m.id, openCat.paired, shelfStereo);
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
  onOpenPicker,
  onClear,
}: {
  node: ChainNode;
  client: BridgeClient;
  blocks: DumpBlock[];
  setBlocks: (blocks: DumpBlock[]) => void;
  setError: (msg: string | null) => void;
  onOpenPicker?: () => void;
  onClear?: () => void | Promise<void>;
}) {
  const paint = categoryPaint(node.category);
  const category = categoryTitle(node.category);
  const empty = node.id.startsWith("empty:");
  const showCategory = !empty && category.toLowerCase() !== node.title.toLowerCase();
  const head = (
    <>
      <span className="inspector-mark" style={{ backgroundColor: paint.bg, color: paint.fg }}>
        <CategoryIcon category={node.category} />
      </span>
      <div>
        <h2>{node.title}</h2>
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
        {onClear ? (
          <button
            type="button"
            className="inspector-clear"
            data-testid="clear-block"
            aria-label="Remove block"
            onClick={() => void onClear()}
          >
            <TrashIcon />
          </button>
        ) : null}
      </div>
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
              <AssignRow dump={dump} client={client} setError={setError} />
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
              />
            ))}
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

function AssignRow({
  dump,
  client,
  setError,
}: {
  dump: DumpBlock;
  client: BridgeClient;
  setError: (msg: string | null) => void;
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
}: {
  param: CatalogParam;
  dump: DumpBlock;
  client: BridgeClient;
  blocks: DumpBlock[];
  setBlocks: (blocks: DumpBlock[]) => void;
  setError: (msg: string | null) => void;
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
    const n = choiceIndex(typeof raw === "boolean" || typeof raw === "number" ? raw : undefined, choices.length);
    const labeledBool = param.usb === "bool";
    const pick = (v: number) => {
      if (labeledBool) {
        const on = v !== 0;
        patch(on);
        void send("set_bool", { value: on });
      } else {
        patch(v);
        void send("set_int", { value: v });
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
        <span className="param-value">{n}</span>
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
      <span className="param-value">{useNative ? ui.toFixed(2) : ui.toFixed(1)}</span>
    </div>
  );
}
