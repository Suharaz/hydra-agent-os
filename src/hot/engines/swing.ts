// swing: Adaptive Multi-Mode Kline & Swing Trading Engine (15m/30m).
// Evaluates price action, EMA trends, RSI extremes, and ATR-based dynamic stops.
// Supports 3 tactical modes:
//   0: Breakout (trend-following N-candle range breakout)
//   1: Pullback (trend continuation on EMA re-test)
//   2: Reversal (mean reversion on RSI extreme overbought/oversold)

import type { EventName, HydraEvents } from "../../core/bus.ts";
import type { EngineId, MarkEvent, OpportunityContract, Side } from "../../core/types.ts";
import { logger } from "../../core/log.ts";
import { Engine, type IntentDraft, type ParamsOf } from "./engine.ts";
import { calcAtr, calcEma, calcHighest, calcLowest, calcRsi } from "../indicators.ts";

const log = logger("swing");

type Params = ParamsOf<"swing">;

export class SwingEngine extends Engine<Params> {
  readonly id: EngineId = "swing";
  readonly subscribes: readonly EventName[] = ["feed.mark"];
  private last: OpportunityContract | null = null;
  private signalsCount = 0;

  protected override onConfigure(): void {
    this.last = null;
    this.cooldownMs = this.params.timeframeSec * 1000;
  }

  onEvent<K extends EventName>(name: K, payload: HydraEvents[K]): void {
    if (name === "feed.mark") this.onMark(payload as MarkEvent);
  }

  override contract(): OpportunityContract | null {
    return this.last;
  }

  override stats(): Record<string, number> {
    return { ...super.stats(), signals: this.signalsCount, activeMode: this.params.mode };
  }

  private onMark(e: MarkEvent): void {
    if (!this.symbols.includes(e.symbol)) return;
    if (this.inCooldown(e.symbol, e.tsNs) || this.hasOpen(e.symbol)) return;

    const p = this.params;
    const feed = this.ctx.feed;
    const klines = feed.klines?.(e.symbol) ?? [];

    const minRequired = Math.max(p.lookbackCandles, p.slowEma, 20);
    if (klines.length < minRequired) return;

    const closes = klines.map((c) => c.close);
    const fastEma = calcEma(closes, p.fastEma);
    const slowEma = calcEma(closes, p.slowEma);
    const rsi = calcRsi(closes, 14);
    const atr = calcAtr(klines, 14);
    const mark = e.mark;

    if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(fastEma) || !Number.isFinite(slowEma)) return;

    let signal: Side | null = null;
    let setupReason = "";

    switch (p.mode) {
      case 0: {
        // Mode 0: Breakout
        const high = calcHighest(klines, p.lookbackCandles);
        const low = calcLowest(klines, p.lookbackCandles);
        if (mark > high && fastEma > slowEma) {
          signal = "BUY";
          setupReason = `breakout_high_${p.lookbackCandles}`;
        } else if (mark < low && fastEma < slowEma) {
          signal = "SELL";
          setupReason = `breakout_low_${p.lookbackCandles}`;
        }
        break;
      }
      case 1: {
        // Mode 1: Pullback to fastEma
        const tolerance = 0.3 * atr;
        if (fastEma > slowEma && Math.abs(mark - fastEma) <= tolerance && mark >= fastEma) {
          signal = "BUY";
          setupReason = `pullback_bounce_ema${p.fastEma}`;
        } else if (fastEma < slowEma && Math.abs(mark - fastEma) <= tolerance && mark <= fastEma) {
          signal = "SELL";
          setupReason = `pullback_reject_ema${p.fastEma}`;
        }
        break;
      }
      case 2: {
        // Mode 2: Reversal (RSI Extreme)
        if (rsi <= p.rsiThreshold) {
          signal = "BUY";
          setupReason = `rsi_oversold_${rsi.toFixed(1)}`;
        } else if (rsi >= 100 - p.rsiThreshold) {
          signal = "SELL";
          setupReason = `rsi_overbought_${rsi.toFixed(1)}`;
        }
        break;
      }
      default:
        break;
    }

    if (signal === null) return;

    const notional = this.sizeUsd > 0 ? this.sizeUsd : 50;
    const qty = notional / mark;

    const slDist = p.slAtr * atr;
    const tpDist = p.tpAtr * atr;
    const sl = signal === "BUY" ? mark - slDist : mark + slDist;
    const tp = signal === "BUY" ? mark + tpDist : mark - tpDist;
    const contract: OpportunityContract = {
      engine: "swing",
      venue: "futures",
      symbol: e.symbol,
      side: signal,
      edgeBps: Math.round((tpDist / mark) * 10_000),
      confidence: 0.8,
      sizeUsd: notional,
      ttlMs: 5000,
      tsNs: e.tsNs,
      meta: {
        mode: p.mode,
        setup: setupReason,
        mark,
        fastEma,
        slowEma,
        rsi: Number.isFinite(rsi) ? Number(rsi.toFixed(1)) : null,
        atr: Number(atr.toFixed(2)),
        sl,
        tp,
      },
    };

    this.last = contract;
    this.signalsCount++;

    const draft: IntentDraft = {
      venue: "futures",
      symbol: e.symbol,
      side: signal,
      qty,
      type: "MARKET",
      sl,
      tp,
      ttlMs: 5000,
      paper: this.paper,
      tSignalNs: e.tsNs,
      cooldownMs: p.timeframeSec * 1000,
      maxHoldMs: p.maxHoldMs,
    };

    log.info("signal detected", { symbol: e.symbol, side: signal, mode: p.mode, setup: setupReason, mark, sl, tp });
    void this.emitIntent(draft);
  }
}
