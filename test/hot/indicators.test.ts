import { describe, expect, test } from "bun:test";
import { calcAtr, calcEma, calcHighest, calcLowest, calcRsi } from "../../src/hot/indicators.ts";
import type { KlineCandle } from "../../src/venues/binance/rest-futures.ts";

describe("indicators", () => {
  test("calcEma handles simple array and smoothing", () => {
    expect(Number.isNaN(calcEma([], 5))).toBe(true);
    expect(calcEma([10], 5)).toBe(10);
    const data = [10, 11, 12, 13, 14, 15];
    const ema = calcEma(data, 3);
    expect(ema).toBeGreaterThan(12);
    expect(ema).toBeLessThanOrEqual(15);
  });

  test("calcRsi calculates bounded RSI 0-100", () => {
    // Insufficient data
    expect(Number.isNaN(calcRsi([10, 11], 14))).toBe(true);

    // Monotonically increasing closes -> RSI = 100
    const upCloses = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
    expect(calcRsi(upCloses, 14)).toBe(100);

    // Monotonically decreasing closes -> RSI close to 0
    const downCloses = Array.from({ length: 20 }, (_, i) => 200 - i * 2);
    expect(calcRsi(downCloses, 14)).toBeLessThan(5);

    // Oscillating closes -> RSI ~ 50
    const oscillating = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 2 : -2));
    const rsi = calcRsi(oscillating, 14);
    expect(rsi).toBeGreaterThan(40);
    expect(rsi).toBeLessThan(60);
  });

  test("calcAtr computes average true range", () => {
    const candles: KlineCandle[] = Array.from({ length: 20 }, (_, i) => ({
      openTime: i * 60_000,
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1000,
      closeTime: (i + 1) * 60_000 - 1,
    }));

    const atr = calcAtr(candles, 14);
    expect(atr).toBeCloseTo(10, 0);
  });

  test("calcHighest and calcLowest find extrema over lookback window", () => {
    const candles: KlineCandle[] = [
      { openTime: 0, open: 100, high: 105, low: 95, close: 101, volume: 10, closeTime: 59 },
      { openTime: 60, open: 101, high: 120, low: 98, close: 115, volume: 10, closeTime: 119 },
      { openTime: 120, open: 115, high: 110, low: 90, close: 92, volume: 10, closeTime: 179 },
      { openTime: 180, open: 92, high: 95, low: 88, close: 90, volume: 10, closeTime: 239 },
      { openTime: 240, open: 90, high: 91, low: 85, close: 89, volume: 10, closeTime: 299 }, // current forming
    ];

    // Lookback 3 candles excluding current forming candle (offset = 1) -> candles [1, 2, 3]
    const highest = calcHighest(candles, 3, 1);
    expect(highest).toBe(120);

    const lowest = calcLowest(candles, 3, 1);
    expect(lowest).toBe(88);
  });
});
