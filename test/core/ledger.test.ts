import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ledger, openLedger, openReadOnly } from "../../src/core/ledger.ts";
import type { Fill, Intent, Trade } from "../../src/core/types.ts";
import { cleanup, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const open: Ledger[] = [];
afterEach(() => {
  for (const l of open.splice(0)) l.close();
  for (const d of dirs.splice(0)) cleanup(d);
});
function fresh(): { dir: string; path: string; ledger: Ledger } {
  const dir = tempDir();
  dirs.push(dir);
  const path = join(dir, "hydra.sqlite");
  const ledger = openLedger(path);
  open.push(ledger);
  return { dir, path, ledger };
}

const intent: Intent = {
  id: "i-1",
  engine: "liqfade",
  venue: "futures",
  symbol: "BTCUSDT",
  side: "BUY",
  qty: 0.01,
  type: "LIMIT",
  price: 60000,
  ttlMs: 5000,
  paper: true,
  tSignalNs: 123,
};

function fill(tradeId: string, orderId = 1): Fill {
  return { orderId, venue: "futures", symbol: "BTCUSDT", tradeId, side: "BUY", price: 60000, qty: 0.01, fee: 0.01, feeAsset: "USDT", tsNs: 1 };
}

function trade(retBps: number, realized: number, i: number): Trade {
  return { engine: "liqfade", venue: "futures", symbol: "BTCUSDT", openedNs: i, closedNs: i + 1, qty: 0.01, entry: 100, exit: 101, realized, fees: 0.01, retBps };
}

describe("schema", () => {

  test("orders.client_id UNIQUE violation throws", () => {
    const { ledger } = fresh();
    const intentId = ledger.insertIntent(intent);
    const base = { intentId, venue: "futures" as const, symbol: "BTCUSDT", side: "BUY" as const, qty: 0.01, clientId: "c-1", tSentNs: 5 };
    const id = ledger.insertOrderPending(base);
    expect(id).toBeGreaterThan(0);
    expect(() => ledger.insertOrderPending(base)).toThrow(/UNIQUE/);
    ledger.updateOrderAck(id, { extId: "e-1", status: "NEW", tAckNs: 9, latencyMs: 4 });
    const openOrders = ledger.openOrders();
    expect(openOrders.length).toBe(1);
    expect(openOrders[0]).toMatchObject({ id, extId: "e-1", status: "NEW", symbol: "BTCUSDT", clientId: "c-1", latencyMs: 4 });
    ledger.updateOrderStatus(id, "FILLED");
    expect(ledger.openOrders()).toEqual([]);
  });

  test("S04: error/status updates preserve the recoverable order identity", () => {
    const { ledger } = fresh();
    const id = ledger.insertOrderPending({ intentId: ledger.insertIntent(intent), venue: "futures", symbol: "BTCUSDT", side: "SELL", qty: 0.01, price: 60_000, clientId: "lost-response", tSentNs: 1 });
    ledger.updateOrderStatus(id, "PENDING", JSON.stringify({ error: "response lost" }));
    expect(ledger.openOrders()).toContainEqual(expect.objectContaining({ id, symbol: "BTCUSDT", side: "SELL", qty: 0.01, price: 60_000, clientId: "lost-response" }));
    ledger.updateOrderAck(id, { extId: "42", status: "NEW", tAckNs: 2, latencyMs: 1, json: JSON.stringify({ ack: { executedQty: "0" } }) });
    expect(ledger.openOrders()).toContainEqual(expect.objectContaining({ id, extId: "42", symbol: "BTCUSDT", side: "SELL", qty: 0.01 }));
  });

  test("insertFill dedupes on (venue, trade_id) and lastTradeId tracks max", () => {
    const { ledger } = fresh();
    expect(ledger.lastTradeId("futures", "BTCUSDT")).toBeNull();
    expect(ledger.insertFill(fill("10"))).toBeGreaterThan(0);
    expect(ledger.insertFill(fill("10"))).toBeNull();
    expect(ledger.insertFill(fill("9"))).toBeGreaterThan(0);
    expect(ledger.insertFill({ ...fill("10"), venue: "spot" })).toBeGreaterThan(0);
    expect(ledger.lastTradeId("futures", "BTCUSDT")).toBe(10);
    expect(ledger.lastTradeId("futures", "ETHUSDT")).toBeNull();
  });

  test("batched events flush on demand and on close; read-only connection sees them", () => {
    const { ledger, path } = fresh();
    ledger.event("feed.depth", "{}");
    ledger.positionsSnap("[]");
    expect(ledger.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events").get()?.c).toBe(0);
    expect(ledger.flush()).toBe(2);
    ledger.event("x");
    ledger.close();
    open.pop();
    const ro = openReadOnly(path);
    try {
      expect(ro.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events").get()?.c).toBe(2);
      expect(ro.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM positions_snap").get()?.c).toBe(1);
      expect(() => ro.exec("INSERT INTO events (ts_ns, ts_wall, kind) VALUES (1,1,'x')")).toThrow();
    } finally {
      ro.close();
    }
  });
});

describe("durability", () => {
  test("PENDING order survives child process.exit(1) mid-batch", () => {
    const dir = tempDir();
    dirs.push(dir);
    const path = join(dir, "crash.sqlite");
    const ledgerMod = resolve(import.meta.dir, "../../src/core/ledger.ts").replaceAll("\\", "/");
    const script = join(dir, "child.ts");
    writeFileSync(
      script,
      [
        `import { openLedger } from ${JSON.stringify(ledgerMod)};`,
        `const l = openLedger(${JSON.stringify(path.replaceAll("\\", "/"))});`,
        `l.event("never.flushed", "{}");`,
        `l.insertOrderPending({ intentId: 0, venue: "spot", symbol: "BTCUSDT", side: "SELL", qty: 1, clientId: "crash-1", tSentNs: 1 });`,
        `process.exit(1);`,
      ].join("\n"),
    );
    const child = Bun.spawnSync([process.execPath, "run", script], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toBe("");

    const ledger = openLedger(path);
    open.push(ledger);
    const orders = ledger.openOrders();
    expect(orders.length).toBe(1);
    expect(orders[0]).toMatchObject({ clientId: "crash-1", status: "PENDING", symbol: "BTCUSDT", side: "SELL" });
    // Unflushed telemetry is expected to be lost; only the hot lane is write-through.
    expect(ledger.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events").get()?.c).toBe(0);
  });
});

describe("reads", () => {
  test("engineStats on seeded trades", () => {
    const { ledger } = fresh();
    const rets = [10, -5, 20, -30, 15];
    rets.forEach((r, i) => ledger.insertTrade(trade(r, r / 10, i)));
    ledger.insertTrade({ ...trade(999, 1, 99), engine: "basis" });
    const s = ledger.engineStats("liqfade", 1);
    expect(s.trades).toBe(5);
    expect(s.hitRate).toBeCloseTo(3 / 5);
    expect(s.avgRetBps).toBeCloseTo(2);
    const mean = 2;
    const std = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / 4);
    expect(s.sharpe).toBeCloseTo(mean / std);
    // cumulative: 10, 5, 25, -5, 10 -> peak 25, trough -5
    expect(s.maxDdBps).toBe(30);
    expect(ledger.engineStats("convert", 1)).toEqual({ trades: 0, hitRate: 0, avgRetBps: 0, sharpe: 0, maxDdBps: 0 });
    const one = ledger.engineStats("basis", 1);
    expect(one.sharpe).toBe(0);
    expect(one.trades).toBe(1);
  });

  test("pnlByEngine aggregates realized/fees/wins", () => {
    const { ledger } = fresh();
    ledger.insertTrade(trade(1, 2, 1));
    ledger.insertTrade(trade(-1, -1, 2));
    ledger.insertTrade({ ...trade(5, 4, 3), engine: "basis" });
    const rows = ledger.pnlByEngine(0);
    expect(rows).toEqual([
      { engine: "basis", realized: 4, fees: 0.01, trades: 1, wins: 1 },
      { engine: "liqfade", realized: 1, fees: 0.02, trades: 2, wins: 1 },
    ]);
  });

  test("latencyStats p50/p95", () => {
    const { ledger } = fresh();
    const lats = [5, 1, 9, 3, 7, 2, 8, 4, 6, 10];
    lats.forEach((ms, i) => {
      const id = ledger.insertOrderPending({ intentId: 0, venue: "spot", symbol: "X", side: "BUY", qty: 1, clientId: `c${i}`, tSentNs: 1 });
      ledger.updateOrderAck(id, { status: "NEW", tAckNs: 2, latencyMs: ms });
    });
    ledger.insertOrderPending({ intentId: 0, venue: "spot", symbol: "X", side: "BUY", qty: 1, clientId: "unacked", tSentNs: 1 });
    const s = ledger.latencyStats(0);
    expect(s).toEqual({ count: 10, p50: 5, p95: 10 });
    expect(ledger.latencyStats(Date.now() + 1)).toEqual({ count: 0, p50: 0, p95: 0 });
  });

  test("abMetrics groups agent_runs by model", () => {
    const { ledger } = fresh();
    const run = (runId: string, role: "primary" | "shadow", model: string, latencyMs: number, extra: Partial<Parameters<Ledger["insertAgentRun"]>[0]> = {}) =>
      ledger.insertAgentRun({
        runId,
        agent: "commander",
        role,
        model,
        decision: { ok: true },
        applied: role === "primary",
        toolRejections: 0,
        costUsd: 0.01,
        latencyMs,
        schemaValid: true,
        ...extra,
      });
    run("r1", "primary", "openai/a", 100);
    run("r1", "shadow", "google/b", 50, { agreementPct: 80, pnl1hUsd: 1.5 });
    run("r2", "primary", "openai/a", 300, { toolRejections: 2, schemaValid: false });
    run("r2", "shadow", "google/b", 70, { agreementPct: 60, pnl1hUsd: -0.5 });
    run("r3", "primary", "openai/a", 200);
    expect(() => run("r3", "primary", "openai/a", 1)).toThrow(/UNIQUE/);
    ledger.insertAgentRun({ runId: "s1", agent: "sales", role: "primary", model: "openai/a", decision: null, applied: true, toolRejections: 0, costUsd: 5, latencyMs: 1, schemaValid: true });

    const m = ledger.abMetrics("commander", 1);
    expect(Object.keys(m).sort()).toEqual(["google/b", "openai/a"]);
    expect(m["openai/a"]).toEqual({ runs: 3, costUsd: 0.03, p50LatencyMs: 200, schemaValidRate: 2 / 3, toolRejectRate: 1 / 3, agreementPct: null, pnl1hUsd: null });
    expect(m["google/b"]).toEqual({ runs: 2, costUsd: 0.02, p50LatencyMs: 50, schemaValidRate: 1, toolRejectRate: 0, agreementPct: 70, pnl1hUsd: 1 });

    expect(ledger.updateAgentRun("r1", "primary", { applied: false, agreementPct: 55 })).toBe(1);
    expect(ledger.updateAgentRun("nope", "primary", { applied: false })).toBe(0);
    expect(ledger.abMetrics("commander", 1)["openai/a"]?.agreementPct).toBe(55);
  });

  test("llmCostToday / dataSpendToday / recentVetoes / pnl_daily upsert", () => {
    const { ledger } = fresh();
    ledger.insertLlmCall({ runId: "r", agent: "coach", role: "primary", model: "a/b", promptTokens: 1, completionTokens: 1, costUsd: 0.25, latencyMs: 1, schemaValid: true });
    ledger.insertLlmCall({ runId: "r", agent: "coach", role: "shadow", model: "a/c", promptTokens: 1, completionTokens: 1, costUsd: 0.5, latencyMs: 1, schemaValid: false });
    expect(ledger.llmCostToday()).toBeCloseTo(0.75);
    ledger.insertPayment({ direction: "out", counterparty: "seller", amount: 0.05, asset: "USDC", network: "eip155:84532", tx: "0x1" });
    ledger.insertPayment({ direction: "in", counterparty: "buyer", amount: 9, asset: "USDC", network: "eip155:84532", tx: "0x2" });
    expect(ledger.dataSpendToday()).toBeCloseTo(0.05);
    for (let i = 1; i <= 3; i++) ledger.insertVeto({ intentId: `i${i}`, engine: "liqfade", rule: i, detail: `d${i}`, tsNs: i });
    expect(ledger.recentVetoes(2).map((v) => v.rule)).toEqual([3, 2]);
    ledger.upsertPnlDaily({ engine: "liqfade", date: "2026-09-06", realized: 1, fees: 0, trades: 1, wins: 1, maxDdBps: 0 });
    ledger.upsertPnlDaily({ engine: "liqfade", date: "2026-09-06", realized: 3, fees: 0.1, trades: 2, wins: 1, maxDdBps: 4 });
    const pnl = ledger.db.query<{ realized: number; trades: number; n: number }, []>("SELECT realized, trades, (SELECT COUNT(*) FROM pnl_daily) AS n FROM pnl_daily").get();
    expect(pnl).toEqual({ realized: 3, trades: 2, n: 1 });
  });
});
