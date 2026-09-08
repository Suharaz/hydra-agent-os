import type { Server } from "bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Bus } from "../../src/core/bus.ts";
import { Ledger } from "../../src/core/ledger.ts";
import { FuturesRest } from "../../src/venues/binance/rest-futures.ts";
import { recoverFills } from "../../src/venues/binance/recovery.ts";

// Fake `/fapi/v1/userTrades` that ignores `fromId` and always returns the same three trades, so the
// second replay overlaps the first entirely. Trade 3 belongs to an order this process never placed.
const TRADES = [
  { id: 1, orderId: 501, symbol: "BTCUSDT", side: "BUY", price: "60000", qty: "0.001", quoteQty: "60", realizedPnl: "0", commission: "0.02", commissionAsset: "USDT", time: 1, buyer: true, maker: false, positionSide: "BOTH" },
  { id: 2, orderId: 501, symbol: "BTCUSDT", side: "BUY", price: "60001", qty: "0.002", quoteQty: "120", realizedPnl: "0", commission: "0.04", commissionAsset: "USDT", time: 2, buyer: true, maker: false, positionSide: "BOTH" },
  { id: 3, orderId: 999, symbol: "BTCUSDT", side: "SELL", price: "60002", qty: "0.001", quoteQty: "60", realizedPnl: "0", commission: "0.02", commissionAsset: "USDT", time: 3, buyer: false, maker: true, positionSide: "BOTH" },
];

let server: Server<undefined>;
const calls: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      calls.push(url.pathname + url.search);
      if (url.pathname === "/fapi/v1/userTrades") return Response.json(TRADES);
      return Response.json({ code: -1, msg: "unexpected" }, { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

test("overlapping trade ids across two replays insert and emit once", async () => {
  const ledger = new Ledger(":memory:");
  const bus = new Bus();
  const fills: string[] = [];
  bus.on("exec.fill", (f) => fills.push(f.tradeId));

  const id = ledger.insertOrderPending({ intentId: 1, venue: "futures", symbol: "BTCUSDT", side: "BUY", qty: 0.003, clientId: "hydra-1", tSentNs: 1 });
  ledger.updateOrderAck(id, { extId: "501", status: "NEW", tAckNs: 2, latencyMs: 1 });

  const rest = new FuturesRest({ baseUrl: `http://127.0.0.1:${server.port}`, key: "k", secret: "s" });
  const deps = { ledger, futuresRest: rest, futuresSymbols: ["BTCUSDT"], bus };

  const first = await recoverFills(deps);
  expect(first).toEqual({ inserted: 2, skipped: 1 });
  expect(fills).toEqual(["1", "2"]);
  expect(ledger.lastTradeId("futures", "BTCUSDT")).toBe(2);

  const second = await recoverFills(deps);
  expect(second).toEqual({ inserted: 0, skipped: 3 });
  expect(fills).toEqual(["1", "2"]);
  ledger.close();
});

test("S05: identical numeric trade id on different symbols → two distinct fills", async () => {
  // Two symbols each have a trade with id=42; old UNIQUE(venue, trade_id) would drop the second.
  const ledger = new Ledger(":memory:");
  const bus = new Bus();
  const fills: Array<{ tradeId: string; symbol: string }> = [];
  bus.on("exec.fill", (f) => fills.push({ tradeId: f.tradeId, symbol: f.symbol }));

  // Two orders on different symbols, both with ext_id "700".
  const idBtc = ledger.insertOrderPending({ intentId: 1, venue: "futures", symbol: "BTCUSDT", side: "BUY", qty: 0.001, clientId: "hydra-a", tSentNs: 1 });
  ledger.updateOrderAck(idBtc, { extId: "700", status: "NEW", tAckNs: 2, latencyMs: 1 });
  const idEth = ledger.insertOrderPending({ intentId: 1, venue: "futures", symbol: "ETHUSDT", side: "BUY", qty: 0.01, clientId: "hydra-b", tSentNs: 1 });
  ledger.updateOrderAck(idEth, { extId: "700", status: "NEW", tAckNs: 2, latencyMs: 1 });

  const crossServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const sym = url.searchParams.get("symbol");
      if (url.pathname === "/fapi/v1/userTrades" && sym === "BTCUSDT")
        return Response.json([{ id: 42, orderId: 700, symbol: "BTCUSDT", side: "BUY", price: "60000", qty: "0.001", quoteQty: "60", realizedPnl: "0", commission: "0", commissionAsset: "USDT", time: 1, buyer: true, maker: false, positionSide: "BOTH" }]);
      if (url.pathname === "/fapi/v1/userTrades" && sym === "ETHUSDT")
        return Response.json([{ id: 42, orderId: 700, symbol: "ETHUSDT", side: "BUY", price: "3000", qty: "0.01", quoteQty: "30", realizedPnl: "0", commission: "0", commissionAsset: "USDT", time: 1, buyer: true, maker: false, positionSide: "BOTH" }]);
      return Response.json({ code: -1, msg: "unexpected" }, { status: 404 });
    },
  });
  try {
    const rest = new FuturesRest({ baseUrl: `http://127.0.0.1:${crossServer.port}`, key: "k", secret: "s" });
    const result = await recoverFills({ ledger, futuresRest: rest, futuresSymbols: ["BTCUSDT", "ETHUSDT"], bus });
    // Both fills must be inserted and emitted — old code with UNIQUE(venue, trade_id) would drop one.
    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(fills).toHaveLength(2);
    expect(fills.find((f) => f.symbol === "BTCUSDT")?.tradeId).toBe("42");
    expect(fills.find((f) => f.symbol === "ETHUSDT")?.tradeId).toBe("42");
    // Idempotent second replay: both already recorded.
    const r2 = await recoverFills({ ledger, futuresRest: rest, futuresSymbols: ["BTCUSDT", "ETHUSDT"], bus });
    expect(r2.inserted).toBe(0);
  } finally {
    crossServer.stop(true);
    ledger.close();
  }
});

test("S05: drains more than one page without advancing the durable cursor past an unresolved earlier fill", async () => {
  const ledger = new Ledger(":memory:");
  const trades = Array.from({ length: 1001 }, (_, n) => ({ ...TRADES[0], id: n + 1, orderId: n === 0 ? 999 : 501 }));
  const local = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const from = Number(url.searchParams.get("fromId") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      return Response.json(trades.filter((t) => t.id >= from).slice(0, limit));
    },
  });
  try {
    const known = ledger.insertOrderPending({ intentId: 1, venue: "futures", symbol: "BTCUSDT", side: "BUY", qty: 1, clientId: "known-page", tSentNs: 1 });
    ledger.updateOrderAck(known, { extId: "501", status: "FILLED", tAckNs: 2, latencyMs: 1 });
    const rest = new FuturesRest({ baseUrl: `http://127.0.0.1:${local.port}`, key: "k", secret: "s" });
    const deps = { ledger, futuresRest: rest, futuresSymbols: ["BTCUSDT"], bus: new Bus() };
    expect((await recoverFills(deps)).inserted).toBe(1000);
    const missing = ledger.insertOrderPending({ intentId: 1, venue: "futures", symbol: "BTCUSDT", side: "BUY", qty: 1, clientId: "missing-page", tSentNs: 1 });
    ledger.updateOrderAck(missing, { extId: "999", status: "FILLED", tAckNs: 2, latencyMs: 1 });
    expect((await recoverFills(deps)).inserted).toBe(1);
    expect((await recoverFills(deps)).inserted).toBe(0);
    expect(ledger.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fills").get()?.n).toBe(1001);
  } finally { local.stop(true); ledger.close(); }
});
