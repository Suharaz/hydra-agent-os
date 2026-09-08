import { expect, test } from "bun:test";

import type { Intent } from "../../src/core/types.ts";
import { PaperAdapter } from "../../src/venues/onchain/paper-adapter.ts";

function intent(side: "BUY" | "SELL", qty: number): Intent {
  return { id: `i-${side}`, engine: "smmirror", venue: "dex", symbol: "BNB/USDT@56", side, qty, type: "MARKET", ttlMs: 1000, paper: true, tSignalNs: 0 };
}

test("paper swap fills at the last quote's touch within 20 bps and returns a SwapResult", async () => {
  const a = new PaperAdapter({ fixturePath: "nonexistent.ndjson", referenceMid: () => 600, slippageBps: 15, gasUsd: 0.07 });
  const q = await a.quote("BNB/USDT@56");
  const buy = await a.swap(intent("BUY", 0.5));
  expect(buy.qty).toBe(0.5);
  expect(buy.fee).toBe(0.07);
  expect(buy.txOrRef).toMatch(/^paper-i-BUY-/);
  expect(buy.price).toBeCloseTo(q.ask * 1.0015, 8);
  expect(buy.price / q.ask - 1).toBeLessThanOrEqual(0.002);

  const sell = await a.swap(intent("SELL", 0.5));
  expect(sell.price).toBeCloseTo(q.bid * 0.9985, 8);
  expect(sell.txOrRef).not.toBe(buy.txOrRef);
});

test("slippage is capped at 20 bps and an unquoted pair is quoted on demand", async () => {
  const a = new PaperAdapter({ fixturePath: "nonexistent.ndjson", referenceMid: () => 3000, slippageBps: 500 });
  const r = await a.swap(intent("BUY", 1));
  const q = a.lastQuote("BNB/USDT@56");
  expect(q).not.toBeNull();
  expect(r.price).toBeCloseTo((q?.ask ?? 0) * 1.002, 8);
});
