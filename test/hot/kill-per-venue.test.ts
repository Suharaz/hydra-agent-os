import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AlertLevel } from "../../src/core/alert.ts";
import { Bus } from "../../src/core/bus.ts";
import { openLedger, type Ledger } from "../../src/core/ledger.ts";
import { readKillLock, writeKillLock } from "../../src/core/state.ts";
import type { Fill, Intent, KillEvent, KillFailedEvent } from "../../src/core/types.ts";
import { kill, stopKill, type KillDeps } from "../../src/hot/kill.ts";
import { Positions } from "../../src/hot/positions.ts";
import { Executor } from "../../src/hot/executor.ts";
import { recoverFills } from "../../src/venues/binance/recovery.ts";
import { FuturesRest } from "../../src/venues/binance/rest-futures.ts";
import { SpotRest } from "../../src/venues/binance/rest-spot.ts";
import { cleanup, tempDir, until } from "../core/helpers.ts";
import { fakeEnv, startFakeBinance, type FakeBinance } from "./fake-binance.ts";

let fake: FakeBinance;
let ledger: Ledger;
let stateDir: string;
let futuresRest: FuturesRest;
let spotRest: SpotRest;

beforeAll(() => {
  fake = startFakeBinance();
  ledger = openLedger(":memory:");
  stateDir = tempDir();
  futuresRest = new FuturesRest({ baseUrl: fake.futuresUrl, key: "k", secret: "s" });
  spotRest = new SpotRest({ baseUrl: fake.spotUrl, key: "k", secret: "s" });
});

afterAll(() => {
  fake.stop();
  ledger.close();
  cleanup(stateDir);
});

function deps(bus: Bus, alerts: Array<[AlertLevel, string]>): KillDeps {
  return {
    futuresRest,
    spotRest,
    onchain: null,
    ledger,
    positions: null,
    stateDir,
    env: fakeEnv({ KILL_FLATTEN_ALL_SPOT: "1" }),
    risk: { kill_verify_attempts_before_alert: 3 },
    bus,
    alertFn: (level, msg) => {
      alerts.push([level, msg]);
    },
    // Deterministic: the loop yields to the event loop without waiting on the wall clock.
    sleep: () => Promise.resolve(),
  };
}

async function seedExposure(): Promise<void> {
  fake.state.futuresPositions.set("BTCUSDT", 0.5);
  fake.state.spotBalances.set("ETH", 2);
  await futuresRest.order({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: 0.1, price: 50_000, timeInForce: "GTC", newClientOrderId: "hydra-basis-rest1" });
  await spotRest.order({ symbol: "ETHUSDT", side: "SELL", type: "LIMIT", quantity: 1, price: 9_000, timeInForce: "GTC", newClientOrderId: "hydra-liqfade-rest2" });
}

describe("kill per venue", () => {
  test("1 futures + 1 spot position -> both flat, orders cancelled, kill.lock residue empty", async () => {
    await seedExposure();
    const bus = new Bus();
    const alerts: Array<[AlertLevel, string]> = [];
    const kills: KillEvent[] = [];
    bus.on("system.kill", (e) => kills.push(e));

    const r = await kill("test-drawdown", deps(bus, alerts));

    expect(r.flat).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.residue).toEqual({ futures: [], spot: [], dex: [] });
    expect(alerts).toEqual([]);
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ reason: "test-drawdown", actor: "kill" });

    expect(fake.state.futuresPositions.size).toBe(0);
    expect(fake.state.spotBalances.has("ETH")).toBe(false);
    expect(fake.state.futuresOpenOrders).toHaveLength(0);
    expect(fake.state.spotOpenOrders).toHaveLength(0);

    const futMarket = fake.state.futuresOrders.filter((o) => o.type === "MARKET");
    expect(futMarket).toHaveLength(1);
    expect(futMarket[0]).toMatchObject({ symbol: "BTCUSDT", side: "SELL", reduceOnly: true, executedQty: "0.5" });
    const spotMarket = fake.state.spotOrders.filter((o) => o.type === "MARKET");
    expect(spotMarket).toHaveLength(1);
    expect(spotMarket[0]).toMatchObject({ symbol: "ETHUSDT", side: "SELL", executedQty: "2" });
    expect(fake.state.requests.some((q) => q.method === "DELETE" && q.path === "/fapi/v1/allOpenOrders" && q.params.symbol === "BTCUSDT")).toBe(true);
    expect(fake.state.requests.some((q) => q.method === "DELETE" && q.path === "/api/v3/openOrders" && q.params.symbol === "ETHUSDT")).toBe(true);

    const lock = readKillLock(stateDir);
    expect(lock?.reason).toBe("test-drawdown");
    expect(lock?.residue).toEqual({ futures: [], spot: [], dex: [] });
  });

  test("re-running kill re-verifies and re-flattens new residue (never a no-op)", async () => {
    fake.state.futuresPositions.set("ETHUSDT", -1);
    const r = await kill("again", deps(new Bus(), []));
    expect(r.flat).toBe(true);
    expect(fake.state.futuresPositions.size).toBe(0);
    expect(readKillLock(stateDir)?.reason).toBe("again");
  });

  test("under a 418 ban the loop keeps retrying, alerts after 3 attempts, and finishes flat once unbanned", async () => {
    await seedExposure();
    fake.setBanned(true);
    const bus = new Bus();
    const alerts: Array<[AlertLevel, string]> = [];
    const failed: KillFailedEvent[] = [];
    bus.on("system.kill.failed", (e) => failed.push(e));

    const pending = kill("banned", deps(bus, alerts));
    await until(() => alerts.length === 1 && failed.length >= 2);
    expect(alerts[0]?.[0]).toBe("critical");
    expect(failed[0]?.attempt).toBe(3);
    // Lock was written before the first pass and carries the unknown-residue marker while banned.
    expect(readKillLock(stateDir)?.reason).toBe("banned");
    expect(fake.state.futuresPositions.get("BTCUSDT")).toBe(0.5);

    fake.setBanned(false);
    const r = await pending;
    expect(r.flat).toBe(true);
    expect(r.attempts).toBeGreaterThanOrEqual(4);
    expect(alerts).toHaveLength(1);
    expect(fake.state.futuresPositions.size).toBe(0);
    expect(fake.state.spotBalances.has("ETH")).toBe(false);
    expect(fake.state.futuresOpenOrders).toHaveLength(0);
    expect(fake.state.spotOpenOrders).toHaveLength(0);
    expect(readKillLock(stateDir)?.residue).toEqual({ futures: [], spot: [], dex: [] });
  });

  test("S06/S07: durable engine-specific kill fills close only real HYDRA spot quantity exactly once", async () => {
    const venue = startFakeBinance();
    const db = openLedger(":memory:");
    const dir = tempDir();
    const bus = new Bus();
    const positions = new Positions({ ledger: db, bus });
    positions.start();
    const spot = new SpotRest({ baseUrl: venue.spotUrl, key: "k", secret: "s" });
    try {
      for (const [engine, qty] of [["basis", 0.04], ["liqfade", 0.06]] as const) {
        const i: Intent = { id: engine, engine, venue: "spot", symbol: "ETHUSDT", side: "BUY", qty, type: "MARKET", ttlMs: 0, paper: false, tSignalNs: 1 };
        const orderId = db.insertOrderPending({ intentId: db.insertIntent(i), venue: i.venue, symbol: i.symbol, side: i.side, qty, clientId: `hydra-${engine}-seed`, tSentNs: 1, status: "FILLED" });
        const fill: Fill = { orderId, venue: i.venue, symbol: i.symbol, side: i.side, qty, price: 3000, fee: 0, feeAsset: "USDT", tradeId: engine, tsNs: 1 };
        db.insertFill(fill);
        bus.emit("exec.fill", fill);
      }
      venue.state.spotBalances.set("ETH", 10.1);
      venue.state.prices.set("ETHUSDT", 3300);
      const original = spot.order.bind(spot);
      spot.order = (params) => {
        expect(db.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM orders WHERE client_id = ?").get(params.newClientOrderId)?.n).toBe(1);
        return original(params);
      };
      const result = await kill("owned-only", { futuresRest: null, spotRest: spot, onchain: null, ledger: db, positions, stateDir: dir, env: { killFlattenAllSpot: false }, risk: { kill_verify_attempts_before_alert: 1 }, bus, alertFn: () => undefined });
      expect(result.flat).toBe(true);
      expect(venue.state.spotBalances.get("ETH")).toBeCloseTo(10, 10);
      expect(venue.state.spotOrders.map((o) => Number(o.executedQty))).toEqual([0.04, 0.06]);
      expect(positions.attributed("spot")).toEqual([]);
      expect(positions.realizedToday()).toBeCloseTo(30, 8);
      await recoverFills({ ledger: db, spotRest: spot, spotSymbols: ["ETHUSDT"], bus });
      expect(positions.realizedToday()).toBeCloseTo(30, 8);
      expect(db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM trades").get()?.n).toBe(2);
    } finally {
      positions.stop();
      db.close();
      venue.stop();
      cleanup(dir);
    }
  });

  test("S10: missing clients preserve prior futures and DEX residue", async () => {
    const db = openLedger(":memory:");
    const dir = tempDir();
    const bus = new Bus();
    const positions = new Positions({ ledger: db, bus });
    const residue = { futures: [{ symbol: "BTCUSDT", qty: 1 }], spot: [], dex: [{ symbol: "TOKEN", qty: 2 }] };
    writeKillLock(dir, { reason: "prior", at: Date.now(), residue }, "kill");
    bus.on("system.kill.failed", () => stopKill());
    try {
      const result = await kill("unqueryable", { futuresRest: null, spotRest: null, onchain: null, ledger: db, positions, stateDir: dir, env: { killFlattenAllSpot: false }, risk: { kill_verify_attempts_before_alert: 1 }, bus, alertFn: () => undefined });
      expect(result.flat).toBe(false);
      expect(readKillLock(dir)?.residue).toEqual(residue);
    } finally { db.close(); cleanup(dir); }
  });

  test("S08: kill waits for admitted entry requests and blocks later legs", async () => {
    const venue = startFakeBinance();
    const db = openLedger(":memory:");
    const dir = tempDir();
    const bus = new Bus();
    const fut = new FuturesRest({ baseUrl: venue.futuresUrl, key: "k", secret: "s" });
    const spot = new SpotRest({ baseUrl: venue.spotUrl, key: "k", secret: "s" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const original = fut.order.bind(fut);
    fut.order = async (p) => {
      if (!p.reduceOnly) { started = true; await gate; }
      return original(p);
    };
    const ex = new Executor({ kernel: { evaluate: () => null }, futuresRest: fut, spotRest: spot, onchain: null, ledger: db, positions: null, feed: null, symbols: () => null, stateDir: dir, env: fakeEnv(), bus, fillsFromAck: true });
    ex.start();
    try {
      const first: Intent = { id: "barrier-first", engine: "basis", venue: "futures", symbol: "BTCUSDT", side: "BUY", qty: 0.01, type: "MARKET", ttlMs: 0, paper: false, tSignalNs: 1 };
      const submit = ex.submit({ ...first, id: "barrier", legs: [first, { ...first, id: "barrier-second", venue: "spot" }] });
      await until(() => started);
      let completed = false;
      const killing = kill("barrier", { futuresRest: fut, spotRest: spot, onchain: null, ledger: db, positions: null, stateDir: dir, env: { killFlattenAllSpot: false }, risk: { kill_verify_attempts_before_alert: 1 }, bus, awaitEntries: () => ex.awaitEntries(), alertFn: () => undefined }).then((r) => { completed = true; return r; });
      await Promise.resolve();
      expect(completed).toBe(false);
      release();
      expect((await submit).ok).toBe(false);
      expect((await killing).flat).toBe(true);
      expect(venue.state.spotOrders).toEqual([]);
      expect(venue.state.futuresPositions.size).toBe(0);
    } finally { release(); ex.stop(); db.close(); venue.stop(); cleanup(dir); }
  });
});
