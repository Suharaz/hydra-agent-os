// Mathematical technical indicators for Kline / candlestick analysis.
// High-performance, zero-dependency, allocation-conscious functions.

import type { KlineCandle } from "../venues/binance/rest-futures.ts";

/**
 * Exponential Moving Average (EMA)
 * Computes EMA series or latest EMA for a numeric array.
 */
export function calcEma(values: readonly number[], period: number): number {
  if (values.length === 0) return Number.NaN;
  if (period <= 1 || values.length === 1) return values[values.length - 1] as number;

  const k = 2 / (period + 1);
  // Seed with SMA of first min(period, values.length)
  const seedLen = Math.min(period, values.length);
  let ema = 0;
  for (let i = 0; i < seedLen; i++) {
    ema += values[i] as number;
  }
  ema /= seedLen;

  for (let i = seedLen; i < values.length; i++) {
    ema = (values[i] as number) * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Relative Strength Index (RSI) using Wilder's smoothing.
 * Standard default period is 14. Returns 0-100 (or NaN if insufficient data).
 */
export function calcRsi(closes: readonly number[], period = 14): number {
  if (closes.length <= period) return Number.NaN;

  let sumGain = 0;
  let sumLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = (closes[i] as number) - (closes[i - 1] as number);
    if (diff > 0) sumGain += diff;
    else sumLoss += -diff;
  }

  let avgGain = sumGain / period;
  let avgLoss = sumLoss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = (closes[i] as number) - (closes[i - 1] as number);
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Average True Range (ATR).
 * TR = max(high - low, abs(high - prevClose), abs(low - prevClose))
 */
export function calcAtr(candles: readonly KlineCandle[], period = 14): number {
  if (candles.length <= 1) return 0;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i] as KlineCandle;
    const prev = candles[i - 1] as KlineCandle;
    const hl = curr.high - curr.low;
    const hpc = Math.abs(curr.high - prev.close);
    const lpc = Math.abs(curr.low - prev.close);
    trs.push(Math.max(hl, hpc, lpc));
  }

  if (trs.length === 0) return 0;
  const p = Math.min(period, trs.length);
  return calcEma(trs, p);
}

/**
 * Highest high over the last `count` closed candles (excluding current forming candle).
 */
export function calcHighest(candles: readonly KlineCandle[], count: number, offset = 1): number {
  const end = candles.length - offset;
  const start = Math.max(0, end - count);
  let highest = Number.NEGATIVE_INFINITY;
  for (let i = start; i < end; i++) {
    const h = (candles[i] as KlineCandle).high;
    if (h > highest) highest = h;
  }
  return highest;
}

/**
 * Lowest low over the last `count` closed candles (excluding current forming candle).
 */
export function calcLowest(candles: readonly KlineCandle[], count: number, offset = 1): number {
  const end = candles.length - offset;
  const start = Math.max(0, end - count);
  let lowest = Number.POSITIVE_INFINITY;
  for (let i = start; i < end; i++) {
    const l = (candles[i] as KlineCandle).low;
    if (l < lowest) lowest = l;
  }
  return lowest;
}
