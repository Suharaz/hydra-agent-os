import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AlertLevel } from "../../src/core/alert.ts";
import { Bus } from "../../src/core/bus.ts";
import { openLedger, type Ledger } from "../../src/core/ledger.ts";
import { writeKillLock } from "../../src/core/state.ts";
import type { Fill, Intent } from "../../src/core/types.ts";
import { Executor } from "../../src/hot/executor.ts";
import { reconcile, recoverBoot } from "../../src/hot/recovery-boot.ts";
import { Positions } from "../../src/hot/positions.ts";
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

describe("recovery boot", () => {
  test("rebuilds a spot TP/SL watcher from an open order, cancels unknown HYDRA orders, flags kill.lock", async () => {
    // A previous process wrote the intent + PENDING order, then died before the ack landed.
    const intent: Intent = { id: "abc", engine: "liqfade", venue: "spot", symbol: "ETHUSDT", side: "BUY", qty: 1, type: "LIMIT", price: 2900, tp: 3100, sl: 2800, ttlMs: 60_000, paper: false, tSignalNs: 1 };
    const intentRow = ledger.insertIntent(intent);
    const orderId = ledger.insertOrderPending({ intentId: intentRow, venue: "spot", symbol: "ETHUSDT", side: "BUY", qty: 1, price: 2900, clientId: "hydra-liqfade-abc", tSentNs: 1 });
    // A ledger order the venue no longer has (filled or cancelled while we were down).
    const staleId = ledger.insertOrderPending({ intentId: intentRow, venue: "spot", symbol: "ETHUSDT", side: "BUY", qty: 1, clientId: "hydra-liqfade-gone", tSentNs: 1 });

    const known = await spotRest.order({ symbol: "ETHUSDT", side: "BUY", type: "LIMIT", quantity: 1, price: 2900, timeInForce: "GTC", newClientOrderId: "hydra-liqfade-abc" });
    await spotRest.order({ symbol: "ETHUSDT", side: "BUY", type: "LIMIT", quantity: 1, price: 2500, timeInForce: "GTC", newClientOrderId: "hydra-basis-unknown" });
    await futuresRest.order({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: 0.1, price: 50_000, timeInForce: "GTC", newClientOrderId: "hydra-cexdex-unknown" });
    const foreign = await spotRest.order({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: 0.1, price: 50_000, timeInForce: "GTC", newClientOrderId: "web_manual_1" });
    fake.state.futuresPositions.set("BTCUSDT", 0.25);
    writeKillLock(stateDir, { reason: "prior-crash", at: Date.now(), residue: { futures: [], spot: [], dex: [] } }, "kill");

    const bus = new Bus();
    const executor = new Executor({
      kernel: { evaluate: () => null },
      futuresRest,
      spotRest,
      onchain: null,
      ledger,
      positions: null,
      feed: null,
      symbols: () => null,
      stateDir,
      env: fakeEnv(),
      bus,
      fillsFromAck: true,
    });
    executor.start();
    const alerts: Array<[AlertLevel, string]> = [];
    const summary = await recoverBoot({ futuresRest, spotRest, ledger, executor, stateDir, alertFn: (l, m) => void alerts.push([l, m]) });

    expect(summary.matched).toBe(1);
    expect(summary.watchersRebuilt).toBe(1);
    expect(summary.cancelledUnknown).toBe(2);
    expect(summary.expiredStale).toBe(0);
    expect(summary.futuresPositions).toEqual([{ symbol: "BTCUSDT", qty: 0.25 }]);
    expect(summary.killLock?.reason).toBe("prior-crash");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.[0]).toBe("critical");
    expect(alerts[0]?.[1]).toContain("prior-crash");
    expect(executor.watcherCount("ETHUSDT")).toBe(1);

    // Venue: only the known and the foreign orders remain.
    expect(fake.state.spotOpenOrders.map((o) => o.clientOrderId).sort()).toEqual(["hydra-liqfade-abc", "web_manual_1"]);
    expect(fake.state.futuresOpenOrders).toHaveLength(0);
    expect(foreign.orderId).toBeGreaterThan(0);

    // Ledger: the matched order carries the venue id and is NEW; the stale one is EXPIRED.
    const rows = ledger.db.query<{ id: number; status: string; ext_id: string | null }, []>("SELECT id, status, ext_id FROM orders ORDER BY id").all();
    expect(rows.find((r) => r.id === orderId)).toEqual({ id: orderId, status: "NEW", ext_id: String(known.orderId) });
    expect(rows.find((r) => r.id === staleId)?.status).toBe("PENDING");

    // The rebuilt watcher is live: a spot trade through the take-profit cancels the resting order and MARKET-closes.
    fake.state.spotBalances.set("ETH", 1);
    bus.emit("feed.trade", { venue: "spot", symbol: "ETHUSDT", price: 3100, qty: 1, side: "BUY", tsNs: 2 });
    await until(() => fake.state.spotOrders.some((o) => o.type === "MARKET" && o.side === "SELL" && o.symbol === "ETHUSDT"));
    expect(fake.state.spotOpenOrders.map((o) => o.clientOrderId)).toEqual(["web_manual_1"]);
    expect(fake.state.spotBalances.has("ETH")).toBe(false);
    expect(executor.watcherCount("ETHUSDT")).toBe(0);
    const close = fake.state.spotOrders.find((o) => o.type === "MARKET" && o.symbol === "ETHUSDT");
    expect(close?.clientOrderId).toBe(`hydra-liqfade-${orderId}-tp`);
    const closeRow = ledger.db.query<{ status: string }, [string]>("SELECT status FROM orders WHERE client_id = ?").get(`hydra-liqfade-${orderId}-tp`);
    expect(closeRow?.status).toBe("FILLED");
    executor.stop();
  });

  test("reconcile reports venue residue and open orders for unkill", async () => {
    const r = await reconcile({ futuresRest, spotRest, spotSymbols: ["ETHUSDT", "BTCUSDT"] });
    expect(r.residue.futures).toEqual([{ symbol: "BTCUSDT", qty: 0.25 }]);
    expect(r.residue.spot).toEqual([]);
    expect(r.openOrders).toBe(1);
    expect(r.clean).toBe(false);

    fake.state.futuresPositions.clear();
    fake.state.spotOpenOrders.length = 0;
    const clean = await reconcile({ futuresRest, spotRest, spotSymbols: ["ETHUSDT", "BTCUSDT"] });
    expect(clean).toEqual({ residue: { futures: [], spot: [], dex: [] }, openOrders: 0, clean: true });
  });

  test("S02: construction restores real and paper FIFO lots without duplicating realized totals or fees", () => {
    const db = openLedger(":memory:");
    const bus = new Bus();
    const positions = new Positions({ ledger: db, bus });
    positions.start();
    let sequence = 0;
    const fill = (side: "BUY" | "SELL", qty: number, price: number, fee: number, paper = false, venue: "spot" | "futures" = "spot") => {
      const i: Intent = { id: `restore-${++sequence}`, engine: "basis", venue, symbol: "ETHUSDT", side, qty, type: "MARKET", ttlMs: 0, paper, tSignalNs: sequence };
      const orderId = db.insertOrderPending({ intentId: db.insertIntent(i), venue, symbol: i.symbol, side, qty, clientId: i.id, status: paper ? "PAPER" : "FILLED", tSentNs: sequence });
      const f: Fill = { orderId, venue, symbol: i.symbol, side, qty, price, fee, feeAsset: "USDT", tradeId: i.id, tsNs: sequence };
      db.insertFill(f);
      bus.emit("exec.fill", f);
    };
    try {
      fill("BUY", 2, 100, 2);
      fill("SELL", 0.5, 120, 0.5);
      fill("BUY", 5, 100, 0, true);
      fill("BUY", 1, 100, 1, false, "futures");
      const snapshot = positions.snapshot().map((p) => ({ ...p }));
      const realized = positions.realizedToday();
      positions.stop();
      const restored = new Positions({ ledger: db, bus });
      expect(restored.snapshot()).toEqual(snapshot);
      expect(restored.paperQty("spot", "basis", "ETHUSDT")).toBe(5);
      expect(restored.realizedToday()).toBe(realized);
      expect(db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM trades").get()?.n).toBe(1);
      restored.start();
      fill("SELL", 1, 130, 1);
      expect(restored.qty("spot", "basis", "ETHUSDT")).toBe(0.5);
      expect(restored.realizedToday()).toBeCloseTo(37, 10);
      restored.stop();
      const again = new Positions({ ledger: db, bus });
      expect(again.qty("spot", "basis", "ETHUSDT")).toBe(0.5);
      expect(again.realizedToday()).toBeCloseTo(37, 10);
      expect(again.attributed("spot")).toEqual([{ symbol: "ETHUSDT", qty: 0.5 }]);
    } finally { positions.stop(); db.close(); }
  });

  test("S10: unkill reconciliation refuses unqueryable prior futures or DEX residue", async () => {
    const priorLock = { reason: "prior", at: 1, residue: { futures: [{ symbol: "BTCUSDT", qty: 1 }], spot: [], dex: [{ symbol: "TOKEN", qty: 1 }] } };
    const report = await reconcile({ futuresRest: null, spotRest: null, spotSymbols: [], priorLock });
    expect(report.clean).toBe(false);
    expect(report.residue).toEqual(priorLock.residue);
  });
});
