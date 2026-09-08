// tokstock: tokenized-stock mispricing. Every 10 s each whitelisted DEX pair (`TSLA/USDT`) is
// polled through skills-http.tokenizedStock; when the token trades >= devBps away from the
// reference (mainnet spot mid when one exists, else the underlying stock price scaled by the
// share multiplier) a paper DEX intent bets on mean reversion: TP at the reference, SL one more
// devBps away, time stop 10 min. Always paper: there is no live venue for these tokens yet.

import type { EventName } from "../../core/bus.ts";
import type { EngineId, OpportunityContract, Side, Venue } from "../../core/types.ts";
import { logger } from "../../core/log.ts";
import { parsePair } from "../../venues/onchain/adapter.ts";
import { Engine, type ParamsOf } from "./engine.ts";

const log = logger("tokstock");

type Params = ParamsOf<"tokstock">;

const POLL_MS = 10_000;
const MAX_HOLD_MS = 10 * 60_000;

export class TokstockEngine extends Engine<Params> {
  readonly id: EngineId = "tokstock";
  readonly subscribes: readonly EventName[] = [];
  private readonly lastPx = new Map<string, number>();
  private last: OpportunityContract | null = null;
  private lastPollNs = 0;
  private inflight = false;
  private polls = 0;
  private deviations = 0;

  protected override onConfigure(): void {
    this.last = null;
    this.lastPollNs = 0;
  }

  onEvent(): void {}

  override contract(): OpportunityContract | null {
    return this.last;
  }

  override stats(): Record<string, number> {
    return { ...super.stats(), polls: this.polls, deviations: this.deviations };
  }

  protected override markOf(venue: Venue, symbol: string): number {
    return venue === "dex" ? (this.lastPx.get(symbol) ?? 0) : super.markOf(venue, symbol);
  }

  override onTick(nowNs: number): void {
    super.onTick(nowNs);
    const skills = this.ctx.skills;
    if (skills === null || this.inflight || this.symbols.length === 0 || nowNs - this.lastPollNs < POLL_MS * 1e6) return;
    this.lastPollNs = nowNs;
    this.polls++;
    this.inflight = true;
    void this.poll(nowNs).finally(() => {
      this.inflight = false;
    });
  }

  private async poll(nowNs: number): Promise<void> {
    const skills = this.ctx.skills;
    if (skills === null) return;
    for (const pair of this.symbols) {
      const { base, quote } = parsePair(pair);
      let stock;
      try {
        stock = await skills.tokenizedStock(base);
      } catch (err) {
        log.warn("tokenizedStock failed", { ticker: base, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (stock === null || stock.tokenPrice === null || stock.tokenPrice <= 0) continue;
      const px = stock.tokenPrice;
      this.lastPx.set(pair, px);
      const ref = this.ctx.feed.referenceMid(base, quote) ?? (stock.stockPrice === null ? null : stock.stockPrice * (stock.sharesMultiplier > 0 ? stock.sharesMultiplier : 1));
      if (ref === null || ref <= 0) continue;
      const devBps = ((px - ref) / ref) * 10_000;
      if (Math.abs(devBps) < this.params.devBps || this.hasOpen(pair) || this.inCooldown(pair, nowNs)) continue;
      this.deviations++;
      const side: Side = devBps > 0 ? "SELL" : "BUY";
      const away = 1 + (Math.sign(devBps) * this.params.devBps) / 10_000;
      this.last = this.contractOf(pair, side, "dex", Math.abs(devBps), Math.min(1, Math.abs(devBps) / (this.params.devBps * 2)), MAX_HOLD_MS, { tokenPrice: px, reference: ref, openState: stock.openState });
      await this.emitIntent({ venue: "dex", symbol: pair, side, qty: this.sizeUsd / px, type: "MARKET", tp: ref, sl: px * away, paper: true, tSignalNs: nowNs, maxHoldMs: MAX_HOLD_MS, cooldownMs: MAX_HOLD_MS });
    }
  }
}
