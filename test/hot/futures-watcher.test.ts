// Futures TP/SL watcher invariants: triggers on feed.mark / feed.trade,
// places reduce-only market close, and closes only per-engine attributed holding.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bus } from "../../src/core/bus.ts";
import { openLedger, type Ledger } from "../../src/core/ledger.ts";
import type { Intent } from "../../src/core/types.ts";
import { Executor } from "../../src/hot/executor.ts";
import { Positions } from "../../src/hot/positions.ts";
import { FuturesRest } from "../../src/venues/binance/rest-futures.ts";
import { cleanup, tempDir, until } from "../core/helpers.ts";
import { fakeEnv, type FakeBinance, startFakeBinance } from "./fake-binance.ts";

let fake: FakeBinance;
let stateDir: string;

beforeAll(() => {
  fake = startFakeBinance();
  stateDir = tempDir();
});

afterAll(() => {
  fake.stop();
  cleanup(stateDir);
});

interface Rig {
  ledger: Ledger;
  bus: Bus;
  executor: Executor;
  positions: Positions;
  orderId: number;
}

async function rig(heldQty: number): Promise<Rig> {
  const ledger = openLedger(":memory:");
  const bus = new Bus();
  const futuresRest = new FuturesRest({ baseUrl: fake.futuresUrl, key: "k", secret: "s" });
  const positions = new Positions({ ledger, futures: futuresRest, bus, reconcileMs: 0, snapMs: 0 });
  const executor = new Executor({ kernel: { evaluate: () => null }, futuresRest, spotRest: null, onchain: null, ledger, positions, feed: null, symbols: () => null, stateDir, env: fakeEnv(), bus, fillsFromAck: true });
  positions.start();
  executor.start();
  const intent: Intent = { id: `fw-${heldQty}`, engine: "swing", venue: "futures", symbol: "ETHUSDT", side: "SELL", qty: 1, type: "MARKET", tp: 2400, sl: 2500, ttlMs: 60_000, paper: false, tSignalNs: 1 };
  const intentRow = ledger.insertIntent(intent);
  const orderId = ledger.insertOrderPending({ intentId: intentRow, venue: "futures", symbol: "ETHUSDT", side: "SELL", qty: 1, price: 2450, clientId: `hydra-swing-${intent.id}`, tSentNs: 1 });
  if (heldQty > 0) {
    ledger.insertFill({ orderId, venue: "futures", symbol: "ETHUSDT", tradeId: `ft-${intent.id}`, side: "SELL", price: 2450, qty: heldQty, fee: 0, feeAsset: "USDT", tsNs: 2 });
    bus.emit("exec.fill", { orderId, venue: "futures", symbol: "ETHUSDT", tradeId: `ft-${intent.id}`, side: "SELL", price: 2450, qty: heldQty, fee: 0, feeAsset: "USDT", tsNs: 2 });
    fake.state.futuresPositions.set("ETHUSDT", -heldQty);
  }
  expect(executor.rebuildWatcher({ id: orderId, intentId: intentRow, venue: "futures", symbol: "ETHUSDT", side: "SELL", qty: 1, price: 2450, clientId: `hydra-swing-${intent.id}`, status: "FILLED", tSentNs: 1 })).toBe(true);
  return { ledger, bus, executor, positions, orderId };
}
describe("futures watcher", () => {
  test("rebuilds watcher on boot for futures order and triggers market close on feed.mark", async () => {
    const r = await rig(1);
    try {
      fake.state.futuresOrders.length = 0;
      // Mark price hits TP for SHORT position (price <= 2400)
      r.bus.emit("feed.mark", { symbol: "ETHUSDT", mark: 2390, index: 2390, fundingRate: 0, nextFundingTime: 0, tsNs: 3 });
      await until(() => fake.state.futuresOrders.length > 0);
      const orders = fake.state.futuresOrders.filter((o) => o.type === "MARKET");
      expect(orders.length).toBe(1);
      const closeOrder = orders[0]!;
      expect(closeOrder.symbol).toBe("ETHUSDT");
      expect(closeOrder.side).toBe("BUY");
      expect(closeOrder.reduceOnly).toBe(true);
    } finally {
      r.executor.stop();
      r.positions.stop();
      r.ledger.close();
    }
  });

  test("zero attributed holding: take-profit trigger does not close", async () => {
    const r = await rig(0);
    try {
      fake.state.futuresOrders.length = 0;
      r.bus.emit("feed.mark", { symbol: "ETHUSDT", mark: 2390, index: 2390, fundingRate: 0, nextFundingTime: 0, tsNs: 3 });
      await until(() => r.executor.watcherCount("ETHUSDT") === 0);
      expect(fake.state.futuresOrders.filter((o) => o.type === "MARKET")).toEqual([]);
    } finally {
      r.executor.stop();
      r.positions.stop();
      r.ledger.close();
    }
  });
});
