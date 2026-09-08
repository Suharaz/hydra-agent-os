// Raw WebSocket wrapper for Binance streams and the spot WS-API.
//
// - One JSON.parse per frame; combined `{stream,data}` and raw frames both become `Frame`.
// - Reconnect with jittered exponential backoff 0.5 s -> 30 s; planned rotation before the 24 h
//   server cutoff (default 23 h) reconnects without backoff.
// - Outbound rate cap (<=10 msgs/s/connection) via a small token bucket.
// - `WebSocket` constructor and clock are injectable so tests never open a socket.

import { logger } from "../../core/log.ts";

export interface Clock {
  nowMs(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realClock: Clock = {
  nowMs: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  // Handles are opaque to callers; Bun accepts its own Timer objects back.
  clearTimeout: (h) => clearTimeout(h as Timer),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as Timer),
};
/** Minimal subset of the WHATWG WebSocket used here; Bun's global satisfies it. */
export interface WsLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WsFactory = (url: string) => WsLike;
export const realWsFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

export const WS_OPEN = 1;

export interface Frame {
  /** Combined-stream name (`btcusdt@aggTrade`) or null for raw frames. */
  stream: string | null;
  /** Event type (`data.e`) when present. */
  e: string | null;
  data: Record<string, unknown>;
}

/**
 * Parses one WebSocket text frame. Combined `{stream, data}` frames are unwrapped; raw frames
 * (single-stream `/ws/...`, `/private`, WS-API responses) are returned as-is with `stream: null`.
 * Returns null for non-object payloads.
 */
export function parseFrame(text: string): Frame | null {
  const obj = JSON.parse(text) as unknown;
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const inner = rec.data;
  if (typeof rec.stream === "string" && typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
    const data = inner as Record<string, unknown>;
    return { stream: rec.stream, e: typeof data.e === "string" ? data.e : null, data };
  }
  return { stream: null, e: typeof rec.e === "string" ? rec.e : null, data: rec };
}

export interface WsCounters {
  frames: number;
  bytes: number;
  reconnects: number;
}

export interface BinanceWsOptions {
  name: string;
  /** Resolved on every (re)connect so listenKeys / rotated URLs are picked up. */
  url: string | (() => string | Promise<string>);
  onFrame: (frame: Frame) => void;
  onOpen?: (reconnect: boolean) => void;
  onClose?: (code: number | undefined, reason: string | undefined) => void;
  wsFactory?: WsFactory;
  clock?: Clock;
  /** Planned reconnect interval; Binance drops connections at 24 h. */
  rotateMs?: number;
  /** Outbound messages per second cap. */
  maxSendPerSec?: number;
}

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const DEFAULT_ROTATE_MS = 23 * 3600 * 1000;

export class BinanceWs {
  readonly name: string;
  readonly counters: WsCounters = { frames: 0, bytes: 0, reconnects: 0 };
  private ws: WsLike | null = null;
  private stopped = true;
  private everOpened = false;
  private attempt = 0;
  private reconnectHandle: unknown = null;
  private rotateHandle: unknown = null;
  private readonly clock: Clock;
  private readonly wsFactory: WsFactory;
  private readonly rotateMs: number;
  private readonly maxSendPerSec: number;
  private sendTokens: number;
  private sendRefillAt: number;
  private readonly sendQueue: string[] = [];
  private sendDrainHandle: unknown = null;
  private readonly log;

  constructor(private readonly opts: BinanceWsOptions) {
    this.name = opts.name;
    this.clock = opts.clock ?? realClock;
    this.wsFactory = opts.wsFactory ?? realWsFactory;
    this.rotateMs = opts.rotateMs ?? DEFAULT_ROTATE_MS;
    this.maxSendPerSec = opts.maxSendPerSec ?? 10;
    this.sendTokens = this.maxSendPerSec;
    this.sendRefillAt = this.clock.nowMs();
    this.log = logger(`ws.${opts.name}`);
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close(1000, "stop");
      } catch {
        // already closed
      }
    }
  }

  /** Force a reconnect now (listenKeyExpired, URL change). Backoff resets. */
  reconnect(reason: string): void {
    if (this.stopped) return;
    this.log.info("reconnect requested", { reason });
    this.attempt = 0;
    this.dropSocket();
    this.scheduleReconnect(0);
  }

  /** Rate-capped send; queued when the bucket is empty. */
  send(payload: string | object): void {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.sendQueue.push(text);
    this.drainSend();
  }

  private drainSend(): void {
    const now = this.clock.nowMs();
    if (now - this.sendRefillAt >= 1000) {
      this.sendTokens = this.maxSendPerSec;
      this.sendRefillAt = now;
    }
    while (this.sendQueue.length > 0 && this.sendTokens > 0 && this.connected) {
      const text = this.sendQueue.shift() as string;
      this.sendTokens--;
      try {
        (this.ws as WsLike).send(text);
      } catch (err) {
        this.log.warn("send failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (this.sendQueue.length > 0 && this.sendDrainHandle === null && this.connected) {
      const wait = Math.max(1, 1000 - (now - this.sendRefillAt));
      this.sendDrainHandle = this.clock.setTimeout(() => {
        this.sendDrainHandle = null;
        this.drainSend();
      }, wait);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      url = typeof this.opts.url === "string" ? this.opts.url : await this.opts.url();
    } catch (err) {
      this.log.warn("url resolution failed", { error: err instanceof Error ? err.message : String(err) });
      this.scheduleReconnect(this.nextBackoff());
      return;
    }
    if (this.stopped) return;
    let ws: WsLike;
    try {
      ws = this.wsFactory(url);
    } catch (err) {
      this.log.warn("socket construction failed", { error: err instanceof Error ? err.message : String(err) });
      this.scheduleReconnect(this.nextBackoff());
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const reconnect = this.everOpened;
      if (reconnect) this.counters.reconnects++;
      this.everOpened = true;
      this.attempt = 0;
      this.log.info("connected", { reconnect });
      this.armRotation();
      this.drainSend();
      this.opts.onOpen?.(reconnect);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const text = typeof ev.data === "string" ? ev.data : String(ev.data);
      this.counters.frames++;
      this.counters.bytes += text.length;
      let frame: Frame | null;
      try {
        frame = parseFrame(text);
      } catch {
        this.log.warn("unparseable frame", { head: text.slice(0, 80) });
        return;
      }
      if (frame !== null) this.opts.onFrame(frame);
    };
    ws.onerror = (ev) => {
      if (this.ws !== ws) return;
      const msg = typeof ev === "object" && ev !== null && "message" in ev ? String(ev.message) : "error";
      this.log.warn("socket error", { error: msg });
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearRotation();
      this.log.warn("closed", { code: ev.code, reason: ev.reason });
      this.opts.onClose?.(ev.code, ev.reason);
      if (!this.stopped) this.scheduleReconnect(this.nextBackoff());
    };
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.clearRotation();
    if (ws === null) return;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.onopen = null;
    try {
      ws.close(1000, "reconnect");
    } catch {
      // already closed
    }
  }

  private nextBackoff(): number {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(this.attempt, 10));
    this.attempt++;
    const jitter = base * (0.75 + Math.random() * 0.5);
    return Math.round(Math.min(BACKOFF_MAX_MS, jitter));
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopped || this.reconnectHandle !== null) return;
    this.reconnectHandle = this.clock.setTimeout(() => {
      this.reconnectHandle = null;
      void this.connect();
    }, delayMs);
  }

  private armRotation(): void {
    this.clearRotation();
    this.rotateHandle = this.clock.setTimeout(() => {
      this.rotateHandle = null;
      this.log.info("planned rotation");
      this.attempt = 0;
      this.dropSocket();
      this.scheduleReconnect(0);
    }, this.rotateMs);
  }

  private clearRotation(): void {
    if (this.rotateHandle !== null) {
      this.clock.clearTimeout(this.rotateHandle);
      this.rotateHandle = null;
    }
  }

  private clearTimers(): void {
    this.clearRotation();
    if (this.reconnectHandle !== null) {
      this.clock.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    if (this.sendDrainHandle !== null) {
      this.clock.clearTimeout(this.sendDrainHandle);
      this.sendDrainHandle = null;
    }
  }
}

// ---- URL builders ---------------------------------------------------------

export type FuturesRoute = "/public" | "/market" | "/private";

/**
 * Combined-stream URL. Routed futures paths (`/public`, `/market`) prefix `/stream`; spot and the
 * unrouted fallback use the bare `/stream?streams=` form. Stream names are lowercased by Binance
 * convention (`btcusdt@aggTrade` keeps the camel-case suffix).
 */
export function combinedStreamUrl(base: string, streams: readonly string[], route: FuturesRoute | null = null): string {
  const root = base.replace(/\/+$/, "");
  return `${root}${route ?? ""}/stream?streams=${streams.join("/")}`;
}

/** Single-connection `/ws/<s1>/<s2>` form used by the routed-path probe. */
export function rawStreamUrl(base: string, streams: readonly string[], route: FuturesRoute | null = null): string {
  return `${base.replace(/\/+$/, "")}${route ?? ""}/ws/${streams.join("/")}`;
}

/** Futures user-data URL on the `/private` route (falls back to legacy `/ws/<listenKey>`). */
export function privateStreamUrl(base: string, listenKey: string, routed = true): string {
  const root = base.replace(/\/+$/, "");
  return routed ? `${root}/private/ws?listenKey=${listenKey}&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE` : `${root}/ws/${listenKey}`;
}

export function streamName(symbol: string, suffix: string): string {
  return `${symbol.toLowerCase()}@${suffix}`;
}
