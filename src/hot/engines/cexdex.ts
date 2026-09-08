// cexdex: CEX/DEX price arbitrage. Every `feed.dexquote` for a whitelisted pair is compared with
// the spot top of book in both directions; when the gross edge survives taker fees (10 bps for
// the two legs), gas and the DEX half-spread (slippage proxy) by >= minEdgeBps, both legs go out
// as one all-or-nothing intent. The trade is flat on arrival, so nothing is tracked; the symbol
// cools down for one quote interval instead.

import type { EventName, HydraEvents } from "../../core/bus.ts";
import type { DexQuote, EngineId, OpportunityContract } from "../../core/types.ts";
import { parsePair } from "../../venues/onchain/adapter.ts";
import { leg } from "./basis.ts";
import { Engine, type ParamsOf } from "./engine.ts";

type Params = ParamsOf<"cexdex">;

const FEES_BPS = 10;
const COOLDOWN_MS = 2000;

export class CexdexEngine extends Engine<Params> {
  readonly id: EngineId = "cexdex";
  readonly subscribes: readonly EventName[] = ["feed.dexquote"];
  private last: OpportunityContract | null = null;
  private arbs = 0;

  protected override onConfigure(): void {
    this.last = null;
    this.cooldownMs = COOLDOWN_MS;
  }

  onEvent<K extends EventName>(name: K, payload: HydraEvents[K]): void {
    if (name === "feed.dexquote") this.onQuote(payload as DexQuote);
  }

  override contract(): OpportunityContract | null {
    return this.last;
  }

  override stats(): Record<string, number> {
    return { ...super.stats(), arbs: this.arbs };
  }

  private onQuote(q: DexQuote): void {
    const { base, quote } = parsePair(q.pair);
    const symbol = `${base}${quote}`;
    if (!this.symbols.includes(symbol) || q.bid <= 0 || q.ask <= 0 || this.sizeUsd <= 0) return;
    const spot = this.ctx.feed.spotTopOfBook(symbol);
    if (spot === null || spot.bid <= 0 || spot.ask <= 0) return;
    if (this.inCooldown(symbol, q.tsNs)) return;
    const dexMid = (q.bid + q.ask) / 2;
    const costBps = FEES_BPS + (q.gasUsd / this.sizeUsd) * 10_000 + ((q.ask - q.bid) / dexMid) * 5000;
    // Direction A: buy spot at ask, sell on DEX at bid. Direction B: buy DEX at ask, sell spot at bid.
    const edgeA = ((q.bid - spot.ask) / spot.ask) * 10_000 - costBps;
    const edgeB = ((spot.bid - q.ask) / q.ask) * 10_000 - costBps;
    const edge = Math.max(edgeA, edgeB);
    if (edge < this.params.minEdgeBps) return;
    const buySpot = edgeA >= edgeB;
    const spotPx = buySpot ? spot.ask : spot.bid;
    const qty = this.sizeUsd / spotPx;
    const dexPaper = this.paper || this.ctx.mode === "demo";
    this.arbs++;
    this.cooldownUntilNs.set(symbol, q.tsNs + COOLDOWN_MS * 1e6);
    this.last = this.contractOf(symbol, buySpot ? "BUY" : "SELL", "spot", edge, Math.min(1, edge / (this.params.minEdgeBps * 2)), COOLDOWN_MS, { pair: q.pair, edgeA, edgeB, gasUsd: q.gasUsd });
    void this.emitIntent({
      venue: "spot",
      symbol,
      side: buySpot ? "BUY" : "SELL",
      qty,
      type: "MARKET",
      tSignalNs: q.tsNs,
      reduce: true, // flat on arrival: no position to track, cooldown set above
      legs: [leg(this.id, "spot", symbol, buySpot ? "BUY" : "SELL", qty, q.tsNs, this.paper), leg(this.id, "dex", q.pair, buySpot ? "SELL" : "BUY", qty, q.tsNs, dexPaper)],
    });
  }
}
