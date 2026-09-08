import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { parseFixture } from "../../../src/cli/replay.ts";
import { Bus } from "../../../src/core/bus.ts";
import { loadConfig } from "../../../src/core/config.ts";
import { openLedger } from "../../../src/core/ledger.ts";
import type { Intent, OpportunityContract } from "../../../src/core/types.ts";
import { AuditCache } from "../../../src/hot/audit-cache.ts";
import type { EngineCtx } from "../../../src/hot/engines/engine.ts";
import { LiqfadeEngine } from "../../../src/hot/engines/liqfade.ts";
import { EngineRegistry } from "../../../src/hot/engines/registry.ts";
import type { SubmitResult } from "../../../src/hot/executor.ts";
import { FeedHub } from "../../../src/hot/feed-hub.ts";
import type { Frame } from "../../../src/venues/binance/ws.ts";
import { REPO_CONFIG } from "../../core/helpers.ts";

const CONFIG = loadConfig(REPO_CONFIG);
const FIXTURE = parseFixture(readFileSync("fixtures/liq-cascade-eth.ndjson", "utf8"));
const ETH_ADV_USD = 1e10;

/**
 * The fixture starts mid-cascade, so its 60 s VWAP would be the burst itself; one pre-cascade
 * print anchors the VWAP where the tape traded before the liquidations (the displacement check
 * measures the overshoot against that).
 */
const ANCHOR: Frame = { stream: "ethusdt@aggTrade", e: "aggTrade", data: { e: "aggTrade", s: "ETHUSDT", p: "3010.00", q: "5000", T: 0, m: false } };

const noTimers = { nowMs: () => 0, setTimeout: () => ({}), clearTimeout: () => undefined, setInterval: () => ({}), clearInterval: () => undefined };

function rig() {
  const bus = new Bus();
  const now = { ns: 0 };
  const hub = new FeedHub({
    futuresRest: { depth: () => Promise.reject(new Error("no depth")), ticker24h: (symbol) => Promise.resolve({ symbol, lastPrice: "3000", volume: "0", quoteVolume: String(ETH_ADV_USD) }) },
    spotRest: null,
    wsFactory: null,
    onchain: null,
    skills: null,
    urls: null,
    mode: "demo",
    risk: CONFIG.risk,
    bus,
    nowNs: () => now.ns,
    clock: noTimers,
  });
  const intents: Intent[] = [];
  const contracts: OpportunityContract[] = [];
  bus.on("engine.contract", (c) => contracts.push(c));
  const ledger = openLedger(":memory:");
  const ctx: EngineCtx = {
    feed: hub,
    submit: (i): Promise<SubmitResult> => {
      intents.push(i);
      return Promise.resolve({ ok: true, orders: [], fills: [] });
    },
    skills: null,
    audit: new AuditCache(),
    ledger,
    bus,
    nowNs: () => now.ns,
    wallMs: () => now.ns / 1e6,
    mode: "demo",
    risk: CONFIG.risk,
  };
  const registry = new EngineRegistry(ctx, { liqfade: (c) => new LiqfadeEngine(c) });
  const res = registry.apply({ engines: { ...CONFIG.engines.engines, liqfade: { enabled: true, paper: true, symbols: ["ETHUSDT"], sizeUsd: 200, params: {} } } });
  expect(res.applied).toEqual(["liqfade"]);
  registry.start();
  hub.start();
  const play = (frames: Array<{ t_ms: number; frame: Frame }>) => {
    for (const f of frames) {
      now.ns = f.t_ms * 1e6;
      hub.applyFrame(f.frame);
    }
  };
  const stop = () => {
    registry.stop();
    hub.stop();
    ledger.close();
  };
  return { hub, registry, intents, contracts, now, play, stop };
}

/** Drains the microtask queue so the ADV poll and async emitIntent chains settle (no timers). */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("liqfade", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  test("replaying the ETH cascade yields exactly one BUY fade with TP/SL, then the contract", async () => {
    const r = rig();
    stop = r.stop;
    await settle(); // ADV lands
    expect(r.hub.adv("ETHUSDT")).toBe(ETH_ADV_USD);
    r.play([{ t_ms: 0, frame: ANCHOR }, ...FIXTURE]);
    await settle();
    expect(r.intents.length).toBe(1);
    const i = r.intents[0] as Intent;
    expect(i.engine).toBe("liqfade");
    expect(i.venue).toBe("futures");
    expect(i.symbol).toBe("ETHUSDT");
    expect(i.side).toBe("BUY");
    expect(i.type).toBe("MARKET"); // no depth in the fixture: book never synced, allowMarket
    expect(i.paper).toBe(true);
    expect(i.tSignalNs).toBe(2100 * 1e6); // third sample, first with the burst behind it
    expect(i.qty * 2995.1).toBeCloseTo(200, 3);
    expect(i.tp).toBeGreaterThan(2995.1);
    expect(i.sl).toBeLessThan(2995.1);
    expect(r.registry.stats().liqfade).toMatchObject({ intents: 1, rejected: 0, open: 1, cascades: 1 });

    r.registry.tick(r.now.ns);
    expect(r.contracts.length).toBe(1);
    const c = r.contracts[0] as OpportunityContract;
    expect(c).toMatchObject({ engine: "liqfade", symbol: "ETHUSDT", side: "BUY", venue: "futures", sizeUsd: 200 });
    expect(c.edgeBps).toBeGreaterThanOrEqual(40);
    expect(c.meta).toMatchObject({ snapshots: 3, type: "MARKET" });
    r.registry.tick(r.now.ns);
    expect(r.contracts.length).toBe(1); // unchanged contract is not republished

    // Time stop closes the position with a reduce intent.
    r.registry.tick(r.now.ns + 120_001 * 1e6);
    await settle();
    expect(r.intents.length).toBe(2);
    expect(r.intents[1]).toMatchObject({ id: `${i.id}-x`, side: "SELL", type: "MARKET", qty: i.qty });
  });

  test("the single-sample decoy tail yields nothing", async () => {
    const r = rig();
    stop = r.stop;
    await settle();
    r.play(FIXTURE.filter((f) => f.t_ms >= 13_000));
    await settle();
    expect(r.intents.length).toBe(0);
    expect(r.registry.stats().liqfade?.samples).toBe(1);
    expect(r.registry.contracts()).toEqual([]);
  });

  test("without a burst behind the samples there is no fade", async () => {
    const r = rig();
    stop = r.stop;
    await settle();
    r.play([{ t_ms: 0, frame: ANCHOR }, ...FIXTURE.filter((f) => f.frame.e !== "aggTrade" || f.t_ms === 0)]);
    await settle();
    expect(r.intents.length).toBe(0);
  });
});
