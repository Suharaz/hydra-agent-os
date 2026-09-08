// Book-imbalance helpers (not an engine). Engines that want a passive entry ask `shouldUseLimit`
// whether the top of book is fresh and not already leaning against the resting side, then price
// the order one tick inside the touch with `limitPrice`. Tick size is not part of the feed, so
// `inferTick` derives it from the decimals the venue actually prints; the executor rounds anyway.

import type { Side } from "../../core/types.ts";
import type { BookView } from "../feed-hub.ts";

export const BOOK_MAX_AGE_MS = 2000;
const IMBALANCE_LEVELS = 5;

/** Fresh synced book, else every LIMIT price would be stale. */
export function bookUsable(book: BookView | null): book is BookView {
  return book !== null && book.synced && book.ageMs < BOOK_MAX_AGE_MS && book.bestBid > 0 && book.bestAsk > 0;
}

/**
 * True when a resting LIMIT one tick inside the touch has a fair chance to fill: the book is
 * usable and the top levels are not already stacked on our side (bids heavy for a BUY means
 * price lifts before a passive bid fills; symmetric for SELL). Imbalance is (bid-ask)/(bid+ask).
 */
export function shouldUseLimit(book: BookView | null, side: Side, threshold = 0.2): boolean {
  if (!bookUsable(book)) return false;
  const imb = book.imbalance(IMBALANCE_LEVELS);
  return side === "BUY" ? imb <= threshold : imb >= -threshold;
}

/** Best bid + 1 tick for a BUY, best ask - 1 tick for a SELL; never crosses the spread. */
export function limitPrice(book: BookView, side: Side, tickSize: number): number {
  const tick = tickSize > 0 ? tickSize : inferTick(book);
  if (side === "BUY") return Math.min(book.bestBid + tick, book.bestAsk);
  return Math.max(book.bestAsk - tick, book.bestBid);
}

/** Smallest decimal step visible in the touch prices (1 when both are integers). */
export function inferTick(book: Pick<BookView, "bestBid" | "bestAsk">): number {
  const d = Math.max(decimals(book.bestBid), decimals(book.bestAsk));
  return d === 0 ? 1 : Number(`1e-${d}`);
}

function decimals(x: number): number {
  const s = String(x);
  const e = s.indexOf("e-");
  if (e >= 0) return Number(s.slice(e + 2)) + Math.max(0, s.indexOf(".") >= 0 ? e - s.indexOf(".") - 1 : 0);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}
