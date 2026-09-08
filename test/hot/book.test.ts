import { describe, expect, test } from "bun:test";
import { Book, type DepthDiff } from "../../src/hot/book.ts";

const diff = (U: number, u: number, pu: number, b: [string, string][] = [], a: [string, string][] = []): DepthDiff => ({ U, u, pu, b, a });

describe("Book", () => {
  test("buffers pre-snapshot diffs, then applies snapshot and replays them in order", () => {
    let now = 1000;
    const book = new Book("ETHUSDT", { nowMs: () => now });
    expect(book.synced).toBe(false);
    expect(book.ageMs).toBe(Number.POSITIVE_INFINITY);

    // Two diffs arrive before the REST snapshot: buffered, not applied.
    expect(book.applyDiff(diff(95, 98, 90, [["2999.5", "1"]]))).toBe(false);
    expect(book.applyDiff(diff(99, 102, 98, [["2999.0", "4"]], [["3001.0", "0"]]))).toBe(false);
    expect(book.bufferedDiffs).toBe(2);
    expect(book.bestBid).toBe(0);

    const ok = book.applySnapshot({ lastUpdateId: 100, bids: [["3000.0", "2"], ["2999.0", "1"]], asks: [["3001.0", "3"], ["3002.0", "5"]] });
    expect(ok).toBe(true);
    expect(book.synced).toBe(true);
    // First buffered diff (u=98 < 100) dropped; second brackets 101 and is applied: bid 2999 -> 4, ask 3001 removed.
    expect(book.lastU).toBe(102);
    expect(book.bestBid).toBe(3000);
    expect(book.bestAsk).toBe(3002);
    expect(book.levels("bid", 5)).toEqual([
      { price: 3000, qty: 2 },
      { price: 2999, qty: 4 },
    ]);
    expect(book.bufferedDiffs).toBe(0);

    now = 1250;
    expect(book.ageMs).toBe(250);

    // Continuous chain: pu === lastU.
    expect(book.applyDiff(diff(103, 105, 102, [["3000.5", "1"]], [["3003.0", "2"]]))).toBe(true);
    expect(book.bestBid).toBe(3000.5);
    expect(book.mid).toBe((3000.5 + 3002) / 2);
    expect(book.depth).toEqual({ bids: 3, asks: 2 });
  });

  test("gap in the pu chain unsyncs the book, clears it and asks the owner to resync", () => {
    const gaps: string[] = [];
    const book = new Book("BTCUSDT", { onGap: (sym, detail) => gaps.push(`${sym}:${detail}`) });
    book.applySnapshot({ lastUpdateId: 10, bids: [["60000", "1"]], asks: [["60001", "1"]] });
    // Futures bracket rule: U <= lastUpdateId <= u.
    expect(book.applyDiff(diff(10, 12, 9))).toBe(true);
    // Missed 13..15: pu does not match lastU.
    expect(book.applyDiff(diff(16, 17, 15, [["59999", "2"]]))).toBe(false);
    expect(book.synced).toBe(false);
    expect(book.bestBid).toBe(0);
    expect(book.bestAsk).toBe(0);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toStartWith("BTCUSDT:expected pu=12");
    // The gapped diff is kept for the next snapshot and later diffs buffer behind it.
    expect(book.bufferedDiffs).toBe(1);
    expect(book.applyDiff(diff(18, 19, 17))).toBe(false);
    expect(book.bufferedDiffs).toBe(2);

    // Re-snapshot at 16 replays both buffered diffs (16..17 brackets 17, then 18..19).
    expect(book.applySnapshot({ lastUpdateId: 16, bids: [["60000", "1"]], asks: [["60001", "1"]] })).toBe(true);
    expect(book.synced).toBe(true);
    expect(book.lastU).toBe(19);
    expect(book.levels("bid", 2)).toEqual([
      { price: 60000, qty: 1 },
      { price: 59999, qty: 2 },
    ]);
    expect(gaps).toHaveLength(1);
  });

  test("first diff after a snapshot must bracket lastUpdateId+1", () => {
    let gaps = 0;
    const book = new Book("ETHUSDT", { onGap: () => gaps++ });
    book.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    // Stale diff entirely before the snapshot is ignored without a gap.
    expect(book.applyDiff(diff(90, 99, 89))).toBe(false);
    expect(book.synced).toBe(true);
    // Diff that starts after 101 means we missed an event.
    expect(book.applyDiff(diff(103, 104, 102))).toBe(false);
    expect(book.synced).toBe(false);
    expect(gaps).toBe(1);
  });

  test("spot rule (no pu): U must equal lastU+1", () => {
    let gaps = 0;
    const book = new Book("BNBUSDT", { onGap: () => gaps++ });
    book.applySnapshot({ lastUpdateId: 50, bids: [["600", "1"]], asks: [["601", "1"]] });
    expect(book.applyDiff({ U: 49, u: 52, b: [], a: [] })).toBe(true);
    expect(book.applyDiff({ U: 53, u: 55, b: [["599", "1"]], a: [] })).toBe(true);
    expect(book.applyDiff({ U: 57, u: 58, b: [], a: [] })).toBe(false);
    expect(gaps).toBe(1);
  });

  test("imbalance and microprice", () => {
    const book = new Book("ETHUSDT");
    expect(book.imbalance(5)).toBe(0);
    expect(book.microprice()).toBe(0);
    book.applySnapshot({
      lastUpdateId: 1,
      bids: [["100", "3"], ["99", "1"], ["98", "10"]],
      asks: [["101", "1"], ["102", "1"], ["103", "10"]],
    });
    // Top 1: (3 - 1) / 4 = 0.5; top 2: (4 - 2) / 6.
    expect(book.imbalance(1)).toBeCloseTo(0.5, 12);
    expect(book.imbalance(2)).toBeCloseTo(2 / 6, 12);
    // Top 3 includes the deep levels: (14 - 12) / 26.
    expect(book.imbalance(3)).toBeCloseTo(2 / 26, 12);
    // Microprice leans toward the thin side: (100*1 + 101*3) / 4 = 100.75.
    expect(book.microprice()).toBeCloseTo(100.75, 12);
    expect(book.spreadBps).toBeCloseTo((1 / 100.5) * 10_000, 9);

    // Remove the whole ask side -> microprice falls back to mid (0 with one side empty).
    book.applyDiff({ U: 1, u: 2, pu: 0, b: [], a: [["101", "0"], ["102", "0"], ["103", "0"]] });
    expect(book.bestAsk).toBe(0);
    expect(book.microprice()).toBe(0);
    expect(book.imbalance(3)).toBe(1);
  });
});
