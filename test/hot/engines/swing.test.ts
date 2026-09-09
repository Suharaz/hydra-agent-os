import { describe, expect, test } from "bun:test";
import { Bus } from "../../../src/core/bus.ts";
import { loadConfig } from "../../../src/core/config.ts";
import { openLedger } from "../../../src/core/ledger.ts";
import type { Intent, MarkEvent } from "../../../src/core/types.ts";
import { AuditCache } from "../../../src/hot/audit-cache.ts";
import { SwingEngine } from "../../../src/hot/engines/swing.ts";
import type { EngineCtx, EngineFeed } from "../../../src/hot/engines/engine.ts";
import { EngineRegistry } from "../../../src/hot/engines/registry.ts";
import type { SubmitResult } from "../../../src/hot/executor.ts";
import { FeedHub } from "../../../src/hot/feed-hub.ts";
import type { KlineCandle } from "../../../src/venues/binance/rest-futures.ts";
import { REPO_CONFIG } from "../../core/helpers.ts";

const CONFIG = loadConfig(REPO_CONFIG);

describe("swing engine", () => {
  test("mode 0 (breakout): emits BUY intent when price breaks above highest high with fastEma > slowEma", async () => {
    const bus = new Bus();
    const now = { ns: 1_000_000_000 };
    const hub = new FeedHub({
      futuresRest: null,
      spotRest: null,
      wsFactory: null,
      onchain: null,
      skills: null,
      urls: null,
      mode: "demo",
      risk: CONFIG.risk,
      bus,
      nowNs: () => now.ns,
    });

    // Generate 30 uptrending candles
    const klines: KlineCandle[] = Array.from({ length: 30 }, (_, i) => {
      const base = 50_000 + i * 100;
      return {
        openTime: i * 900_000,
        open: base,
        high: base + 50,
        low: base - 50,
        close: base + 20,
        volume: 100,
        closeTime: (i + 1) * 900_000 - 1,
      };
    });
    hub.overrideKlines("BTCUSDT", klines);

    const feed: EngineFeed = {
      book: (s) => hub.book(s),
      mark: (s) => hub.mark(s),
      burst: (s) => hub.burst(s),
      gapBps: (s) => hub.gapBps(s),
      vwap1m: (s) => hub.vwap1m(s),
      adv: (s) => hub.adv(s),
      spotTopOfBook: () => null,
      referenceMid: () => null,
      klines: (s) => hub.klines(s),
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

    const registry = new EngineRegistry(ctx, { swing: (c) => new SwingEngine(c) });
    const res = registry.apply({
      engines: {
        ...CONFIG.engines.engines,
        swing: {
          enabled: true,
          paper: false,
          symbols: ["BTCUSDT"],
          sizeUsd: 50,
          params: {
            mode: 0,
            timeframeSec: 900,
            lookbackCandles: 8,
            fastEma: 10,
            slowEma: 25,
            rsiThreshold: 30,
            slAtr: 1.5,
            tpAtr: 3.0,
            maxHoldMs: 3600_000,
          },
        },
      },
    });

    expect(res.applied).toContain("swing");
    registry.start();

    // Emit a mark price that breaks out above all prior candle highs
    const markEv: MarkEvent = {
      symbol: "BTCUSDT",
      mark: 55_000, // breaks out above 53,000
      index: 55_000,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 3600_000,
      tsNs: now.ns,
    };
    bus.emit("feed.mark", markEv);

    expect(intents.length).toBe(1);
    const intent = intents[0]!;
    expect(intent.engine).toBe("swing");
    expect(intent.venue).toBe("futures");
    expect(intent.symbol).toBe("BTCUSDT");
    expect(intent.side).toBe("BUY");
    expect(intent.sl).toBeDefined();
    expect(intent.tp).toBeDefined();
    expect(intent.tp!).toBeGreaterThan(intent.sl!);
  });

  test("mode 2 (reversal): emits BUY intent when RSI is oversold", async () => {
    const bus = new Bus();
    const now = { ns: 1_000_000_000 };
    const hub = new FeedHub({
      futuresRest: null,
      spotRest: null,
      wsFactory: null,
      onchain: null,
      skills: null,
      urls: null,
      mode: "demo",
      risk: CONFIG.risk,
      bus,
      nowNs: () => now.ns,
    });

    // Generate 30 declining candles to force oversold RSI
    const klines: KlineCandle[] = Array.from({ length: 30 }, (_, i) => {
      const base = 60_000 - i * 200;
      return {
        openTime: i * 900_000,
        open: base,
        high: base + 20,
        low: base - 250,
        close: base - 180,
        volume: 100,
        closeTime: (i + 1) * 900_000 - 1,
      };
    });
    hub.overrideKlines("BTCUSDT", klines);

    const feed: EngineFeed = {
      book: (s) => hub.book(s),
      mark: (s) => hub.mark(s),
      burst: (s) => hub.burst(s),
      gapBps: (s) => hub.gapBps(s),
      vwap1m: (s) => hub.vwap1m(s),
      adv: (s) => hub.adv(s),
      spotTopOfBook: () => null,
      referenceMid: () => null,
      klines: (s) => hub.klines(s),
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

    const registry = new EngineRegistry(ctx, { swing: (c) => new SwingEngine(c) });
    registry.apply({
      engines: {
        ...CONFIG.engines.engines,
        swing: {
          enabled: true,
          paper: false,
          symbols: ["BTCUSDT"],
          sizeUsd: 50,
          params: {
            mode: 2, // Reversal
            timeframeSec: 900,
            lookbackCandles: 8,
            fastEma: 10,
            slowEma: 25,
            rsiThreshold: 30,
            slAtr: 1.5,
            tpAtr: 3.0,
            maxHoldMs: 3600_000,
          },
        },
      },
    });
    registry.start();

    const markEv: MarkEvent = {
      symbol: "BTCUSDT",
      mark: 54_000,
      index: 54_000,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 3600_000,
      tsNs: now.ns,
    };
    bus.emit("feed.mark", markEv);

    expect(intents.length).toBe(1);
    const intent = intents[0]!;
    expect(intent.side).toBe("BUY");
  });
});
