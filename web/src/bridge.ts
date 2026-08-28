export const SERVICE_UUID = "363e0bb2-e8d2-5efd-a0ca-f430385a2b5c";
export const CMD_UUID = "6bbfcaf0-a29a-5a62-b736-8b5db334d342";
export const RSP_UUID = "37470314-79b2-5e4b-a54d-3080f3806886";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type Command = {
  op: string;
  [key: string]: JsonValue;
};

export type Reply = {
  ok: boolean;
  op?: string;
  id?: number;
  error?: string;
  [key: string]: JsonValue | undefined;
};

export type Transport = {
  name: "wifi" | "bluetooth";
  send(cmd: Command, timeoutMs: number): Promise<Reply>;
  close(): Promise<void>;
};

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export const TRANSPORT_KEY = "tonerelay.transport";
const LEGACY_TRANSPORT_KEY = "hxbridge.transport";

export function rememberedTransport(): "wifi" | "bluetooth" | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  const v = localStorage.getItem(TRANSPORT_KEY) ?? localStorage.getItem(LEGACY_TRANSPORT_KEY);
  return v === "wifi" || v === "bluetooth" ? v : null;
}

export function rememberTransport(name: "wifi" | "bluetooth"): void {
  localStorage.setItem(TRANSPORT_KEY, name);
  localStorage.removeItem(LEGACY_TRANSPORT_KEY);
}

export function forgetTransport(): void {
  localStorage.removeItem(TRANSPORT_KEY);
  localStorage.removeItem(LEGACY_TRANSPORT_KEY);
}

export function timeoutFor(op: string): number {
  if (
    op === "get_state" ||
    op === "get_param" ||
    op === "get_assign" ||
    op === "list_presets" ||
    op === "topology" ||
    op === "select_preset" ||
    op === "preset_info" ||
    op === "save_preset" ||
    op === "list_setlists" ||
    op === "list_irs" ||
    op === "list_models" ||
    op === "set_model" ||
    op === "clear_block"
  ) {
    return 45_000;
  }
  return 15_000;
}

const CHUNK = 160;
const FLAG_FIRST = 0x01;
const FLAG_LAST = 0x02;

export function encodeGattChunks(payload: Uint8Array): Uint8Array[] {
  const total = payload.length === 0 ? 2 : payload.length;
  const body = payload.length === 0 ? new TextEncoder().encode("{}") : payload;
  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset < total) {
    const piece = body.subarray(offset, offset + CHUNK);
    const flags =
      (offset === 0 ? FLAG_FIRST : 0) | (offset + piece.length >= total ? FLAG_LAST : 0);
    const header = new Uint8Array(5 + piece.length);
    header[0] = flags;
    header[1] = (total >> 8) & 0xff;
    header[2] = total & 0xff;
    header[3] = (offset >> 8) & 0xff;
    header[4] = offset & 0xff;
    header.set(piece, 5);
    out.push(header);
    offset += piece.length;
  }
  return out;
}

export function createGattReassembler(): {
  push(data: Uint8Array): Uint8Array | null;
  reset(): void;
} {
  let buf: Uint8Array | null = null;
  let total = 0;
  return {
    reset() {
      buf = null;
      total = 0;
    },
    push(data: Uint8Array): Uint8Array | null {
      if (data.length < 5) {
        return null;
      }
      const flags = data[0];
      const claimed = (data[1] << 8) | data[2];
      const offset = (data[3] << 8) | data[4];
      const piece = data.subarray(5);
      if (flags & FLAG_FIRST) {
        total = claimed;
        buf = new Uint8Array(total);
      }
      if (!buf) {
        total = Math.max(claimed, offset + piece.length);
        buf = new Uint8Array(total);
      }
      const end = offset + piece.length;
      if (end > buf.length) {
        const next = new Uint8Array(end);
        next.set(buf);
        buf = next;
      }
      buf.set(piece, offset);
      if (flags & FLAG_LAST) {
        const done = buf.subarray(0, total);
        buf = null;
        return done;
      }
      return null;
    },
  };
}

export class WsTransport implements Transport {
  readonly name = "wifi" as const;
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: number }
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (ev) => {
      try {
        const reply = JSON.parse(String(ev.data)) as Reply;
        const id = reply.id;
        if (typeof id === "number") {
          const wait = this.pending.get(id);
          if (wait) {
            window.clearTimeout(wait.timer);
            this.pending.delete(id);
            wait.resolve(reply);
          }
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    this.ws.addEventListener("close", () => {
      for (const wait of this.pending.values()) {
        window.clearTimeout(wait.timer);
        wait.reject(new BridgeError("Wi-Fi connection closed"));
      }
      this.pending.clear();
    });
  }

  static connect(url?: string): Promise<WsTransport> {
    const loc = window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    const target = url ?? `${proto}//${loc.host}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(target);
      const fail = () => reject(new BridgeError("Wi-Fi WebSocket failed"));
      ws.addEventListener("error", fail, { once: true });
      ws.addEventListener(
        "open",
        () => {
          ws.removeEventListener("error", fail);
          resolve(new WsTransport(ws));
        },
        { once: true },
      );
    });
  }

  send(cmd: Command, timeoutMs: number): Promise<Reply> {
    const id = this.nextId++;
    const payload = { ...cmd, id };
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`timeout waiting for ${cmd.op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}

export function bluetoothAvailable(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.bluetooth);
}

export class BleTransport implements Transport {
  readonly name = "bluetooth" as const;
  private device: BluetoothDevice;
  private cmd: BluetoothRemoteGATTCharacteristic;
  private server: BluetoothRemoteGATTServer;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    device: BluetoothDevice,
    server: BluetoothRemoteGATTServer,
    cmd: BluetoothRemoteGATTCharacteristic,
  ) {
    this.device = device;
    this.server = server;
    this.cmd = cmd;
  }

  static async fromDevice(device: BluetoothDevice): Promise<BleTransport> {
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const cmd = await service.getCharacteristic(CMD_UUID);
    const rsp = await service.getCharacteristic(RSP_UUID);
    await rsp.startNotifications();
    return new BleTransport(device, server, cmd);
  }

  static async connect(): Promise<BleTransport> {
    if (!bluetoothAvailable()) {
      throw new BridgeError("Web Bluetooth is not available on this browser");
    }
    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ name: "ToneRelay" }],
        optionalServices: [SERVICE_UUID],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") {
        device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: [SERVICE_UUID],
        });
      } else {
        throw err;
      }
    }
    return BleTransport.fromDevice(device);
  }

  static async reconnect(): Promise<BleTransport | null> {
    if (!bluetoothAvailable() || typeof navigator.bluetooth.getDevices !== "function") {
      return null;
    }
    const devices = await navigator.bluetooth.getDevices();
    const device = devices.find((d) => d.name === "ToneRelay");
    if (!device?.gatt) {
      return null;
    }
    return BleTransport.fromDevice(device);
  }

  send(cmd: Command, timeoutMs: number): Promise<Reply> {
    const run = async (): Promise<Reply> => {
      const service = await this.server.getPrimaryService(SERVICE_UUID);
      const rsp = await service.getCharacteristic(RSP_UUID);
      const assembler = createGattReassembler();
      const body = new TextEncoder().encode(JSON.stringify(cmd));
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          rsp.removeEventListener("characteristicvaluechanged", onNotify);
          reject(new BridgeError(`timeout waiting for ${cmd.op}`));
        }, timeoutMs);
        const onNotify = (ev: Event) => {
          const target = ev.target as BluetoothRemoteGATTCharacteristic;
          const value = target.value;
          if (!value) {
            return;
          }
          const done = assembler.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
          if (!done) {
            return;
          }
          window.clearTimeout(timer);
          rsp.removeEventListener("characteristicvaluechanged", onNotify);
          try {
            resolve(JSON.parse(new TextDecoder().decode(done)) as Reply);
          } catch (err) {
            reject(err instanceof Error ? err : new BridgeError(String(err)));
          }
        };
        rsp.addEventListener("characteristicvaluechanged", onNotify);
        this.cmd.writeValueWithoutResponse(body).catch((err: unknown) => {
          window.clearTimeout(timer);
          rsp.removeEventListener("characteristicvaluechanged", onNotify);
          reject(err instanceof Error ? err : new BridgeError(String(err)));
        });
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async close(): Promise<void> {
    if (this.device.gatt?.connected) {
      this.device.gatt.disconnect();
    }
  }
}

export class BridgeClient {
  constructor(readonly transport: Transport) {}

  async request(cmd: Command): Promise<Reply> {
    const reply = await this.transport.send(cmd, timeoutFor(cmd.op));
    if (!reply.ok) {
      throw new BridgeError(reply.error ? String(reply.error) : `${cmd.op} failed`);
    }
    return reply;
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
