import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Bus } from "../../../src/core/bus.ts";
import { loadConfig } from "../../../src/core/config.ts";
import { openLedger } from "../../../src/core/ledger.ts";
import type { Intent, SmartMoneyEvent } from "../../../src/core/types.ts";
import { AuditCache } from "../../../src/hot/audit-cache.ts";
import type { EngineCtx, EngineFeed } from "../../../src/hot/engines/engine.ts";
import { EngineRegistry } from "../../../src/hot/engines/registry.ts";
import { SmmirrorEngine } from "../../../src/hot/engines/smmirror.ts";
import type { SubmitResult } from "../../../src/hot/executor.ts";
import { mapTrackerPush } from "../../../src/venues/onchain/adapter.ts";
import { SkillsHttp } from "../../../src/venues/onchain/skills-http.ts";
import { REPO_CONFIG, until } from "../../core/helpers.ts";

const CONFIG = loadConfig(REPO_CONFIG);
// fixtures/audit.json grades these two; the tracker fixture's tokens are not in the table.
const PASS_TOKEN = "0x55d398326f99059ff775485246999027b3197955";
const FAIL_TOKEN = "0xdeadbeef00000000000000000000000000000001";

/** First (BUY) line of fixtures/smartmoney.ndjson with the token swapped for a graded one. */
function trackerBuy(token: string, tsNs: number): SmartMoneyEvent {
  const line = readFileSync("fixtures/smartmoney.ndjson", "utf8").split("\n").find((l) => l.trim().length > 0) as string;
  const e = mapTrackerPush(JSON.parse(line), tsNs);
  if (e === null || e.side !== "BUY") throw new Error("fixture line 1 must be a BUY");
  return { ...e, token };
}

const feed: EngineFeed = {
  book: () => null,
  mark: () => null,
  burst: () => ({ buyUsd1s: 0, sellUsd1s: 0 }),
  gapBps: () => 0,
  vwap1m: () => 0,
  adv: () => 0,
  spotTopOfBook: () => null,
  referenceMid: () => 1.0,
};

describe("smmirror", () => {
  test("PASS token is mirrored once with the audit cached; FAIL token is audited and skipped; source sell closes", async () => {
    const bus = new Bus();
    const now = { ns: 1_000_000_000 };
    const intents: Intent[] = [];
    const audit = new AuditCache(() => 1_700_000_000_000);
    const ledger = openLedger(":memory:");
    const ctx: EngineCtx = {
      feed,
      submit: (i): Promise<SubmitResult> => {
        intents.push(i);
        return Promise.resolve({ ok: true, orders: [], fills: [] });
      },
      skills: new SkillsHttp({ base: "off" }),
      audit,
      ledger,
      bus,
      nowNs: () => now.ns,
      wallMs: () => 1_700_000_000_000,
      mode: "demo",
      risk: CONFIG.risk,
    };
    const registry = new EngineRegistry(ctx, { smmirror: (c) => new SmmirrorEngine(c) });
    expect(registry.apply({ engines: { ...CONFIG.engines.engines, smmirror: { enabled: true, paper: true, symbols: [], sizeUsd: 100, params: {} } } }).applied).toEqual(["smmirror"]);
    registry.start();
    try {
      const pass = trackerBuy(PASS_TOKEN, now.ns);
      bus.emit("feed.onchain.smartmoney", pass);
      await until(() => intents.length === 1);
      expect(audit.get(PASS_TOKEN)?.pass).toBe(true);
      const i = intents[0] as Intent;
      expect(i).toMatchObject({ engine: "smmirror", venue: "dex", side: "BUY", type: "MARKET", paper: true, tSignalNs: now.ns });
      expect(i.symbol.endsWith("/USDT")).toBe(true); // USDTUSDT is not a spot listing -> DEX leg
      // S14: kernel rule 9 looks the audit up by the intent symbol, so the PASS must be bound to it too.
      expect(audit.fresh(i.symbol, 600)).toBe(true);
      expect(i.qty).toBeCloseTo(100, 6);
      expect(i.tp).toBeCloseTo(1.004, 9);
      expect(i.sl).toBeCloseTo(0.997, 9);

      bus.emit("feed.onchain.smartmoney", pass); // same token again while open: nothing
      await until(() => registry.stats().smmirror?.open === 1);
      expect(intents.length).toBe(1);

      bus.emit("feed.onchain.smartmoney", trackerBuy(FAIL_TOKEN, now.ns));
      await until(() => audit.get(FAIL_TOKEN) !== null);
      expect(audit.get(FAIL_TOKEN)?.pass).toBe(false);
      expect(audit.get(FAIL_TOKEN)?.risk).toBe("HIGH");
      expect(intents.length).toBe(1);
      expect(registry.stats().smmirror).toMatchObject({ intents: 1, mirrored: 1, skippedAudit: 1, open: 1 });

      // Source wallet sells 30 % then 15 % of its entry: the second crosses exitOnSellPct (40).
      bus.emit("feed.onchain.smartmoney", { ...pass, side: "SELL", amountUsd: pass.amountUsd * 0.3, tsNs: now.ns + 1 });
      expect(intents.length).toBe(1);
      bus.emit("feed.onchain.smartmoney", { ...pass, side: "SELL", amountUsd: pass.amountUsd * 0.15, tsNs: now.ns + 2 });
      await until(() => intents.length === 2);
      expect(intents[1]).toMatchObject({ id: `${i.id}-x`, side: "SELL", venue: "dex", symbol: i.symbol, paper: true });
      expect(registry.stats().smmirror).toMatchObject({ exits: 1, open: 0 });

      // Stale tracker event (older than maxTokenAgeSec) is dropped before any skills call.
      bus.emit("feed.onchain.smartmoney", trackerBuy(PASS_TOKEN, now.ns - 3601 * 1e9));
      expect(intents.length).toBe(2);
      expect(registry.stats().smmirror?.skippedAudit).toBe(1);
    } finally {
      registry.stop();
      ledger.close();
    }
  });
});
