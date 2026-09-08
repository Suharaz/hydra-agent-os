import { expect, test } from "bun:test";
import { Bus } from "../../src/core/bus.ts";
import { type EnginesConfig, loadConfig } from "../../src/core/config.ts";
import { openLedger } from "../../src/core/ledger.ts";
import { effective } from "../../src/core/limits.ts";
import { ENGINE_IDS, type EngineConfig, type EngineId, type Intent, type Venue } from "../../src/core/types.ts";
import { AuditCache } from "../../src/hot/audit-cache.ts";
import { type FeedView, Kernel, type KernelPositions } from "../../src/hot/kernel.ts";
import { REPO_CONFIG, cleanup, tempDir } from "../core/helpers.ts";

const ITER = 100_000;
const WARMUP = 10_000;
const P99_LIMIT_US = 50;

const positions: KernelPositions = {
  nav: () => 5000,
  netDeltaUsd: () => 100,
  grossNotionalUsd: (v: Venue) => (v === "futures" ? 1000 : 0),
  openNotional: (_e: EngineId) => 300,
  qty: () => 0.004,
  symbolQty: () => 0.004,
  liqPrice: () => 40_000,
  mark: () => 50_000,
  drawdownPct: () => 0.5,
};
const book = { synced: true, ageMs: 50, bestBid: 49_999, bestAsk: 50_001, mid: 50_000 };
const markEv = { mark: 50_000, index: 50_000 };
const feed: FeedView = { book: () => book, mark: () => markEv };

test(`evaluate p99 < ${P99_LIMIT_US} us over ${ITER} iterations`, () => {
  const dir = tempDir();
  const ledger = openLedger(":memory:");
  const risk = { ...loadConfig(REPO_CONFIG).risk, max_orders_per_sec: 1_000_000_000 };
  const engines = {} as Record<EngineId, EngineConfig>;
  for (const e of ENGINE_IDS) engines[e] = { enabled: true, paper: true, symbols: [], sizeUsd: 100, params: {} };
  const enginesCfg: EnginesConfig = { engines };
  const limits = effective(risk, null, Date.now(), false);
  const kernel = new Kernel({
    stateDir: dir,
    risk,
    engines: () => enginesCfg,
    limits: () => limits,
    budgets: () => ({}),
    positions,
    feed,
    audit: new AuditCache(),
    ledger,
    bus: new Bus(),
  });
  const market: Intent = { id: "b", engine: "liqfade", venue: "futures", symbol: "BTCUSDT", side: "BUY", qty: 0.001, type: "MARKET", ttlMs: 1000, paper: true, tSignalNs: 0 };
  const limit: Intent = { ...market, id: "l", type: "LIMIT", price: 49_990 };
  try {
    for (let n = 0; n < WARMUP; n++) if (kernel.evaluate(n & 1 ? market : limit) !== null) throw new Error("warmup vetoed");
    const samples = new Float64Array(ITER);
    for (let n = 0; n < ITER; n++) {
      const i = n & 1 ? market : limit;
      const t0 = Bun.nanoseconds();
      const v = kernel.evaluate(i);
      samples[n] = Bun.nanoseconds() - t0;
      if (v !== null) throw new Error(`vetoed: ${v.detail}`);
    }
    samples.sort();
    const p50 = (samples[Math.floor(ITER * 0.5)] as number) / 1000;
    const p99 = (samples[Math.floor(ITER * 0.99)] as number) / 1000;
    console.log(`kernel.evaluate p50 ${p50.toFixed(2)} us, p99 ${p99.toFixed(2)} us`);
    expect(p99).toBeLessThan(P99_LIMIT_US);
  } finally {
    ledger.close();
    cleanup(dir);
  }
});
