import { describe, expect, test } from "bun:test";
import { Bus } from "../../../src/core/bus.ts";
import { loadConfig } from "../../../src/core/config.ts";
import { openLedger } from "../../../src/core/ledger.ts";
import type { Intent } from "../../../src/core/types.ts";
import { AuditCache } from "../../../src/hot/audit-cache.ts";
import { BasisEngine } from "../../../src/hot/engines/basis.ts";
import type { EngineCtx, EngineFeed } from "../../../src/hot/engines/engine.ts";
import { EngineRegistry } from "../../../src/hot/engines/registry.ts";
import type { SubmitResult } from "../../../src/hot/executor.ts";
import { FeedHub } from "../../../src/hot/feed-hub.ts";
import { REPO_CONFIG } from "../../core/helpers.ts";

const CONFIG = loadConfig(REPO_CONFIG);
const SPOT = 100_000;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("basis", () => {
  test("enters short perp + paper long spot at z >= 2 and closes both legs once z < 0.5", async () => {
    const bus = new Bus();
    const now = { ns: 0 };
    const hub = new FeedHub({ futuresRest: null, spotRest: null, wsFactory: null, onchain: null, skills: null, urls: null, mode: "demo", risk: CONFIG.risk, bus, nowNs: () => now.ns });
    // Demo spotMid comes from the mainnet reference book; stub it flat so the basis is the mark alone.
    const feed: EngineFeed = {
      book: (s) => hub.book(s),
      mark: (s) => hub.mark(s),
      burst: (s) => hub.burst(s),
      gapBps: (s) => hub.gapBps(s),
      vwap1m: (s) => hub.vwap1m(s),
      adv: (s) => hub.adv(s),
      spotTopOfBook: () => null,
      referenceMid: (base, quote) => (base === "BTC" && quote === "USDT" ? SPOT : null),
    };
    const intents: Intent[] = [];
    const ledger = openLedger(":memory:");
    const ctx: EngineCtx = {
      feed,
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
    const registry = new EngineRegistry(ctx, { basis: (c) => new BasisEngine(c) });
    const res = registry.apply({ engines: { ...CONFIG.engines.engines, basis: { enabled: true, paper: false, symbols: ["BTCUSDT"], sizeUsd: 200, params: { lookbackSec: 60, zEntry: 2, zExit: 0.5, maxHoldMs: 60_000 } } } });
    expect(res.applied).toEqual(["basis"]);
    registry.start();
    const engine = registry.engines().get("basis") as BasisEngine;

    let sec = 0;
    const mark = (basisBps: number) => {
      now.ns = ++sec * 1e9;
      const p = (SPOT * (1 + basisBps / 10_000)).toFixed(2);
      hub.applyFrame({ stream: "btcusdt@markPrice@1s", e: "markPriceUpdate", data: { e: "markPriceUpdate", s: "BTCUSDT", p, i: p, r: "0", T: 0 } });
    };
    try {
      // 60 s of +-1 bps noise: mean ~0, std ~1 bp.
      for (let i = 0; i < 60; i++) mark(i % 2 === 0 ? 1 : -1);
      expect(intents.length).toBe(0);
      expect(Math.abs(engine.zscore("BTCUSDT"))).toBeLessThan(1.5);

      mark(5); // rich basis: z ~ 4
      await settle();
      expect(engine.zscore("BTCUSDT")).toBeGreaterThanOrEqual(2);
      expect(intents.length).toBe(1);
      const entry = intents[0] as Intent;
      expect(entry).toMatchObject({ engine: "basis", venue: "futures", symbol: "BTCUSDT", side: "SELL", paper: false });
      expect(entry.legs?.length).toBe(2);
      const [perp, spot] = entry.legs as [Intent, Intent];
      expect(perp).toMatchObject({ venue: "futures", symbol: "BTCUSDT", side: "SELL", paper: false, type: "MARKET" });
      expect(spot).toMatchObject({ venue: "spot", symbol: "BTCUSDT", side: "BUY", paper: true, type: "MARKET" }); // demo: spot leg paper
      expect(perp.qty * SPOT * (1 + 5 / 10_000)).toBeCloseTo(200, 6);
      expect(spot.qty * SPOT).toBeCloseTo(200, 6); // equal notional
      expect(perp.id).not.toBe(spot.id);

      mark(6); // still rich: no second entry while one is open
      await settle();
      expect(intents.length).toBe(1);

      mark(0); // back to the mean: |z| < zExit -> close
      await settle();
      expect(engine.zscore("BTCUSDT")).toBeLessThan(0.5);
      expect(intents.length).toBe(2);
      const exit = intents[1] as Intent;
      expect(exit.id).toBe(`${entry.id}-x`);
      expect(exit.legs?.map((l) => [l.venue, l.side, l.paper])).toEqual([
        ["futures", "BUY", false],
        ["spot", "SELL", true],
      ]);
      expect(registry.stats().basis).toMatchObject({ intents: 1, exits: 1, open: 0, entries: 1 });
    } finally {
      registry.stop();
      ledger.close();
    }
  });
});
