import { afterEach, describe, expect, test } from "bun:test";
import { Bus } from "../../src/core/bus.ts";
import { type EnginesConfig, type RiskConfig, loadConfig } from "../../src/core/config.ts";
import { type Ledger, openLedger } from "../../src/core/ledger.ts";
import { type EffectiveLimits, effective } from "../../src/core/limits.ts";
import { writeKillLock } from "../../src/core/state.ts";
import { type Budgets, ENGINE_IDS, type EngineConfig, type EngineId, type Intent, type Venue, type Veto } from "../../src/core/types.ts";
import { AuditCache } from "../../src/hot/audit-cache.ts";
import { type FeedView, KILL_LOCK_TTL_MS, Kernel, type KernelPositions } from "../../src/hot/kernel.ts";
import { REPO_CONFIG, cleanup, tempDir } from "../core/helpers.ts";

const BASE_RISK = loadConfig(REPO_CONFIG).risk;

class FakePositions implements KernelPositions {
  navUsd = 10_000;
  netDelta = 0;
  gross: Record<Venue, number> = { futures: 0, spot: 0, dex: 0 };
  open: Partial<Record<EngineId, number>> = {};
  qtys: Record<string, number> = {};
  liq: Record<string, number> = {};
  marks: Record<string, number> = { "spot:BTCUSDT": 50_000 };
  dd = 0;

  nav(): number {
    return this.navUsd;
  }
  netDeltaUsd(): number {
    return this.netDelta;
  }
  grossNotionalUsd(venue: Venue): number {
    return this.gross[venue];
  }
  openNotional(engine: EngineId): number {
    return this.open[engine] ?? 0;
  }
  qty(venue: Venue, engine: EngineId, symbol: string): number {
    return this.qtys[`${venue}:${engine}:${symbol}`] ?? 0;
  }
  symbolQty(venue: Venue, symbol: string): number {
    let q = 0;
    for (const [k, v] of Object.entries(this.qtys)) if (k.startsWith(`${venue}:`) && k.endsWith(`:${symbol}`)) q += v;
    return q;
  }
  liqPrice(symbol: string): number {
    return this.liq[symbol] ?? 0;
  }
  mark(venue: Venue, symbol: string): number {
    return this.marks[`${venue}:${symbol}`] ?? 0;
  }
  drawdownPct(): number {
    return this.dd;
  }
}

class FakeFeed implements FeedView {
  books: Record<string, { synced: boolean; ageMs: number; bestBid: number; bestAsk: number; mid: number }> = {};
  marks: Record<string, number> = { BTCUSDT: 50_000, ETHUSDT: 2_000 };
  book(symbol: string) {
    return this.books[symbol] ?? null;
  }
  mark(symbol: string) {
    const m = this.marks[symbol];
    return m === undefined ? null : { mark: m, index: m };
  }
}

function enginesConfig(patch: Partial<Record<EngineId, Partial<EngineConfig>>> = {}): EnginesConfig {
  const engines = {} as Record<EngineId, EngineConfig>;
  for (const e of ENGINE_IDS) engines[e] = { enabled: true, paper: true, symbols: [], sizeUsd: 100, params: {}, ...patch[e] };
  return { engines };
}

interface Rig {
  kernel: Kernel;
  positions: FakePositions;
  feed: FeedView & { books: FakeFeed["books"]; marks: FakeFeed["marks"] };
  audit: AuditCache;
  bus: Bus;
  vetoes: Veto[];
  dir: string;
  now: { ms: number };
  limits: EffectiveLimits;
  budgets: Budgets;
  engines: EnginesConfig;
  ledger: Ledger;
}

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.ledger.close();
    cleanup(r.dir);
  }
});

function rig(riskPatch: Partial<RiskConfig> = {}, opts: { minNotional?: (v: Venue, s: string) => number; weightNearLimit?: (v: Venue) => boolean } = {}): Rig {
  const risk: RiskConfig = { ...BASE_RISK, ...riskPatch, allowed_symbols: { ...BASE_RISK.allowed_symbols, dex: ["PEPE"], ...riskPatch.allowed_symbols } };
  const dir = tempDir();
  const now = { ms: 1_700_000_000_000 };
  const positions = new FakePositions();
  const feed = new FakeFeed();
  const audit = new AuditCache(() => now.ms);
  const bus = new Bus();
  const ledger = openLedger(":memory:");
  const vetoes: Veto[] = [];
  bus.on("kernel.veto", (v) => vetoes.push(v));
  const r: Rig = {
    positions,
    feed,
    audit,
    bus,
    vetoes,
    dir,
    now,
    ledger,
    limits: effective(risk, null, now.ms, false),
    budgets: {},
    engines: enginesConfig(),
    kernel: undefined as unknown as Kernel,
  };
  r.kernel = new Kernel({
    stateDir: dir,
    risk,
    engines: () => r.engines,
    limits: () => r.limits,
    budgets: () => r.budgets,
    positions,
    feed,
    audit,
    ledger,
    clock: () => now.ms,
    bus,
    minNotional: opts.minNotional,
    weightNearLimit: opts.weightNearLimit,
  });
  rigs.push(r);
  return r;
}

let seq = 0;
function intent(patch: Partial<Intent> = {}): Intent {
  seq += 1;
  return { id: `i${seq}`, engine: "liqfade", venue: "futures", symbol: "BTCUSDT", side: "BUY", qty: 0.01, type: "MARKET", ttlMs: 1000, paper: true, tSignalNs: 0, ...patch };
}

describe("kernel", () => {
  test("valid futures MARKET intent passes every rule", () => {
    const r = rig();
    expect(r.kernel.evaluate(intent())).toBeNull();
    expect(r.vetoes).toHaveLength(0);
    expect(r.ledger.recentVetoes(1)).toHaveLength(0);
  });

  test("rule 0: kill.lock vetoes, cached for 250 ms", () => {
    const r = rig();
    expect(r.kernel.evaluate(intent())).toBeNull();
    writeKillLock(r.dir, { reason: "test", at: r.now.ms, residue: { futures: [], spot: [], dex: [] } }, "kill");
    expect(r.kernel.evaluate(intent())).toBeNull();
    r.now.ms += KILL_LOCK_TTL_MS;
    const v = r.kernel.evaluate(intent());
    expect(v?.rule).toBe(0);
    expect(r.vetoes[0]).toEqual(v as Veto);
    expect(r.ledger.recentVetoes(1)[0]?.rule).toBe(0);
  });

  test("rule 1: disabled, paused, or zero-cap engine", () => {
    const r = rig();
    r.engines = enginesConfig({ liqfade: { enabled: false } });
    expect(r.kernel.evaluate(intent())?.rule).toBe(1);
    r.engines = enginesConfig();
    r.limits = { ...r.limits, engines_paused: ["liqfade"] };
    expect(r.kernel.evaluate(intent())?.rule).toBe(1);
    r.limits = { ...r.limits, engines_paused: [], per_engine_max_notional_usd: { ...r.limits.per_engine_max_notional_usd, liqfade: 0 } };
    expect(r.kernel.evaluate(intent())?.rule).toBe(1);
    expect(r.kernel.evaluate(intent({ engine: "basis" }))).toBeNull();
  });

  test("rule 2: symbol whitelist is per venue", () => {
    const r = rig();
    expect(r.kernel.evaluate(intent({ symbol: "DOGEUSDT" }))?.rule).toBe(2);
    expect(r.kernel.evaluate(intent({ venue: "spot", symbol: "PEPE" }))?.rule).toBe(2);
    expect(r.kernel.evaluate(intent({ venue: "spot" }))).toBeNull();
  });

  test("rule 3: orders/sec bucket refills with the clock and is refunded on veto", () => {
    const r = rig({ max_orders_per_sec: 3 });
    for (let n = 0; n < 3; n++) expect(r.kernel.evaluate(intent())).toBeNull();
    expect(r.kernel.evaluate(intent())?.rule).toBe(3);
    r.now.ms += 1000;
    expect(r.kernel.evaluate(intent())).toBeNull();
    // A later-rule veto hands the token back.
    r.positions.dd = 99;
    expect(r.kernel.evaluate(intent())?.rule).toBe(8);
    r.positions.dd = 0;
    expect(r.kernel.evaluate(intent())).toBeNull();
    expect(r.kernel.evaluate(intent())).toBeNull();
    expect(r.kernel.evaluate(intent())?.rule).toBe(3);
  });

  test("rule 11: order notional must clear the venue minNotional", () => {
    const r = rig({}, { minNotional: (v) => (v === "futures" ? 50 : 5) });
    expect(r.kernel.evaluate(intent({ qty: 0.0008 }))?.rule).toBe(11); // $40 < $50 futures min
    expect(r.kernel.evaluate(intent({ qty: 0.002 }))).toBeNull(); // $100 clears it
  });

  test("rule 12: near-ceiling request-weight vetoes non-paper orders; paper is unaffected", () => {
    let near = true;
    const r = rig({}, { weightNearLimit: () => near });
    expect(r.kernel.evaluate(intent({ paper: false }))?.rule).toBe(12);
    expect(r.kernel.evaluate(intent({ paper: true }))).toBeNull();
    near = false;
    expect(r.kernel.evaluate(intent({ paper: false }))).toBeNull();
  });

  test("rule 3: real-order buckets are per-venue and capped by the Binance venue ceiling", () => {
    const r = rig({ max_orders_per_sec: 1000 }); // config high; spot ceiling (5/s) still binds real orders
    for (let n = 0; n < 5; n++) expect(r.kernel.evaluate(intent({ venue: "spot", paper: false }))).toBeNull();
    expect(r.kernel.evaluate(intent({ venue: "spot", paper: false }))?.rule).toBe(3);
    expect(r.kernel.evaluate(intent({ venue: "futures", paper: false }))).toBeNull(); // separate bucket, higher ceiling
  });

  test("rule 4: notional within engine cap and budget minus open notional; reducing legs exempt", () => {
    const r = rig();
    r.positions.open.liqfade = 1500; // cap 2000 -> room 500
    expect(r.kernel.evaluate(intent({ qty: 0.012 }))?.rule).toBe(4); // 600
    expect(r.kernel.evaluate(intent({ qty: 0.008 }))).toBeNull(); // 400
    r.budgets = { liqfade: 1600 }; // room 100
    expect(r.kernel.evaluate(intent({ qty: 0.008 }))?.rule).toBe(4);
    r.positions.qtys["futures:liqfade:BTCUSDT"] = 0.03;
    r.positions.netDelta = 1500;
    expect(r.kernel.evaluate(intent({ side: "SELL", qty: 0.03 }))).toBeNull();
    r.feed.marks = {};
    expect(r.kernel.evaluate(intent({ symbol: "ETHUSDT" }))?.rule).toBe(4);
  });

  test("rule 5: post-trade net delta vs NAV cap, unless the leg shrinks it", () => {
    const r = rig();
    r.positions.navUsd = 1000; // 25% -> 250
    r.positions.netDelta = 200;
    expect(r.kernel.evaluate(intent({ qty: 0.002 }))?.rule).toBe(5); // +100 -> 300
    expect(r.kernel.evaluate(intent({ qty: 0.0008 }))).toBeNull(); // +40 -> 240
    r.positions.netDelta = 300;
    expect(r.kernel.evaluate(intent({ side: "SELL", qty: 0.002 }))).toBeNull(); // -100 -> 200
  });

  test("rule 6: post-trade futures leverage", () => {
    const r = rig({ max_net_delta_pct: 100, min_liq_distance_pct: 0 });
    r.positions.navUsd = 1000;
    r.positions.gross.futures = 2500;
    expect(r.kernel.evaluate(intent({ qty: 0.012 }))?.rule).toBe(6); // 3.1x
    expect(r.kernel.evaluate(intent({ qty: 0.008 }))).toBeNull(); // 2.9x
    expect(r.kernel.evaluate(intent({ venue: "spot", qty: 0.012 }))).toBeNull();
  });

  test("rule 7: liquidation distance from estimate or venue liq price", () => {
    const r = rig({ max_net_delta_pct: 1000, max_leverage: 100, per_engine_max_notional_usd: { ...BASE_RISK.per_engine_max_notional_usd, liqfade: 100_000 } });
    r.positions.navUsd = 1000;
    expect(r.kernel.evaluate(intent({ qty: 0.1 }))).toBeNull(); // 5000 -> 19.5%
    expect(r.kernel.evaluate(intent({ qty: 0.13 }))?.rule).toBe(7); // 6500 -> 14.9%
    r.positions.qtys["futures:liqfade:BTCUSDT"] = 0.01;
    r.positions.gross.futures = 500;
    r.positions.liq.BTCUSDT = 45_500; // 9% away
    expect(r.kernel.evaluate(intent({ qty: 0.001 }))?.rule).toBe(7);
    expect(r.kernel.evaluate(intent({ side: "SELL", qty: 0.005 }))).toBeNull();
  });

  test("rule 8: daily drawdown at or over the kill threshold", () => {
    const r = rig();
    r.positions.dd = 4.2;
    expect(r.kernel.evaluate(intent())?.rule).toBe(8);
    r.positions.dd = 3.9;
    expect(r.kernel.evaluate(intent())).toBeNull();
  });

  test("rule 9: DEX legs need a fresh PASS audit and the on-chain cap", () => {
    const r = rig();
    r.feed.books.PEPE = { synced: true, ageMs: 10, bestBid: 0.99, bestAsk: 1.01, mid: 1 };
    const dex = (qty: number) => intent({ engine: "cexdex", venue: "dex", symbol: "PEPE", qty });
    expect(r.kernel.evaluate(dex(100))?.rule).toBe(9);
    r.audit.set("PEPE", { pass: false, risk: "honeypot", tsMs: r.now.ms });
    expect(r.kernel.evaluate(dex(100))?.rule).toBe(9);
    r.audit.set("PEPE", { pass: true, risk: "low", tsMs: r.now.ms - BASE_RISK.audit_ttl_sec * 1000 });
    expect(r.kernel.evaluate(dex(100))?.rule).toBe(9);
    r.audit.set("PEPE", { pass: true, risk: "low", tsMs: r.now.ms });
    expect(r.kernel.evaluate(dex(100))).toBeNull();
    r.positions.gross.dex = 150;
    expect(r.kernel.evaluate(dex(100))?.rule).toBe(9); // 250 > 200
  });

  test("rule 10: LIMIT legs need a synced book younger than 2 s", () => {
    const r = rig();
    const limit = intent({ type: "LIMIT", price: 50_000 });
    expect(r.kernel.evaluate(limit)?.rule).toBe(10);
    r.feed.books.BTCUSDT = { synced: false, ageMs: 10, bestBid: 1, bestAsk: 1, mid: 50_000 };
    expect(r.kernel.evaluate(limit)?.rule).toBe(10);
    r.feed.books.BTCUSDT = { synced: true, ageMs: 2000, bestBid: 1, bestAsk: 1, mid: 50_000 };
    expect(r.kernel.evaluate(limit)?.rule).toBe(10);
    r.feed.books.BTCUSDT = { synced: true, ageMs: 100, bestBid: 1, bestAsk: 1, mid: 50_000 };
    expect(r.kernel.evaluate(limit)).toBeNull();
  });

  test("multi-leg: any failing leg vetoes the whole intent under the root id", () => {
    const r = rig();
    const root = intent({ engine: "basis", legs: [intent({ engine: "basis" }), intent({ engine: "basis", venue: "spot", symbol: "DOGEUSDT" })] });
    const v = r.kernel.evaluate(root);
    expect(v?.rule).toBe(2);
    expect(v?.intentId).toBe(root.id);
    expect(v?.detail).toStartWith("leg 1 spot:DOGEUSDT");
    const ok = intent({ engine: "basis", legs: [intent({ engine: "basis" }), intent({ engine: "basis", venue: "spot", side: "SELL" })] });
    expect(r.kernel.evaluate(ok)).toBeNull();
  });

  test("S03: whole-intent projection and unresolved admissions share engine room", () => {
    const r = rig();
    r.limits.per_engine_max_notional_usd.liqfade = 100;
    const leg = () => intent({ qty: 0.0012, paper: false });
    expect(r.kernel.admit(intent({ legs: [leg(), leg()] }))?.rule).toBe(4);
    expect(r.kernel.admit(leg())).toBeNull();
    expect(r.kernel.admit(leg())?.rule).toBe(4);
  });

  test("S03: cancellation releases only confirmed unfilled quantity, retaining missed executions", () => {
    const r = rig();
    r.limits.per_engine_max_notional_usd.liqfade = 100;
    const i = intent({ qty: 0.0012, paper: false });
    expect(r.kernel.admit(i)).toBeNull();
    const intentId = r.ledger.insertIntent(i);
    const order = { id: 0, intentId, venue: i.venue, symbol: i.symbol, side: i.side, qty: i.qty, clientId: `hydra-${i.id}`, status: "NEW" as const, tSentNs: 1 };
    order.id = r.ledger.insertOrderPending(order);
    r.bus.emit("exec.order", order);
    r.ledger.updateOrderStatus(order.id, "CANCELED", JSON.stringify({ executedQty: 0.0006 }));
    r.bus.emit("exec.order", { ...order, status: "CANCELED" });
    // $30 filled but not yet delivered must still consume room.
    expect(r.kernel.evaluate(intent({ qty: 0.0016, paper: false }))?.rule).toBe(4);
    expect(r.kernel.evaluate(intent({ qty: 0.0014, paper: false }))).toBeNull();
    r.ledger.insertFill({ orderId: order.id, venue: i.venue, symbol: i.symbol, side: i.side, qty: 0.0006, price: 50_000, fee: 0, feeAsset: "USDT", tradeId: "partial", tsNs: 2 });
    r.positions.open.liqfade = 30;
    r.positions.qtys["futures:liqfade:BTCUSDT"] = 0.0006;
    expect(r.kernel.admit(intent({ qty: 0.0014, paper: false }))).toBeNull();
    expect(r.kernel.admit(intent({ qty: 0.0001, paper: false }))?.rule).toBe(4);
  });

  test("S03: pending orders count toward delta, leverage and liquidation distance", () => {
    const delta = rig();
    delta.positions.navUsd = 1000;
    expect(delta.kernel.admit(intent({ qty: 0.004, paper: false }))).toBeNull();
    expect(delta.kernel.evaluate(intent({ engine: "basis", qty: 0.002, paper: false }))?.rule).toBe(5);
    const lev = rig({ max_net_delta_pct: 1000, min_liq_distance_pct: 0 });
    lev.positions.navUsd = 1000;
    lev.positions.gross.futures = 2500;
    expect(lev.kernel.admit(intent({ qty: 0.008, paper: false }))).toBeNull();
    expect(lev.kernel.evaluate(intent({ engine: "basis", qty: 0.004, paper: false }))?.rule).toBe(6);
    const liq = rig({ max_net_delta_pct: 1000, max_leverage: 100, per_engine_max_notional_usd: { ...BASE_RISK.per_engine_max_notional_usd, liqfade: 100_000 } });
    liq.positions.navUsd = 1000;
    expect(liq.kernel.admit(intent({ qty: 0.1, paper: false }))).toBeNull();
    expect(liq.kernel.evaluate(intent({ qty: 0.03, paper: false }))?.rule).toBe(7);
  });

  test("S08: system.kill latches admission without waiting for the file cache", () => {
    const r = rig();
    expect(r.kernel.evaluate(intent())).toBeNull();
    r.bus.emit("system.kill", { reason: "test", actor: "kill", tsNs: 1 });
    expect(r.kernel.evaluate(intent())?.rule).toBe(0);
  });
});
