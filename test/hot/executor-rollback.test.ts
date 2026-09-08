import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bus } from "../../src/core/bus.ts";
import { openLedger, type Ledger } from "../../src/core/ledger.ts";
import type { Intent, RollbackEvent, ThrottleEvent } from "../../src/core/types.ts";
import { Executor } from "../../src/hot/executor.ts";
import { Positions } from "../../src/hot/positions.ts";
import { kill } from "../../src/hot/kill.ts";
import { recoverFills } from "../../src/venues/binance/recovery.ts";
import { FuturesRest } from "../../src/venues/binance/rest-futures.ts";
import { SpotRest } from "../../src/venues/binance/rest-spot.ts";
import { cleanup, tempDir } from "../core/helpers.ts";
import { fakeEnv, startFakeBinance, type FakeBinance } from "./fake-binance.ts";

let fake: FakeBinance;
let ledger: Ledger;
let stateDir: string;

beforeAll(() => {
  fake = startFakeBinance();
  ledger = openLedger(":memory:");
  stateDir = tempDir();
});

afterAll(() => {
  fake.stop();
  ledger.close();
  cleanup(stateDir);
});

function build(bus: Bus, killed: string[], timers: Array<{ fn: () => void; ms: number }>) {
  return new Executor({
    kernel: { evaluate: () => null },
    futuresRest: new FuturesRest({ baseUrl: fake.futuresUrl, key: "k", secret: "s" }),
    spotRest: new SpotRest({ baseUrl: fake.spotUrl, key: "k", secret: "s" }),
    onchain: null,
    ledger,
    positions: null,
    feed: null,
    symbols: () => ({ tickSize: 0.01, stepSize: 0.001 }),
    stateDir,
    env: fakeEnv(),
    bus,
    fillsFromAck: true,
    killFn: async (reason) => {
      killed.push(reason);
    },
    clock: {
      nowNs: () => Bun.nanoseconds(),
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
    },
  });
}

function twoLeg(id: string): Intent {
  const t = Bun.nanoseconds();
  return {
    id,
    engine: "basis",
    venue: "futures",
    symbol: "BTCUSDT",
    side: "BUY",
    qty: 0.01,
    type: "MARKET",
    ttlMs: 1000,
    paper: false,
    tSignalNs: t,
    legs: [
      { id: `${id}-f`, engine: "basis", venue: "futures", symbol: "BTCUSDT", side: "BUY", qty: 0.01, type: "MARKET", ttlMs: 1000, paper: false, tSignalNs: t },
      { id: `${id}-s`, engine: "basis", venue: "spot", symbol: "BTCUSDT", side: "SELL", qty: 0.01, type: "MARKET", ttlMs: 1000, paper: false, tSignalNs: t },
    ],
  };
}

describe("executor rollback", () => {
  test("leg 2 (spot) failure unwinds leg 1 with a futures reduce-only MARKET", async () => {
    const bus = new Bus();
    const killed: string[] = [];
    const rollbacks: RollbackEvent[] = [];
    bus.on("exec.rollback", (e) => rollbacks.push(e));
    const ex = build(bus, killed, []);

    fake.failNext("/api/v3/order", 400, { code: -2010, msg: "Account has insufficient balance for requested action." });
    const r = await ex.submit(twoLeg("rb1"));

    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "error") throw new Error("expected error result");
    expect(r.rolledBack).toBe(true);
    expect(r.residue).toEqual([]);
    expect(killed).toEqual([]);

    const fut = fake.state.futuresOrders;
    expect(fut.map((o) => [o.side, o.type, o.reduceOnly])).toEqual([
      ["BUY", "MARKET", false],
      ["SELL", "MARKET", true],
    ]);
    expect(fut[1]?.executedQty).toBe("0.01");
    expect(fake.state.futuresPositions.has("BTCUSDT")).toBe(false);
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0]).toMatchObject({ intentId: "rb1", venue: "futures", ok: true });

    const rows = ledger.db.query<{ client_id: string; status: string; latency_ms: number | null }, []>("SELECT client_id, status, latency_ms FROM orders ORDER BY id").all();
    expect(rows.map((x) => x.status)).toEqual(["FILLED", "FAILED", "FILLED"]);
    expect(rows[0]?.client_id).toBe("hydra-basis-rb1-f");
    expect(rows[0]?.latency_ms).toBeGreaterThanOrEqual(0);
    expect(rows[2]?.client_id.startsWith("hydra-basis-rb1-f-rb")).toBe(true);
  });

  test("rollback failure escalates to kill('rollback_failed') and reports residue", async () => {
    const bus = new Bus();
    const killed: string[] = [];
    const ex = build(bus, killed, []);
    fake.failNext("/api/v3/order", 400, { code: -2010, msg: "insufficient" });
    // Entry fills; only the reduce-only unwind is rejected.
    fake.failNext("/fapi/v1/order", 500, { code: -1000, msg: "boom" }, (p) => p.reduceOnly === "true");
    const r = await ex.submit(twoLeg("rb2"));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "error") throw new Error("expected error result");
    expect(r.rolledBack).toBe(false);
    expect(r.residue).toEqual([{ venue: "futures", symbol: "BTCUSDT", qty: 0.01 }]);
    expect(killed).toEqual(["rollback_failed"]);
    fake.state.futuresPositions.delete("BTCUSDT");
  });

  test("429 pauses the executor, emits system.throttle, resumes after Retry-After", async () => {
    const bus = new Bus();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const throttles: ThrottleEvent[] = [];
    bus.on("system.throttle", (e) => throttles.push(e));
    const ex = build(bus, [], timers);
    fake.failNext("/fapi/v1/order", 429, { code: -1003, msg: "Too many requests" });
    const single: Intent = { id: "th1", engine: "liqfade", venue: "futures", symbol: "ETHUSDT", side: "BUY", qty: 0.1, type: "MARKET", ttlMs: 1000, paper: false, tSignalNs: Bun.nanoseconds() };
    const r = await ex.submit(single);
    expect(r.ok).toBe(false);
    expect(ex.paused).toBe(true);
    expect(throttles).toHaveLength(1);
    expect(throttles[0]).toMatchObject({ venue: "futures", status: 429 });
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(throttles[0]?.pauseMs);

    const again = await ex.submit({ ...single, id: "th2" });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.reason).toBe("paused");

    timers[0]?.fn();
    expect(ex.paused).toBe(false);
    const ok = await ex.submit({ ...single, id: "th3" });
    expect(ok.ok).toBe(true);
    fake.state.futuresPositions.delete("ETHUSDT");
  });

  test("S01: failed paper second leg reverses only paper lots and cannot select real spot holdings for kill", async () => {
    const venue = startFakeBinance();
    const db = openLedger(":memory:");
    const dir = tempDir();
    const bus = new Bus();
    const positions = new Positions({ ledger: db, bus });
    positions.setCash(10_000);
    positions.start();
    const futuresRest = new FuturesRest({ baseUrl: venue.futuresUrl, key: "k", secret: "s" });
    const spotRest = new SpotRest({ baseUrl: venue.spotUrl, key: "k", secret: "s" });
    const ex = new Executor({ kernel: { evaluate: () => null }, futuresRest, spotRest, onchain: null, ledger: db, positions, feed: null, symbols: () => null, stateDir: dir, env: fakeEnv(), bus });
    try {
      venue.state.spotBalances.set("ETH", 10.1);
      const first: Intent = { id: "paper-first", engine: "basis", venue: "spot", symbol: "ETHUSDT", side: "BUY", qty: 0.1, type: "LIMIT", price: 3000, ttlMs: 1000, paper: true, tSignalNs: 1 };
      const second: Intent = { ...first, id: "paper-missing-price", symbol: "MISSINGUSDT", type: "MARKET", price: undefined };
      const result = await ex.submit({ ...first, id: "paper-root", legs: [first, second] });
      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== "error") throw new Error("expected paper rollback");
      expect(result.rolledBack).toBe(true);
      expect(positions.paperQty("spot", "basis", "ETHUSDT")).toBe(0);
      expect(positions.nav()).toBe(10_000);
      expect(positions.attributed("spot")).toEqual([]);
      const killed = await kill("paper-isolation", { futuresRest, spotRest, onchain: null, ledger: db, positions, stateDir: dir, env: { killFlattenAllSpot: false }, risk: { kill_verify_attempts_before_alert: 1 }, bus, alertFn: () => undefined });
      expect(killed.flat).toBe(true);
      expect(venue.state.spotBalances.get("ETH")).toBe(10.1);
      expect(venue.state.spotOrders).toEqual([]);
      expect(venue.state.futuresOrders).toEqual([]);
    } finally {
      positions.stop();
      db.close();
      venue.stop();
      cleanup(dir);
    }
  });

  test("S04: accepted order with a dropped response is queried by client identity and recovered once", async () => {
    const bus = new Bus();
    const ex = build(bus, [], []);
    const rest = new FuturesRest({ baseUrl: fake.futuresUrl, key: "k", secret: "s" });
    const original = rest.order.bind(rest);
    rest.order = async (p) => { await original(p); throw new Error("response lost"); };
    const own = new Executor({ kernel: { evaluate: () => null }, futuresRest: rest, spotRest: null, onchain: null, ledger, positions: null, feed: null, symbols: () => null, stateDir, env: fakeEnv(), bus, fillsFromAck: true });
    const i: Intent = { ...twoLeg("lost-ack"), id: "lost-ack", legs: undefined };
    const result = await own.submit(i);
    expect(result.ok).toBe(true);
    const before = ledger.db.query<{ qty: number }, []>("SELECT SUM(qty) AS qty FROM fills WHERE symbol = 'BTCUSDT' AND order_id IN (SELECT id FROM orders WHERE client_id = 'hydra-basis-lost-ack')").get()?.qty;
    expect(before).toBe(0.01);
    await recoverFills({ ledger, futuresRest: rest, futuresSymbols: ["BTCUSDT"], bus });
    expect(ledger.db.query<{ qty: number }, []>("SELECT SUM(qty) AS qty FROM fills WHERE order_id IN (SELECT id FROM orders WHERE client_id = 'hydra-basis-lost-ack')").get()?.qty).toBe(before);
    fake.state.futuresPositions.delete("BTCUSDT");
    ex.stop();
  });

  test("S04: fill racing cancellation is reconciled before reversing the terminal executed quantity", async () => {
    const venue = startFakeBinance();
    const db = openLedger(":memory:");
    const dir = tempDir();
    const bus = new Bus();
    const fut = new FuturesRest({ baseUrl: venue.futuresUrl, key: "k", secret: "s" });
    const spot = new SpotRest({ baseUrl: venue.spotUrl, key: "k", secret: "s" });
    const ex = new Executor({ kernel: { evaluate: () => null }, futuresRest: fut, spotRest: spot, onchain: null, ledger: db, positions: null, feed: null, symbols: () => null, stateDir: dir, env: fakeEnv(), bus, fillsFromAck: true });
    try {
      const i = twoLeg("cancel-race");
      i.legs![0] = { ...i.legs![0]!, type: "LIMIT", price: 60_000 };
      venue.failNext("/api/v3/order", 400, { code: -2010, msg: "insufficient" }, () => {
        const entry = venue.state.futuresOrders[0]!;
        entry.status = "FILLED";
        entry.executedQty = "0.01";
        entry.avgPrice = "60000";
        venue.state.futuresOpenOrders.length = 0;
        venue.state.futuresPositions.set("BTCUSDT", 0.01);
        venue.state.futuresTrades.push({ id: 4999, orderId: entry.orderId, symbol: entry.symbol, side: "BUY", price: 60_000, qty: 0.01, time: Date.now() });
        return true;
      });
      const result = await ex.submit(i);
      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== "error") throw new Error("expected second-leg failure");
      expect(result.rolledBack).toBe(true);
      expect(venue.state.futuresPositions.size).toBe(0);
      expect(venue.state.futuresOrders[1]).toMatchObject({ side: "SELL", reduceOnly: true, executedQty: "0.01" });
      expect(db.db.query<{ qty: number }, []>("SELECT SUM(CASE side WHEN 'BUY' THEN qty ELSE -qty END) AS qty FROM fills").get()?.qty).toBe(0);
    } finally { db.close(); venue.stop(); cleanup(dir); }
  });
});
