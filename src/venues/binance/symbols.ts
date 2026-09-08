// symbol -> tick/step filters from exchangeInfo, per venue. `round()` snaps a price or quantity
// to the venue grid (price rounds to nearest tick; qty truncates to the step so we never oversize).

import type { Venue } from "../../core/types.ts";
import type { ExchangeInfo } from "./rest-futures.ts";

export interface SymbolFilter {
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
  /** Decimal places implied by tickSize / stepSize; used for string formatting. */
  pricePrecision: number;
  qtyPrecision: number;
}

function decimals(step: number): number {
  if (step >= 1) return 0;
  const s = step.toString();
  const e = s.indexOf("e-");
  if (e >= 0) return Number(s.slice(e + 2));
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

function numberField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export class SymbolFilters {
  private readonly filters = new Map<string, SymbolFilter>();

  /** Ingests `exchangeInfo.symbols[]`; unknown filter types are ignored. */
  load(venue: Venue, info: ExchangeInfo): number {
    let n = 0;
    for (const s of info.symbols) {
      let tickSize = 0;
      let stepSize = 0;
      let minQty = 0;
      let minNotional = 0;
      for (const f of s.filters) {
        if (f.filterType === "PRICE_FILTER") tickSize = numberField(f, "tickSize");
        else if (f.filterType === "LOT_SIZE") {
          stepSize = numberField(f, "stepSize");
          minQty = numberField(f, "minQty");
        } else if (f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL") {
          minNotional = numberField(f, "notional") || numberField(f, "minNotional");
        }
      }
      if (tickSize <= 0 || stepSize <= 0) continue;
      this.filters.set(`${venue}:${s.symbol}`, { tickSize, stepSize, minQty, minNotional, pricePrecision: decimals(tickSize), qtyPrecision: decimals(stepSize) });
      n++;
    }
    return n;
  }

  get(venue: Venue, symbol: string): SymbolFilter | null {
    return this.filters.get(`${venue}:${symbol}`) ?? null;
  }

  /** Snaps `value` to the symbol grid; unknown symbol returns the value unchanged. */
  round(venue: Venue, symbol: string, kind: "price" | "qty", value: number): number {
    const f = this.filters.get(`${venue}:${symbol}`);
    if (f === undefined) return value;
    if (kind === "price") return Number((Math.round(value / f.tickSize) * f.tickSize).toFixed(f.pricePrecision));
    return Number((Math.floor(value / f.stepSize + 1e-9) * f.stepSize).toFixed(f.qtyPrecision));
  }

  /** Fixed-precision string for the REST body. */
  format(venue: Venue, symbol: string, kind: "price" | "qty", value: number): string {
    const f = this.filters.get(`${venue}:${symbol}`);
    if (f === undefined) return String(value);
    return this.round(venue, symbol, kind, value).toFixed(kind === "price" ? f.pricePrecision : f.qtyPrecision);
  }

  get size(): number {
    return this.filters.size;
  }
}
