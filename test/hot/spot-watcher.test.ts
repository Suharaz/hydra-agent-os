// Spot TP/SL watcher invariants (final-review regressions): a trigger with zero attributed holding
// must not sell unrelated account balance, and a failed close must keep the watcher armed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bus } from "../../src/core/bus.ts";
import { openLedger, type Ledger } from "../../src/core/ledger.ts";
import type { Intent } from "../../src/core/types.ts";
import { Executor } from "../../src/hot/executor.ts";
import { Positions } from "../../src/hot/positions.ts";
import { SpotRest } from "../../src/venues/binance/rest-spot.ts";
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

/** A filled spot BUY of `heldQty` ETH with a TP at 3100 tracked by a watcher; the account also holds `accountEth`. */
async function rig(heldQty: number, accountEth: number): Promise<Rig> {
  const ledger = openLedger(":memory:");
  const bus = new Bus();
  const spotRest = new SpotRest({ baseUrl: fake.spotUrl, key: "k", secret: "s" });
  const positions = new Positions({ ledger, spot: spotRest, bus, spotSymbols: ["ETHUSDT"], reconcileMs: 0, snapMs: 0 });
  const executor = new Executor({ kernel: { evaluate: () => null }, futuresRest: null, spotRest, onchain: null, ledger, positions, feed: null, symbols: () => null, stateDir, env: fakeEnv(), bus, fillsFromAck: true });
  positions.start();
  executor.start();
  const intent: Intent = { id: `w-${heldQty}`, engine: "liqfade", venue: "spot", symbol: "ETHUSDT", side: "BUY", qty: 1, type: "LIMIT", price: 2900, tp: 3100, sl: 2800, ttlMs: 60_000, paper: false, tSignalNs: 1 };
  const intentRow = ledger.insertIntent(intent);
  const orderId = ledger.insertOrderPending({ intentId: intentRow, venue: "spot", symbol: "ETHUSDT", side: "BUY", qty: 1, price: 2900, clientId: `hydra-liqfade-${intent.id}`, tSentNs: 1 });
  if (heldQty > 0) {
    ledger.insertFill({ orderId, venue: "spot", symbol: "ETHUSDT", tradeId: `t-${intent.id}`, side: "BUY", price: 2900, qty: heldQty, fee: 0, feeAsset: "USDT", tsNs: 2 });
    bus.emit("exec.fill", { orderId, venue: "spot", symbol: "ETHUSDT", tradeId: `t-${intent.id}`, side: "BUY", price: 2900, qty: heldQty, fee: 0, feeAsset: "USDT", tsNs: 2 });
  }
  fake.state.spotBalances.set("ETH", accountEth);
  expect(executor.rebuildWatcher({ id: orderId, intentId: intentRow, venue: "spot", symbol: "ETHUSDT", side: "BUY", qty: 1, price: 2900, clientId: `hydra-liqfade-${intent.id}`, status: "FILLED", tSentNs: 1 })).toBe(true);
  return { ledger, bus, executor, positions, orderId };
}

describe("spot watcher", () => {
  test("zero attributed holding: take-profit trigger sells nothing from the account", async () => {
    const r = await rig(0, 5);
    try {
      fake.state.spotOrders.length = 0;
      r.bus.emit("feed.trade", { venue: "spot", symbol: "ETHUSDT", price: 3200, qty: 1, side: "BUY", tsNs: 3 });
      // The trigger is processed synchronously up to the quantity check: the watcher is gone, no order was sent.
      await until(() => r.executor.watcherCount("ETHUSDT") === 0);
      expect(fake.state.spotOrders.filter((o) => o.type === "MARKET")).toEqual([]);
      expect(fake.state.spotBalances.get("ETH")).toBe(5);
    } finally {
      r.executor.stop();
      r.positions.stop();
      r.ledger.close();
    }
  });

  test("close only the attributed quantity, not the whole account balance", async () => {
    const r = await rig(0.1, 10.1);
    try {
      fake.state.spotOrders.length = 0;
      r.bus.emit("feed.trade", { venue: "spot", symbol: "ETHUSDT", price: 3200, qty: 1, side: "BUY", tsNs: 3 });
      await until(() => fake.state.spotOrders.some((o) => o.type === "MARKET"));
      const close = fake.state.spotOrders.find((o) => o.type === "MARKET");
      expect(Number(close?.origQty)).toBeCloseTo(0.1, 6);
      expect(fake.state.spotBalances.get("ETH")).toBeCloseTo(10, 6);
    } finally {
      r.executor.stop();
      r.positions.stop();
      r.ledger.close();
    }
  });

  test("a failed close keeps the watcher armed for the next trigger", async () => {
    const r = await rig(0.5, 0.5);
    try {
      fake.state.spotOrders.length = 0;
      fake.failNext("/api/v3/order", 503, { code: -1001, msg: "internal error" }, (p) => p.type === "MARKET");
      r.bus.emit("feed.trade", { venue: "spot", symbol: "ETHUSDT", price: 3200, qty: 1, side: "BUY", tsNs: 3 });
      await until(() => r.executor.watcherCount("ETHUSDT") === 1 && r.ledger.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orders WHERE status = 'FAILED'").get()?.n === 1);
      r.bus.emit("feed.trade", { venue: "spot", symbol: "ETHUSDT", price: 3201, qty: 1, side: "BUY", tsNs: 4 });
      await until(() => fake.state.spotOrders.some((o) => o.type === "MARKET"));
      expect(r.executor.watcherCount("ETHUSDT")).toBe(0);
      expect(fake.state.spotBalances.has("ETH")).toBe(false);
    } finally {
      r.executor.stop();
      r.positions.stop();
      r.ledger.close();
    }
  });
});
