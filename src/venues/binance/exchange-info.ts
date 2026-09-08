// Phase 3 entry point for symbol filters. The cache itself lives in symbols.ts (Phase 2); this
// module adds the boot loader and the dust threshold the kill switch uses to decide "flat".

import type { Venue } from "../../core/types.ts";
import type { FuturesRest } from "./rest-futures.ts";
import type { SpotRest } from "./rest-spot.ts";
import { SymbolFilters } from "./symbols.ts";

export { SymbolFilters, type SymbolFilter } from "./symbols.ts";

/** Smallest tradeable quantity for the symbol; balances below it are dust, not residue. */
export function dustQty(filters: SymbolFilters, venue: Venue, symbol: string): number {
  const f = filters.get(venue, symbol);
  return f === null ? 0 : Math.max(f.stepSize, f.minQty);
}

/** One exchangeInfo call per configured venue; a venue without a client stays unknown (no rounding). */
export async function loadFilters(futures: Pick<FuturesRest, "exchangeInfo"> | null, spot: Pick<SpotRest, "exchangeInfo"> | null): Promise<SymbolFilters> {
  const out = new SymbolFilters();
  const [f, s] = await Promise.all([futures?.exchangeInfo() ?? null, spot?.exchangeInfo() ?? null]);
  if (f !== null) out.load("futures", f);
  if (s !== null) out.load("spot", s);
  return out;
}
