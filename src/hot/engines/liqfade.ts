// liqfade: fade liquidation cascades. forceOrder is a 1/s/symbol *sample*, so the cascade proof is
// `minSnapshots` consecutive one-sided samples inside `windowMs` (each >= minSampleUsd), the mark
// gapped from the index in the cascade's direction, a one-sided taker burst large vs ADV and the
// price displaced from the 1-min VWAP. One intent per cascade: the ring resets and the symbol cools
// down for 2 x windowMs. Exits are executor TP/SL (paper: base-class tick) plus the time stop.

import type { EventName, HydraEvents } from "../../core/bus.ts";
import type { EngineId, LiquidationEvent, OpportunityContract, Side } from "../../core/types.ts";
import { Engine, type EngineCtx, type IntentDraft, opposite, type ParamsOf } from "./engine.ts";
import { bookUsable, limitPrice, shouldUseLimit } from "./imbalance.ts";

type Params = ParamsOf<"liqfade">;

interface Ring {
  side: Side;
  tsNs: number[];
  usd: number[];
}

export class LiqfadeEngine extends Engine<Params> {
  readonly id: EngineId = "liqfade";
  readonly subscribes: readonly EventName[] = ["feed.liq"];
  private readonly rings = new Map<string, Ring>();
  private last: OpportunityContract | null = null;
  private cascades = 0;
  private samples = 0;

  protected override onConfigure(): void {
    this.rings.clear();
    this.last = null;
    this.cooldownMs = this.params.windowMs * 2;
  }

  onEvent<K extends EventName>(name: K, payload: HydraEvents[K]): void {
    if (name === "feed.liq") this.onLiq(payload as LiquidationEvent);
  }

  override contract(): OpportunityContract | null {
    return this.last;
  }

  override stats(): Record<string, number> {
    return { ...super.stats(), samples: this.samples, cascades: this.cascades };
  }

  private onLiq(e: LiquidationEvent): void {
    if (!this.symbols.includes(e.symbol)) return;
    const p = this.params;
    if (e.usd < p.minSampleUsd) return; // dust sample: neither counts nor breaks the streak
    this.samples++;
    let ring = this.rings.get(e.symbol);
    if (ring === undefined || ring.side !== e.side) {
      ring = { side: e.side, tsNs: [], usd: [] };
      this.rings.set(e.symbol, ring);
    }
    const windowNs = p.windowMs * 1e6;
    let drop = 0;
    while (drop < ring.tsNs.length && e.tsNs - (ring.tsNs[drop] as number) > windowNs) drop++;
    if (drop > 0) {
      ring.tsNs.splice(0, drop);
      ring.usd.splice(0, drop);
    }
    ring.tsNs.push(e.tsNs);
    ring.usd.push(e.usd);
    if (ring.tsNs.length < p.minSnapshots) return;
    if (this.inCooldown(e.symbol, e.tsNs) || this.hasOpen(e.symbol)) return;

    const feed = this.ctx.feed;
    const sell = e.side === "SELL";
    // Mark gapped from index in the cascade direction (sell cascade drags mark below index).
    const gap = feed.gapBps(e.symbol);
    if ((sell ? -gap : gap) < p.minGapBps) return;
    const adv = feed.adv(e.symbol);
    if (adv <= 0) return;
    const burst = feed.burst(e.symbol);
    const ratio = (sell ? burst.sellUsd1s : burst.buyUsd1s) / (adv / 86_400);
    if (ratio < p.minBurstRatio) return;
    const vwap = feed.vwap1m(e.symbol);
    if (vwap <= 0) return;
    const book = feed.book(e.symbol);
    const ref = bookUsable(book) ? book.mid : (feed.mark(e.symbol)?.mark ?? e.price);
    const disp = ((sell ? vwap - ref : ref - vwap) / vwap) * 10_000;
    if (disp < p.minDispBps) return;

    const side = opposite(e.side);
    let type: IntentDraft["type"];
    let px: number;
    if (bookUsable(book) && shouldUseLimit(book, side)) {
      type = "LIMIT";
      px = limitPrice(book, side, 0);
    } else if (p.allowMarket) {
      type = "MARKET";
      px = ref;
    } else return;
    if (px <= 0) return;

    this.cascades++;
    this.rings.delete(e.symbol);
    const up = side === "BUY";
    const draft: IntentDraft = {
      venue: "futures",
      symbol: e.symbol,
      side,
      qty: this.sizeUsd / px,
      type,
      tp: up ? px * (1 + p.tpBps / 10_000) : px * (1 - p.tpBps / 10_000),
      sl: up ? px * (1 - p.slBps / 10_000) : px * (1 + p.slBps / 10_000),
      ttlMs: type === "LIMIT" ? p.chaseMs : 5000,
      tSignalNs: e.tsNs,
      cooldownMs: p.windowMs * 2,
    };
    if (type === "LIMIT") draft.price = px;
    const confidence = Math.min(1, 0.5 + 0.1 * (ring.tsNs.length - p.minSnapshots) + 0.1 * Math.min(3, ratio / p.minBurstRatio));
    this.last = this.contractOf(e.symbol, side, "futures", disp, confidence, p.windowMs * 2, {
      snapshots: ring.tsNs.length,
      gapBps: gap,
      burstRatio: ratio,
      dispBps: disp,
      type,
    });
    void this.emitIntent(draft);
  }
}
