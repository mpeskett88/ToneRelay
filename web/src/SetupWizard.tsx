import { useEffect, useMemo, useRef, useState } from "react";
import { BridgeError, type JsonValue, type Reply } from "./bridge";

const ALLOWED = new Set([
  "HX_ModelCatalog.json",
  "HelixControls.json",
  "Helix.sym",
  "amp.models",
  "cab.models",
  "cabmicirs.models",
  "cabmicirswithpan.models",
  "compressor.models",
  "delay.models",
  "distortion.models",
  "eq.models",
  "filter.models",
  "fixed.models",
  "gate.models",
  "io.models",
  "modulation.models",
  "pitch-synth.models",
  "preamp.models",
  "reverb.models",
  "sendreturn.models",
  "volumepan.models",
  "wah.models",
]);

const NEED = ["HX_ModelCatalog.json", "Helix.sym"];

export type WizardInfo = {
  platform?: string;
  setup_required?: boolean;
  ap_secured?: boolean;
  catalog?: boolean;
  catalog_ready?: boolean;
  catalog_models?: number;
  wifi?: {
    sta?: boolean;
    ssid?: string;
    ip?: string;
    ap?: string;
    ap_ip?: string;
    mdns?: string;
  };
};

type WifiAp = { ssid: string; rssi: number; auth?: string };

async function apiCmd(cmd: { op: string; [k: string]: JsonValue }, timeoutMs = 20_000): Promise<Reply> {
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

function isDroppedConnection(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /failed to fetch|networkerror|timeout waiting/i.test(m);
}

function osHint(): { os: string; path: string; pick: string; extra: string } {
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const plat = uaData?.platform || navigator.platform || "";
  const ua = navigator.userAgent;
  if (/mac/i.test(plat) || /Mac OS X/i.test(ua)) {
    return {
      os: "macOS",
      path: "/Applications/Line6/",
      pick: "HX Edit",
      extra: "The app is a folder; this page reads Contents/Resources inside it.",
    };
  }
  if (/win/i.test(plat) || /Windows/i.test(ua)) {
    return {
      os: "Windows",
      path: "C:\\Program Files (x86)\\Line6\\HX Edit\\",
      pick: "res",
      extra: "",
    };
  }
  return {
    os: "this computer",
    path: "the HX Edit folder",
    pick: "res",
    extra: "",
  };
}

function putFile(name: string, file: File, onProgress: (sent: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/catalog/${encodeURIComponent(name)}`);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        onProgress(ev.loaded, ev.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(new BridgeError(`upload ${name} failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new BridgeError(`upload ${name} failed`));
    xhr.send(file);
  });
}

export function SetupWizard({
  info,
  onInfo,
  onEnterEditor,
  connecting,
  connectError,
}: {
  info: WizardInfo;
  onInfo: (info: WizardInfo) => void;
  onEnterEditor: () => void;
  connecting?: string | null;
  connectError?: string | null;
}) {
  const apSecured = Boolean(info.ap_secured);
  const catalogReady = Boolean(info.catalog_ready || info.catalog);
  const initialStep = !apSecured
    ? "apPass"
    : catalogReady
      ? "done"
      : info.wifi?.sta
        ? "catalog"
        : "home";
  const [step, setStep] = useState(initialStep);
  const [apPass, setApPass] = useState("");
  const [apPass2, setApPass2] = useState("");
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPass, setWifiPass] = useState("");
  const [wifiAps, setWifiAps] = useState<WifiAp[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const hint = useMemo(osHint, []);

  useEffect(() => {
    fileRef.current?.setAttribute("webkitdirectory", "");
    fileRef.current?.setAttribute("directory", "");
  }, [step]);

  useEffect(() => {
    if (!apSecured) {
      return;
    }
    if (catalogReady) {
      setStep("done");
      return;
    }
    if (step === "apPass") {
      setStep(info.wifi?.sta ? "catalog" : "home");
    }
  }, [apSecured, catalogReady, info.wifi?.sta, step]);

  async function refreshInfo(): Promise<WizardInfo> {
    const next = (await fetch("/api/info").then((r) => r.json())) as WizardInfo;
    onInfo(next);
    return next;
  }

  useEffect(() => {
    if (step !== "home") {
      return;
    }
    let on = true;
    const tick = async () => {
      try {
        const next = await refreshInfo();
        if (!on) {
          return;
        }
        if (next.wifi?.sta && next.wifi.ip) {
          setBusy(null);
          setError(null);
        }
      } catch {
        /* still on ToneRelay, or the AP hiccuped */
      }
    };
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      on = false;
      window.clearInterval(id);
    };
  }, [step]);

  async function saveApPassword() {
    setError(null);
    if (apPass.length < 8 || apPass.length > 63) {
      setError("Password must be 8–63 characters.");
      return;
    }
    if (apPass !== apPass2) {
      setError("Passwords do not match.");
      return;
    }
    setBusy("Setting ToneRelay password…");
    setReconnectOpen(true);
    try {
      const reply = await apiCmd({ op: "wifi_ap_password", password: apPass }, 4_000);
      if (!reply.ok && !isDroppedConnection(reply.error)) {
        setReconnectOpen(false);
        throw new BridgeError(String(reply.error ?? "could not set password"));
      }
    } catch (err) {
      if (!isDroppedConnection(err)) {
        setReconnectOpen(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setApPass("");
      setApPass2("");
      setBusy(null);
    }
  }

  async function scanWifi() {
    setError(null);
    setBusy("Scanning 2.4 GHz networks…");
    try {
      const reply = await apiCmd({ op: "wifi_scan" });
      if (!reply.ok) {
        throw new BridgeError(String(reply.error ?? "scan failed"));
      }
      const rows = Array.isArray(reply.aps) ? (reply.aps as WifiAp[]) : [];
      setWifiAps(rows.filter((ap) => ap && typeof ap.ssid === "string" && ap.ssid));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function joinWifi() {
    setError(null);
    const ssid = wifiSsid.trim();
    if (!ssid) {
      setError("Enter a network name.");
      return;
    }
    setBusy("Joining Wi-Fi…");
    const pass = wifiPass;
    setWifiPass("");
    try {
      const reply = await apiCmd({ op: "wifi_join", ssid, password: pass }, 4_000);
      if (reply.ok === false && !isDroppedConnection(reply.error)) {
        throw new BridgeError(String(reply.error ?? "join failed"));
      }
    } catch (err) {
      if (!isDroppedConnection(err)) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(null);
        return;
      }
    }
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try {
        const next = await refreshInfo();
        if (next.wifi?.sta && next.wifi.ip) {
          setBusy(null);
          setError(null);
          return;
        }
      } catch {
        /* AP session may blip while STA comes up */
      }
      await new Promise((r) => window.setTimeout(r, 500));
    }
    setBusy(null);
    setError("Still joining. Stay on ToneRelay; the address appears when the LAN comes up.");
  }

  async function uploadFolder(list: FileList | null) {
    if (!list || list.length === 0) {
      return;
    }
    setError(null);
    const picked = new Map<string, File>();
    for (const file of Array.from(list)) {
      const base = file.name.split(/[/\\]/).pop() ?? file.name;
      if (ALLOWED.has(base)) {
        picked.set(base, file);
      }
    }
    const missing = NEED.filter((n) => !picked.has(n));
    const models = [...picked.keys()].filter((n) => n.endsWith(".models"));
    if (missing.length > 0 || models.length === 0) {
      setError(
        missing.length > 0
          ? `That folder is missing ${missing.join(", ")}.`
          : "That folder has no .models files.",
      );
      return;
    }
    setBusy("Uploading catalog…");
    try {
      let i = 0;
      for (const [name, file] of picked) {
        i += 1;
        setProgress(`${i}/${picked.size} ${name}`);
        await putFile(name, file, (sent, total) => {
          const pct = total ? Math.round((sent / total) * 100) : 0;
          setProgress(`${i}/${picked.size} ${name} ${pct}%`);
        });
      }
      setProgress("Parsing catalog…");
      const res = await fetch("/api/catalog/commit", { method: "POST" });
      const body = (await res.json()) as Reply;
      if (!body.ok) {
        throw new BridgeError(String(body.error ?? "catalog parse failed"));
      }
      setProgress(`Loaded ${String(body.models ?? "")} models`);
      await refreshInfo();
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const staIp = info.wifi?.ip;
  const mdns = info.wifi?.mdns || "tonerelay.local";

  return (
    <div className="connect">
      <p className="eyebrow">First-time setup</p>
      {step === "apPass" && (
        <>
          <h2>Protect ToneRelay</h2>
          <p className="hint">
            Set a password for the ToneRelay hotspot. It is also the fallback network at a gig when
            home Wi-Fi is gone. Use 8 to 63 characters. Setting it disconnects this page; reconnect
            to ToneRelay with the new password.
          </p>
          <div className="stack">
            <label className="setup-field">
              Password
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={63}
                value={apPass}
                onChange={(e) => setApPass(e.target.value)}
              />
            </label>
            <label className="setup-field">
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={63}
                value={apPass2}
                onChange={(e) => setApPass2(e.target.value)}
              />
            </label>
            <button
              className="primary"
              type="button"
              disabled={Boolean(busy) || apPass.length < 8}
              onClick={() => void saveApPassword()}
            >
              Save password
            </button>
          </div>
        </>
      )}
      {step === "home" && (
        <>
          <h2>Home Wi-Fi</h2>
          <p className="hint">
            The radio is 2.4 GHz only. 5 GHz networks will not appear. After it joins, this page
            stays on ToneRelay and shows the LAN address so you can switch your laptop.
          </p>
          <div className="stack setup">
            <button className="secondary" type="button" disabled={Boolean(busy)} onClick={() => void scanWifi()}>
              Scan Wi-Fi
            </button>
            {wifiAps.length > 0 && (
              <ul className="net-list">
                {wifiAps.map((ap) => (
                  <li key={ap.ssid}>
                    <button
                      type="button"
                      className={ap.ssid === wifiSsid ? "net-row on" : "net-row"}
                      onClick={() => setWifiSsid(ap.ssid)}
                    >
                      <span>{ap.ssid}</span>
                      <span className="net-meta">
                        {ap.rssi} dBm{ap.auth === "open" ? " · open" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className="setup-field">
              Network
              <input
                value={wifiSsid}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setWifiSsid(e.target.value)}
              />
            </label>
            <label className="setup-field">
              Password
              <input
                type="password"
                value={wifiPass}
                autoComplete="new-password"
                onChange={(e) => setWifiPass(e.target.value)}
              />
            </label>
            <button
              className="primary"
              type="button"
              disabled={Boolean(busy) || !wifiSsid.trim()}
              onClick={() => void joinWifi()}
            >
              Join Wi-Fi
            </button>
            {staIp ? (
              <p className="hint join-addr">
                On your home network open <strong>http://{staIp}</strong> or{" "}
                <strong>http://{mdns}</strong>
              </p>
            ) : null}
            <button className="secondary" type="button" onClick={() => setStep("catalog")}>
              Continue to catalog
            </button>
          </div>
        </>
      )}
      {step === "catalog" && (
        <>
          <h2>HX Edit resources</h2>
          <p className="hint">
            On {hint.os}, go to <span className="path-hint">{hint.path}</span> and choose{" "}
            <span className="path-hint">{hint.pick}</span>.
            {hint.extra ? ` ${hint.extra}` : ""} Only JSON catalog files are sent to this board.
            Artwork is skipped. Line 6&apos;s files stay on your computer except the copy stored
            here.
          </p>
          <div className="stack">
            <input
              ref={fileRef}
              className="file-hidden"
              type="file"
              multiple
              onChange={(e) => void uploadFolder(e.target.files)}
            />
            <button
              className="primary"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => fileRef.current?.click()}
            >
              Choose {hint.pick}
            </button>
            {progress && <p className="busy">{progress}</p>}
          </div>
        </>
      )}
      {step === "done" && (
        <>
          <h2>Catalog saved</h2>
          <p className="hint">
            This board will keep the names and ranges across reboots. Open the editor to load the
            current preset.
          </p>
          {staIp ? (
            <p className="hint join-addr">
              Later, from home Wi-Fi: <strong>http://{staIp}</strong> or{" "}
              <strong>http://{mdns}</strong>
            </p>
          ) : (
            <p className="hint join-addr">
              Later: <strong>http://{mdns}</strong> or http://192.168.4.1
            </p>
          )}
          <button className="primary" type="button" disabled={Boolean(connecting)} onClick={onEnterEditor}>
            Open editor
          </button>
          {connecting && <p className="busy">{connecting}</p>}
          {connectError && <p className="error">{connectError}</p>}
        </>
      )}
      {busy && <p className="busy">{busy}</p>}
      {error && <p className="error">{error}</p>}
      {reconnectOpen && (
        <>
          <button className="model-scrim" type="button" aria-label="Reconnect to ToneRelay" />
          <div className="overwrite-sheet" role="dialog" aria-modal="true" aria-label="Reconnect to ToneRelay">
            <h2>Reconnect to ToneRelay</h2>
            <p>
              The hotspot password is saved. This page will drop. On your computer, join Wi-Fi
              network <strong>ToneRelay</strong> with that password, then open{" "}
              <strong>http://192.168.4.1</strong> or <strong>http://{mdns}</strong>.
            </p>
          </div>
        </>
      )}
      <p className="disclaimer">
        ToneRelay is an independent project. It is not affiliated with, authorized, endorsed, or
        sponsored by Line 6 or Yamaha Guitar Group. Line 6, Helix, HX, and HX Edit are trademarks
        of their respective owners. Use at your own risk.
      </p>
    </div>
  );
}
