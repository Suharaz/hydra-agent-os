// REST fill recovery: replay `userTrades` / `myTrades` past the highest trade_id in the ledger.
// Runs at boot and after every user-data reconnect. Trades whose exchange orderId is not in
// `orders` were not placed by this process (or their ack never landed) and are skipped with a
// log line. `UNIQUE(venue, symbol, trade_id)` (S05) makes replays idempotent: `exec.fill` fires
// only for rows `insertFill` actually inserted. Pages are fully drained to handle large gaps.

import { bus as globalBus, type Bus } from "../../core/bus.ts";
import { nowNs } from "../../core/clock.ts";
import type { Ledger } from "../../core/ledger.ts";
import { logger } from "../../core/log.ts";
import type { Fill, Venue } from "../../core/types.ts";
import type { FuturesRest } from "./rest-futures.ts";
import type { SpotRest } from "./rest-spot.ts";
import { orderBySymbolExtId } from "./userdata.ts";

const log = logger("recovery");

export interface RecoverFillsDeps {
  ledger: Ledger;
  futuresRest?: FuturesRest;
  spotRest?: SpotRest;
  futuresSymbols?: readonly string[];
  spotSymbols?: readonly string[];
  bus?: Bus;
}

export interface RecoverFillsResult {
  inserted: number;
  skipped: number;
}

/** Common shape of `FuturesUserTrade` and `SpotMyTrade` after side normalisation. */
interface VenueTrade {
  id: number;
  orderId: number;
  symbol: string;
  side: "BUY" | "SELL";
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
}

export async function recoverFills(deps: RecoverFillsDeps): Promise<RecoverFillsResult> {
  const bus = deps.bus ?? globalBus;
  const out: RecoverFillsResult = { inserted: 0, skipped: 0 };

  // S05: drain all pages until the venue returns fewer than `limit` trades (page complete).
  const replay = async (venue: Venue, symbol: string, fetch: (fromId: number | undefined, limit: number) => Promise<VenueTrade[]>, limit = 1000) => {
    let fromId = deps.ledger.db.query<{ next_id: number }, [Venue, string]>("SELECT next_id FROM fill_recovery_cursor WHERE venue = ? AND symbol = ?").get(venue, symbol)?.next_id ?? 0;
    let blocked = false;
    let page: VenueTrade[];
    do {
      try {
        page = await fetch(fromId, limit);
      } catch (err) {
        log.error("trade replay failed", { venue, symbol, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const previous = fromId;
      for (const t of page) {
        fromId = Math.max(fromId, t.id + 1);
        // S05: use symbol-scoped order lookup to avoid cross-symbol collisions.
        const order = orderBySymbolExtId(deps.ledger, venue, t.symbol, String(t.orderId));
        if (order === null) {
          log.warn("trade for unknown order; skipped", { venue, symbol, tradeId: t.id, orderId: t.orderId });
          out.skipped++;
          blocked = true;
          continue;
        }
        const fill: Fill = {
          orderId: order.id,
          venue,
          symbol: t.symbol,
          tradeId: String(t.id),
          side: t.side,
          price: Number(t.price),
          qty: Number(t.qty),
          fee: Number(t.commission),
          feeAsset: t.commissionAsset,
          tsNs: nowNs(),
        };
        if (deps.ledger.insertFill(fill) === null) {
          out.skipped++;
        } else {
          out.inserted++;
          bus.emit("exec.fill", fill);
        }
      }
      if (!blocked) deps.ledger.db.query("INSERT INTO fill_recovery_cursor (venue, symbol, next_id) VALUES (?, ?, ?) ON CONFLICT (venue, symbol) DO UPDATE SET next_id = MAX(next_id, excluded.next_id)").run(venue, symbol, fromId);
      if (page.length >= limit && fromId <= previous) throw new Error(`non-advancing trade page: ${venue}:${symbol}`);
    } while (page.length >= limit);
  };

  const futures = deps.futuresRest;
  if (futures !== undefined) {
    for (const symbol of deps.futuresSymbols ?? []) {
      await replay("futures", symbol, (fromId, limit) => futures.userTrades(symbol, fromId, limit));
    }
  }
  const spot = deps.spotRest;
  if (spot !== undefined) {
    for (const symbol of deps.spotSymbols ?? []) {
      await replay("spot", symbol, async (fromId, limit) =>
        (await spot.myTrades(symbol, fromId, limit)).map((t) => ({
          id: t.id,
          orderId: t.orderId,
          symbol: t.symbol,
          side: t.isBuyer ? "BUY" : "SELL",
          price: t.price,
          qty: t.qty,
          commission: t.commission,
          commissionAsset: t.commissionAsset,
        })),
      );
    }
  }
  log.info("fill recovery done", { inserted: out.inserted, skipped: out.skipped });
  return out;
}
