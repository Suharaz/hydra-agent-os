import { describe, expect, test } from "bun:test";
import { BinanceWs, parseFrame, WS_OPEN, type Clock, type Frame, type WsLike } from "../../src/venues/binance/ws.ts";

/** Manual clock: timers are recorded and fired by the test. */
class FakeClock implements Clock {
  now = 1_000_000;
  readonly timers: { fn: () => void; ms: number; id: number }[] = [];
  private seq = 0;
  nowMs(): number {
    return this.now;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const t = { fn, ms, id: ++this.seq };
    this.timers.push(t);
    return t.id;
  }
  clearTimeout(handle: unknown): void {
    const i = this.timers.findIndex((t) => t.id === handle);
    if (i >= 0) this.timers.splice(i, 1);
  }
  setInterval(): unknown {
    throw new Error("unused");
  }
  clearInterval(): void {
    throw new Error("unused");
  }
  /** Fires and removes the oldest pending timer; returns its delay. */
  fireNext(): number {
    const t = this.timers.shift();
    if (t === undefined) throw new Error("no pending timer");
    this.now += t.ms;
    t.fn();
    return t.ms;
  }
}

class FakeWs implements WsLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  open(): void {
    this.readyState = WS_OPEN;
    this.onopen?.({});
  }
  message(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

/** `connect()` awaits the URL resolver; draining a few microtasks lets the socket get created. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("parseFrame", () => {
  test("combined {stream,data} frames are unwrapped and typed by data.e", () => {
    const f = parseFrame(JSON.stringify({ stream: "ethusdt@aggTrade", data: { e: "aggTrade", s: "ETHUSDT", p: "3000.1", q: "2", m: true } }));
    expect(f).toEqual({ stream: "ethusdt@aggTrade", e: "aggTrade", data: { e: "aggTrade", s: "ETHUSDT", p: "3000.1", q: "2", m: true } });
  });

  test("raw frames keep stream null; e is null when absent (bookTicker, WS-API responses)", () => {
    expect(parseFrame(JSON.stringify({ e: "ORDER_TRADE_UPDATE", E: 1, o: { s: "BTCUSDT" } }))).toEqual({
      stream: null,
      e: "ORDER_TRADE_UPDATE",
      data: { e: "ORDER_TRADE_UPDATE", E: 1, o: { s: "BTCUSDT" } },
    });
    const bt = parseFrame(JSON.stringify({ u: 400900217, s: "BNBUSDT", b: "600.1", B: "31.2", a: "600.2", A: "40.6" }));
    expect(bt?.stream).toBeNull();
    expect(bt?.e).toBeNull();
    expect(bt?.data.s).toBe("BNBUSDT");
    // `{stream, data}` with a non-object data is not a combined frame.
    expect(parseFrame(JSON.stringify({ stream: "x", data: 5 }))).toEqual({ stream: null, e: null, data: { stream: "x", data: 5 } });
  });

  test("non-object payloads yield null; invalid JSON throws", () => {
    expect(parseFrame("[1,2]")).toBeNull();
    expect(parseFrame("42")).toBeNull();
    expect(parseFrame("null")).toBeNull();
    expect(() => parseFrame("{not json")).toThrow();
  });
});

describe("BinanceWs", () => {
  test("dispatches combined and raw frames, skips unparseable ones, counts frames", async () => {
    const clock = new FakeClock();
    const sockets: FakeWs[] = [];
    const frames: Frame[] = [];
    const ws = new BinanceWs({
      name: "t",
      url: "wss://example/stream?streams=a",
      onFrame: (f) => frames.push(f),
      wsFactory: (url) => {
        const s = new FakeWs(url);
        sockets.push(s);
        return s;
      },
      clock,
    });
    ws.start();
    await settle();
    expect(sockets).toHaveLength(1);
    const s = sockets[0] as FakeWs;
    s.open();
    expect(ws.connected).toBe(true);
    s.message({ stream: "ethusdt@depth@100ms", data: { e: "depthUpdate", s: "ETHUSDT", U: 1, u: 2, pu: 0, b: [], a: [] } });
    s.message({ e: "markPriceUpdate", s: "ETHUSDT", p: "1" });
    s.message("{broken");
    s.message("[1]");
    expect(frames.map((f) => [f.stream, f.e])).toEqual([
      ["ethusdt@depth@100ms", "depthUpdate"],
      [null, "markPriceUpdate"],
    ]);
    expect(ws.counters.frames).toBe(4);
    expect(ws.counters.reconnects).toBe(0);
    ws.stop();
    expect(s.closed?.code).toBe(1000);
    // No reconnect scheduled after an explicit stop (only the rotation timer was armed, and it is cleared).
    expect(clock.timers).toHaveLength(0);
  });

  test("reconnect backoff doubles from 500 ms with +-25 % jitter, caps at 30 s, resets after a successful open", async () => {
    const clock = new FakeClock();
    const sockets: FakeWs[] = [];
    const ws = new BinanceWs({
      name: "t",
      url: () => "wss://example/ws/x",
      onFrame: () => undefined,
      wsFactory: (url) => {
        const s = new FakeWs(url);
        sockets.push(s);
        return s;
      },
      clock,
      rotateMs: 23 * 3600 * 1000,
    });
    ws.start();
    await settle();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      (sockets[sockets.length - 1] as FakeWs).drop();
      expect(clock.timers).toHaveLength(1);
      delays.push(clock.fireNext());
      await settle();
      expect(sockets).toHaveLength(i + 2);
    }
    const expectedBase = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (let i = 0; i < delays.length; i++) {
      const d = delays[i] as number;
      const base = expectedBase[i] as number;
      expect(d).toBeGreaterThanOrEqual(Math.round(base * 0.75));
      expect(d).toBeLessThanOrEqual(Math.min(30_000, Math.round(base * 1.25)));
    }
    expect(ws.counters.reconnects).toBe(0);

    // A successful open counts as a reconnect (a socket was open before? no: never opened yet) and
    // resets the attempt counter, so the next drop backs off from 500 ms again.
    const live = sockets[sockets.length - 1] as FakeWs;
    live.open();
    expect(ws.counters.reconnects).toBe(0); // first ever open is not a reconnect
    expect(clock.timers.map((t) => t.ms)).toEqual([23 * 3600 * 1000]); // rotation armed
    live.drop();
    expect(clock.timers).toHaveLength(1); // rotation cleared, backoff scheduled
    const afterReset = clock.fireNext();
    expect(afterReset).toBeGreaterThanOrEqual(375);
    expect(afterReset).toBeLessThanOrEqual(625);
    await settle();
    (sockets[sockets.length - 1] as FakeWs).open();
    expect(ws.counters.reconnects).toBe(1);
    ws.stop();
    expect(clock.timers).toHaveLength(0);
  });

  test("planned rotation reconnects immediately without backoff", async () => {
    const clock = new FakeClock();
    const sockets: FakeWs[] = [];
    let opens = 0;
    const ws = new BinanceWs({
      name: "t",
      url: "wss://example/ws/x",
      onFrame: () => undefined,
      onOpen: () => opens++,
      wsFactory: (url) => {
        const s = new FakeWs(url);
        sockets.push(s);
        return s;
      },
      clock,
      rotateMs: 60_000,
    });
    ws.start();
    await settle();
    (sockets[0] as FakeWs).open();
    expect(clock.fireNext()).toBe(60_000); // rotation
    expect((sockets[0] as FakeWs).closed?.reason).toBe("reconnect");
    expect(clock.fireNext()).toBe(0); // immediate reconnect
    await settle();
    expect(sockets).toHaveLength(2);
    (sockets[1] as FakeWs).open();
    expect(opens).toBe(2);
    expect(ws.counters.reconnects).toBe(1);
    ws.stop();
  });
});
