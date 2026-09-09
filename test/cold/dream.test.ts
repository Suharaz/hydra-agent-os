import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DREAM_SCHEMA_VERSION,
  executeDreamCycle,
  formatDreamMemoryPrompt,
  loadDreamMemory,
} from "../../src/cold/dream.ts";
import { Bus } from "../../src/core/bus.ts";
import { Ledger, openLedger } from "../../src/core/ledger.ts";
import type { DreamCycleEvent, Fill, Trade, Veto } from "../../src/core/types.ts";
import { cleanup, tempDir } from "../core/helpers.ts";

const dirs: string[] = [];
const openLedgers: Ledger[] = [];

afterEach(() => {
  for (const l of openLedgers.splice(0)) l.close();
  for (const d of dirs.splice(0)) cleanup(d);
});

function freshLedger(): { dir: string; ledger: Ledger } {
  const dir = tempDir();
  dirs.push(dir);
  const ledger = openLedger(join(dir, "hydra.sqlite"));
  openLedgers.push(ledger);
  return { dir, ledger };
}

function makeTrade(realized: number, retBps = 10, i = 1): Trade {
  return {
    engine: "liqfade",
    venue: "futures",
    symbol: "BTCUSDT",
    openedNs: i,
    closedNs: i + 1000,
    qty: 0.05,
    entry: 60000,
    exit: 60100,
    realized,
    fees: 0.02,
    retBps,
  };
}

function makeFill(tradeId: string): Fill {
  return {
    orderId: 1,
    venue: "futures",
    symbol: "BTCUSDT",
    tradeId,
    side: "BUY",
    price: 60000,
    qty: 0.05,
    fee: 0.02,
    feeAsset: "USDT",
    tsNs: 1,
  };
}

describe("Dream Runtime Truthful Ledger Audit", () => {
  test("empty ledger: returns truthful 0 counts, no invented lessons, empty narrative", () => {
    const { dir, ledger } = freshLedger();
    const memoryPath = join(dir, "dream-memory.json");
    const bus = new Bus();
    const events: DreamCycleEvent[] = [];
    bus.on("dream.cycle", (e) => events.push(e));

    const result = executeDreamCycle(memoryPath, bus, ledger);

    expect(result.tradesReviewed).toBe(0);
    expect(result.lossTradesCount).toBe(0);
    expect(result.vetoCount).toBe(0);
    expect(result.lessonsDistilled).toEqual([]);
    expect(result.parameterAdjustments).toEqual([]);
    expect(result.status).toBe("empty");

    const store = loadDreamMemory(memoryPath);
    expect(store.totalCycles).toBe(1);
    expect(store.history.length).toBe(1);
    expect(store.lessons).toEqual([]);

    expect(events.length).toBe(1);
    expect(events[0]?.tradesReviewed).toBe(0);
    expect(events[0]?.lossTradesCount).toBe(0);
    expect(events[0]?.vetoCount).toBe(0);
    expect(events[0]?.newLessonTitle).toBe("");
  });

  test("known counts: aggregates real trades, fills, losses, and vetoes from ledger", () => {
    const { dir, ledger } = freshLedger();
    const memoryPath = join(dir, "dream-memory.json");
    const bus = new Bus();
    const events: DreamCycleEvent[] = [];
    bus.on("dream.cycle", (e) => events.push(e));

    // 5 trades: 3 wins (realized > 0), 2 losses (realized < 0)
    ledger.insertTrade(makeTrade(15.5, 25, 1));
    ledger.insertTrade(makeTrade(-8.2, -15, 2));
    ledger.insertTrade(makeTrade(4.0, 10, 3));
    ledger.insertTrade(makeTrade(-12.0, -20, 4));
    ledger.insertTrade(makeTrade(20.0, 30, 5));

    // 3 fills
    ledger.insertFill(makeFill("f-1"));
    ledger.insertFill(makeFill("f-2"));
    ledger.insertFill(makeFill("f-3"));

    // 2 vetoes
    ledger.insertVeto({ intentId: "v-1", engine: "liqfade", rule: 1, detail: "spread exceeded", tsNs: 1 });
    ledger.insertVeto({ intentId: "v-2", engine: "basis", rule: 2, detail: "adverse funding", tsNs: 2 });

    const result = executeDreamCycle(memoryPath, bus, ledger);

    expect(result.tradesReviewed).toBe(5);
    expect(result.fillsCount).toBe(3);
    expect(result.lossTradesCount).toBe(2);
    expect(result.vetoCount).toBe(2);
    expect(result.lessonsDistilled).toEqual([]);
    expect(result.parameterAdjustments).toEqual([]);
    expect(result.status).toBe("completed");

    expect(events.length).toBe(1);
    expect(events[0]?.tradesReviewed).toBe(5);
    expect(events[0]?.lossTradesCount).toBe(2);
    expect(events[0]?.vetoCount).toBe(2);
    expect(events[0]?.newLessonTitle).toBe("");
  });

  test("legacy exclusion and quarantine: unversioned synthetic memory safely migrated", () => {
    const dir = tempDir();
    dirs.push(dir);
    const memoryPath = join(dir, "dream-memory.json");

    // Seed unversioned legacy file with synthetic lessons and synthetic history
    const legacyData = {
      updatedAt: Date.now() - 10000,
      totalCycles: 3,
      lessons: [
        {
          id: "lesson-01",
          timestamp: Date.now() - 86400000,
          category: "anti-loss",
          title: "Synthetic Rule 1",
          trigger: "Fake trigger",
          counterfactual: "Fake counterfactual",
          invariantRule: "Never trade",
          confidence: 0.99,
          appliedToAgents: ["commander"],
        },
      ],
      history: [
        {
          timestamp: Date.now() - 86400000,
          tradesReviewed: 1482,
          lossTradesCount: 12,
          vetoCount: 3,
          lessonsDistilled: [],
          parameterAdjustments: [],
          narrative: "Fake cycle",
        },
      ],
    };
    writeFileSync(memoryPath, JSON.stringify(legacyData, null, 2), "utf-8");

    // Load must trigger safe migration
    const store = loadDreamMemory(memoryPath);

    // 1. Original file preserved in quarantine backup
    const quarantinePath = `${memoryPath}.quarantine`;
    expect(existsSync(quarantinePath)).toBe(true);
    const quarantineContent = readFileSync(quarantinePath, "utf-8");
    expect(JSON.parse(quarantineContent)).toEqual(legacyData);

    // 2. Store upgraded to versioned schema
    expect(store.version).toBe(DREAM_SCHEMA_VERSION);
    expect(store.quarantineBackupPath).toBe(quarantinePath);

    // 3. Synthetic lessons excluded from active memory / API
    expect(store.lessons).toEqual([]);

    // 4. Synthetic history excluded from active history
    expect(store.history).toEqual([]);
    expect(store.totalCycles).toBe(0);

    // 6. formatDreamMemoryPrompt strictly excludes synthetic/unverified lessons
    expect(formatDreamMemoryPrompt(store.lessons)).toBe("");
    expect(formatDreamMemoryPrompt(store.unverifiedLessons ?? [])).toBe("");
    expect(
      formatDreamMemoryPrompt([
        {
          id: "lesson-fake",
          timestamp: Date.now(),
          category: "risk-management",
          title: "Invented rule",
          trigger: "none",
          counterfactual: "none",
          invariantRule: "invented",
          confidence: 0.95,
          appliedToAgents: [],
          verified: false,
          source: "synthetic",
        },
      ]),
    ).toBe("");
  });

  test("corrupt json quarantine: unparseable files preserved in quarantine backup", () => {
    const dir = tempDir();
    dirs.push(dir);
    const memoryPath = join(dir, "dream-memory.json");
    const corruptedContent = "CORRUPT JSON CONTENT {{not json}}";
    writeFileSync(memoryPath, corruptedContent, "utf-8");

    const store = loadDreamMemory(memoryPath);
    const quarantinePath = `${memoryPath}.quarantine`;

    expect(existsSync(quarantinePath)).toBe(true);
    expect(readFileSync(quarantinePath, "utf-8")).toBe(corruptedContent);
    expect(store.version).toBe(DREAM_SCHEMA_VERSION);
    expect(store.totalCycles).toBe(0);
    expect(store.lessons).toEqual([]);
    expect(store.history).toEqual([]);
  });

  test("skip execution: missing ledger cannot claim completed review", () => {
    const dir = tempDir();
    dirs.push(dir);
    const memoryPath = join(dir, "dream-memory.json");
    const bus = new Bus();
    let eventEmitted = false;
    bus.on("dream.cycle", () => {
      eventEmitted = true;
    });

    // Execute with no ledger provided
    const result = executeDreamCycle(memoryPath, bus, undefined);

    expect(result.status).toBe("skipped");
    expect(result.tradesReviewed).toBe(0);
    expect(result.lossTradesCount).toBe(0);
    expect(result.vetoCount).toBe(0);
    expect(result.lessonsDistilled).toEqual([]);
    expect(result.parameterAdjustments).toEqual([]);

    // Store must NOT record a completed review
    const store = loadDreamMemory(memoryPath);
    expect(store.totalCycles).toBe(0);
    expect(store.history.length).toBe(0);

    // No bus event emitted
    expect(eventEmitted).toBe(false);
  });
});
