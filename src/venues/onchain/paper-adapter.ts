// Demo on-chain adapter: no wallet, no network. Smart-money events replay from an NDJSON fixture
// at REPLAY_SPEED; quotes are the reference mid (mainnet spot bookTicker when the FeedHub has
// one, else the last quote) plus a seeded random walk of 0-40 bps; swaps fill at the last quote
// with a fixed slippage. The same quote path feeds both the signal and the fill simulation.

import { readFileSync } from "node:fs";
import { nowNs } from "../../core/clock.ts";
import { logger } from "../../core/log.ts";
import type { DexQuote, Intent, SmartMoneyEvent } from "../../core/types.ts";
import { realClock, type Clock } from "../binance/ws.ts";
import { mapTrackerPush, parsePair, type OnchainAdapter, type SwapResult, type WalletStatus } from "./adapter.ts";

const log = logger("onchain.paper");

export interface PaperAdapterOptions {
  fixturePath: string;
  replaySpeed?: number;
  clock?: Clock;
  /** Reference mid for `BASE/QUOTE`; null when unknown. Wired to FeedHub's mainnet bookTicker. */
  referenceMid?: (base: string, quote: string) => number | null;
  seed?: number;
  /** Fill slippage applied against the taker, in bps (default 15, capped at 20). */
  slippageBps?: number;
  /** Fallback price per base asset when no reference is available yet. */
  fallbackPrices?: Record<string, number>;
  gasUsd?: number;
  /** Loop the fixture when it ends (default true). */
  loop?: boolean;
}

/** mulberry32: small deterministic PRNG. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FixtureLine {
  t_ms: number;
  data: unknown;
}

const DEFAULT_PRICES: Record<string, number> = { BNB: 600, ETH: 3000, BTC: 60000, SOL: 150, WBNB: 600, WETH: 3000 };

export class PaperAdapter implements OnchainAdapter {
  readonly kind = "paper" as const;
  private readonly fixturePath: string;
  private readonly speed: number;
  private readonly clock: Clock;
  private readonly referenceMid: (base: string, quote: string) => number | null;
  private readonly rand: () => number;
  private readonly slippageBps: number;
  private readonly fallbackPrices: Record<string, number>;
  private readonly gasUsd: number;
  private readonly loop: boolean;
  /** Last walk offset (bps) and last quote per pair. */
  private readonly walk = new Map<string, number>();
  private readonly last = new Map<string, DexQuote>();
  private lines: FixtureLine[] | null = null;
  private swapSeq = 0;

  constructor(opts: PaperAdapterOptions) {
    this.fixturePath = opts.fixturePath;
    this.speed = opts.replaySpeed ?? 1;
    this.clock = opts.clock ?? realClock;
    this.referenceMid = opts.referenceMid ?? (() => null);
    this.rand = seededRandom(opts.seed ?? 42);
    this.slippageBps = Math.min(20, opts.slippageBps ?? 15);
    this.fallbackPrices = opts.fallbackPrices ?? DEFAULT_PRICES;
    this.gasUsd = opts.gasUsd ?? 0.05;
    this.loop = opts.loop ?? true;
  }

  lastQuote(pair: string): DexQuote | null {
    return this.last.get(pair) ?? null;
  }

  quote(pair: string): Promise<DexQuote> {
    const { base, quote, chain } = parsePair(pair);
    const ref = this.referenceMid(base, quote);
    const prev = this.last.get(pair);
    const anchor = ref !== null && ref > 0 ? ref : prev !== undefined ? (prev.bid + prev.ask) / 2 : (this.fallbackPrices[base] ?? 1);
    // Random walk on the offset from the anchor: step in [-10, +10] bps, clamped to [-40, +40].
    const step = (this.rand() - 0.5) * 20;
    const offset = Math.max(-40, Math.min(40, (this.walk.get(pair) ?? 0) + step));
    this.walk.set(pair, offset);
    const mid = anchor * (1 + offset / 10_000);
    const half = mid * 0.0005; // 5 bps half-spread
    const q: DexQuote = { pair, chain, bid: mid - half, ask: mid + half, gasUsd: this.gasUsd, tsNs: nowNs() };
    this.last.set(pair, q);
    return Promise.resolve(q);
  }

  /** Fills at the last quote's touch, moved `slippageBps` against the taker. */
  async swap(intent: Intent): Promise<SwapResult> {
    const q = this.last.get(intent.symbol) ?? (await this.quote(intent.symbol));
    const touch = intent.side === "BUY" ? q.ask : q.bid;
    const slip = 1 + (intent.side === "BUY" ? 1 : -1) * (this.slippageBps / 10_000);
    const price = touch * slip;
    this.swapSeq++;
    return { txOrRef: `paper-${intent.id}-${this.swapSeq}`, price, qty: intent.qty, fee: q.gasUsd };
  }

  walletStatus(): Promise<WalletStatus> {
    return Promise.resolve({ connected: true, address: "0xPAPER000000000000000000000000000000000000" });
  }

  /** Replays `{t_ms, data}` lines with relative timing / REPLAY_SPEED; loops by default. */
  trackerStream(onEvent: (e: SmartMoneyEvent) => void): () => void {
    const lines = this.load();
    if (lines.length === 0) {
      log.warn("smart-money fixture empty", { path: this.fixturePath });
      return () => undefined;
    }
    let stopped = false;
    let handle: unknown = null;
    let idx = 0;
    let baseT = lines[0]?.t_ms ?? 0;
    const schedule = () => {
      if (stopped) return;
      if (idx >= lines.length) {
        if (!this.loop) return;
        idx = 0;
        baseT = (lines[0]?.t_ms ?? 0) - 1000; // 1 s gap before the loop restarts
      }
      const line = lines[idx] as FixtureLine;
      const delay = Math.max(0, (line.t_ms - baseT) / this.speed);
      handle = this.clock.setTimeout(() => {
        handle = null;
        if (stopped) return;
        const ev = mapTrackerPush(line.data, nowNs());
        if (ev !== null) onEvent(ev);
        baseT = line.t_ms;
        idx++;
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      stopped = true;
      if (handle !== null) this.clock.clearTimeout(handle);
    };
  }

  private load(): FixtureLine[] {
    if (this.lines !== null) return this.lines;
    const out: FixtureLine[] = [];
    let text: string;
    try {
      text = readFileSync(this.fixturePath, "utf8");
    } catch (err) {
      log.warn("cannot read smart-money fixture", { path: this.fixturePath, error: err instanceof Error ? err.message : String(err) });
      this.lines = out;
      return out;
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) continue;
        const t = "t_ms" in parsed && typeof parsed.t_ms === "number" ? parsed.t_ms : out.length * 1000;
        const data = "data" in parsed ? parsed.data : parsed;
        out.push({ t_ms: t, data });
      } catch {
        // skip malformed line
      }
    }
    this.lines = out;
    return out;
  }
}
