// entriesBlocked policy: a pre-existing venue balance the ledger never bought (e.g. a testnet faucet)
// is inert inventory and must NOT permanently block live entries; only genuine risk — any futures
// mismatch, or phantom spot where the ledger claims more than the venue holds — fails closed.

import { expect, test } from "bun:test";
import { Bus } from "../../src/core/bus.ts";
import { openLedger } from "../../src/core/ledger.ts";
import { Positions } from "../../src/hot/positions.ts";
import { FuturesRest } from "../../src/venues/binance/rest-futures.ts";
import { SpotRest } from "../../src/venues/binance/rest-spot.ts";
import { startFakeBinance } from "./fake-binance.ts";

test("external spot inventory is inert; futures mismatch fails closed", async () => {
  const fake = startFakeBinance();
  const ledger = openLedger(":memory:");
  const bus = new Bus();
  const futures = new FuturesRest({ baseUrl: fake.futuresUrl, key: "k", secret: "s" });
  const spot = new SpotRest({ baseUrl: fake.spotUrl, key: "k", secret: "s" });
  const positions = new Positions({ ledger, futures, spot, bus, spotSymbols: ["BTCUSDT", "ETHUSDT"], reconcileMs: 0, snapMs: 0 });
  try {
    // Faucet gives 1 BTC the ledger never traded through HYDRA — external inventory.
    fake.state.spotBalances.set("BTC", 1);
    await positions.reconcile();
    expect(positions.entriesBlocked).toBe(false);

    // The venue reports a futures position the ledger does not know about — genuine hidden risk.
    fake.state.futuresPositions.set("BTCUSDT", 0.01);
    await positions.reconcile();
    expect(positions.entriesBlocked).toBe(true);

    // Clearing the futures mismatch (external spot inventory still present) unblocks again.
    fake.state.futuresPositions.delete("BTCUSDT");
    await positions.reconcile();
    expect(positions.entriesBlocked).toBe(false);
  } finally {
    positions.stop();
    ledger.close();
    fake.stop();
  }
});
