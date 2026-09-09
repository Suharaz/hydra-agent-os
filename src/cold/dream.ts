// Dream Coin — 24-Hour Nightly Ledger Audit & Evidence-Backed Review
// Each night at 00:00 UTC (or triggered on demand), the system reviews all filled,
// lost, and vetoed trades across the last 24h from the authentic ledger.
// Fabricated/synthetic lessons, counterfactual profits, and imaginary parameter
// adjustments are strictly eliminated. Truthful ledger counts only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { Ledger, LedgerReader } from "../core/ledger.ts";
import { logger } from "../core/log.ts";
import type { DreamCycleEvent } from "../core/types.ts";

const log = logger("dream");

export const DREAM_SCHEMA_VERSION = 2;
export const DEFAULT_MEMORY_PATH = "state/dream-memory.json";

export type LessonCategory = "anti-loss" | "risk-management" | "fee-optimization" | "execution";

export interface DreamLessonProvenance {
  source: "ledger" | "synthetic" | "manual";
  evidenceCount?: number;
  reviewedAt?: number;
  [key: string]: unknown;
}

export interface DreamLesson {
  id: string;
  timestamp: number;
  category: LessonCategory;
  title: string;
  trigger: string;
  counterfactual: string;
  invariantRule: string;
  confidence: number;
  appliedToAgents: string[];
  verified?: boolean;
  source?: "ledger" | "synthetic" | "manual";
  provenance?: DreamLessonProvenance;
}

export interface DreamParameterAdjustment {
  engine: string;
  param: string;
  from: number | string;
  to: number | string;
  reason: string;
}

export interface DreamCycleResult {
  timestamp: number;
  tradesReviewed: number;
  lossTradesCount: number;
  vetoCount: number;
  fillsCount?: number;
  lessonsDistilled: DreamLesson[];
  parameterAdjustments: DreamParameterAdjustment[];
  narrative: string;
  status?: "completed" | "skipped" | "empty";
}
export interface DreamMemoryStore {
  version: number;
  updatedAt: number;
  totalCycles: number;
  lessons: DreamLesson[];
  history: DreamCycleResult[];
  unverifiedLessons?: DreamLesson[];
  unverifiedHistory?: DreamCycleResult[];
  quarantineBackupPath?: string;
}


/**
 * Shape validation for loaded dream memory stores.
 */
function isValidStoreShape(parsed: unknown): parsed is Partial<DreamMemoryStore> {
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}

function verifiedLesson(value: unknown): value is DreamLesson {
  if (typeof value !== "object" || value === null) return false;
  const l = value as DreamLesson;
  return l.verified === true && l.source === "ledger"
    && ["anti-loss", "risk-management", "fee-optimization", "execution"].includes(l.category)
    && [l.id, l.title, l.trigger, l.counterfactual, l.invariantRule].every(v => typeof v === "string")
    && Number.isFinite(l.timestamp) && Number.isFinite(l.confidence)
    && l.confidence >= 0 && l.confidence <= 1
    && Array.isArray(l.appliedToAgents) && l.appliedToAgents.every(v => typeof v === "string");
}

/**
 * Safely loads Dream Memory. If synthetic or unversioned memory is encountered,
 * it is migrated: original file preserved in a quarantine backup, legacy lessons
 * marked as unverified and excluded from active memory / prompts / API.
 */
export function loadDreamMemory(filePath: string = DEFAULT_MEMORY_PATH): DreamMemoryStore {
  if (!existsSync(filePath)) return createFreshStore(filePath);
  // I/O errors must not be mistaken for malformed JSON or overwrite an unreadable file.
  const raw = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (isValidStoreShape(parsed) && typeof parsed.version === "number" && parsed.version > DREAM_SCHEMA_VERSION) {
    throw new Error("unsupported future dream memory version");
  }
  const current = isValidStoreShape(parsed) && parsed.version === DREAM_SCHEMA_VERSION
    && Number.isSafeInteger(parsed.totalCycles) && (parsed.totalCycles ?? -1) >= 0
    && Number.isFinite(parsed.updatedAt)
    && Array.isArray(parsed.lessons) && parsed.lessons.every(verifiedLesson)
    && Array.isArray(parsed.history) && parsed.history.every(h =>
      h && Number.isFinite(h.timestamp) && ["empty", "completed"].includes(h.status ?? "")
      && [h.tradesReviewed, h.lossTradesCount, h.vetoCount, h.fillsCount ?? 0].every(n => Number.isSafeInteger(n) && n >= 0)
      && typeof h.narrative === "string" && Array.isArray(h.lessonsDistilled)
      && h.lessonsDistilled.every(verifiedLesson) && Array.isArray(h.parameterAdjustments) && h.parameterAdjustments.length === 0);
  if (current) return parsed as DreamMemoryStore;
  // Preserve the exact legacy bytes before replacing any active state. Historical
  // synthetic counters are not carried into the verified cycle count.
  const quarantineBackupPath = quarantineFile(filePath, raw);
  const store = createFreshStore(filePath);
  store.quarantineBackupPath = quarantineBackupPath;
  saveDreamMemory(store, filePath);
  return store;
}

function quarantineFile(filePath: string, content: string): string {
  const base = `${filePath}.quarantine`;
  const quarantinePath = existsSync(base) ? `${base}.${crypto.randomUUID()}` : base;
  mkdirSync(dirname(quarantinePath), { recursive: true });
  writeFileSync(quarantinePath, content, { encoding: "utf-8", flag: "wx" });
  return quarantinePath;
}

function createFreshStore(filePath: string): DreamMemoryStore {
  const initialStore: DreamMemoryStore = {
    version: DREAM_SCHEMA_VERSION,
    updatedAt: Date.now(),
    totalCycles: 0,
    lessons: [],
    history: [],
    unverifiedLessons: [],
  };
  saveDreamMemory(initialStore, filePath);
  return initialStore;
}

export function saveDreamMemory(store: DreamMemoryStore, filePath: string = DEFAULT_MEMORY_PATH): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Formats distilled lessons into an advisory prompt for LLM agents.
 * Strictly excludes unverified and synthetic lessons.
 * Never injects synthetic lessons as mandatory trading rules.
 */
export function formatDreamMemoryPrompt(lessons: DreamLesson[]): string {
  if (!Array.isArray(lessons) || lessons.length === 0) return "";

  // Strictly filter to verified ledger-backed lessons
  const verified = lessons.filter(verifiedLesson);

  if (verified.length === 0) return "";

  const lines = verified.slice(0, 10).map((l, idx) => {
    return `${idx + 1}. [${l.category.toUpperCase()}] ${l.title}\n   - Advisory Rule: ${l.invariantRule}`;
  });

  return `\n## LEDGER OBSERVATIONS & RISK ADVISORIES (DREAM COIN)\nThese advisories reflect empirical ledger observations. They are non-mandatory risk guidelines:\n${lines.join("\n")}\n`;
}

/**
 * Runs a truthful 24h Dream Reflection Cycle reviewing trades, fills, and vetoes
 * from the authentic SQLite ledger.
 *
 * Missing ledger CANNOT claim completed review: returns skipped status without
 * incrementing cycles or recording history.
 */
export function executeDreamCycle(
  filePath: string = DEFAULT_MEMORY_PATH,
  bus?: Bus,
  ledger?: Ledger | LedgerReader,
): DreamCycleResult {
  const now = Date.now();

  // Missing ledger cannot claim completed review
  if (!ledger) {
    log.warn("dream cycle skipped: missing ledger cannot claim completed review");
    return {
      timestamp: now,
      tradesReviewed: 0,
      lossTradesCount: 0,
      vetoCount: 0,
      fillsCount: 0,
      lessonsDistilled: [],
      parameterAdjustments: [],
      narrative: "Dream cycle skipped: missing ledger cannot claim completed review.",
      status: "skipped",
    };
  }
  const db = ledger.db;
  const store = loadDreamMemory(filePath);
  const windowMs = 86_400_000;
  const sinceMs = now - windowMs;

  const tradeStats = db
    .query<{ totalTrades: number; lossTrades: number }, [number]>(
      `SELECT
         COUNT(*) AS totalTrades,
         COALESCE(SUM(CASE WHEN realized - fees < 0 THEN 1 ELSE 0 END), 0) AS lossTrades
       FROM trades WHERE ts_wall >= ?`,
    )
    .get(sinceMs) ?? { totalTrades: 0, lossTrades: 0 };

  const fillStats = db
    .query<{ totalFills: number }, [number]>("SELECT COUNT(*) AS totalFills FROM fills WHERE ts_wall >= ?")
    .get(sinceMs) ?? { totalFills: 0 };

  const vetoStats = db
    .query<{ totalVetoes: number }, [number]>("SELECT COUNT(*) AS totalVetoes FROM vetoes WHERE ts_wall >= ?")
    .get(sinceMs) ?? { totalVetoes: 0 };

  const tradesReviewed = tradeStats.totalTrades;
  const fillsCount = fillStats.totalFills;
  const lossTradesCount = tradeStats.lossTrades;
  const vetoCount = vetoStats.totalVetoes;

  // No invented lessons, confidence, counterfactual profits, or parameter changes
  const lessonsDistilled: DreamLesson[] = [];
  const parameterAdjustments: DreamParameterAdjustment[] = [];

  const narrative =
    tradesReviewed === 0 && fillsCount === 0 && vetoCount === 0
      ? "Dream 24h review complete: 0 trades reviewed, 0 fills, 0 losses, 0 risk vetoes. Empty review: no evidence to analyze."
      : `Dream 24h review complete: ${tradesReviewed} trades reviewed (${fillsCount} fills), ${lossTradesCount} losses, ${vetoCount} risk vetoes across past 24h. No automated parameter adjustments without verified policy evidence.`;

  const result: DreamCycleResult = {
    timestamp: now,
    tradesReviewed,
    lossTradesCount,
    vetoCount,
    fillsCount,
    lessonsDistilled,
    parameterAdjustments,
    narrative,
    status: tradesReviewed === 0 && fillsCount === 0 && vetoCount === 0 ? "empty" : "completed",
  };

  store.history.unshift(result);
  store.totalCycles += 1;
  store.updatedAt = now;

  saveDreamMemory(store, filePath);
  log.info("dream cycle completed", {
    tradesReviewed,
    lossTradesCount,
    vetoCount,
    fillsCount,
    totalCycles: store.totalCycles,
  });

  const eventPayload: DreamCycleEvent = {
    timestamp: now,
    tradesReviewed,
    lossTradesCount,
    vetoCount,
    newLessonTitle: "",
    narrative,
  };

  bus?.emit("dream.cycle", eventPayload);
  if (ledger && typeof (ledger as { event?: unknown }).event === "function") {
    (ledger as { event: (kind: string, json?: string | null) => void }).event("dream.cycle", JSON.stringify(eventPayload));
  }

  return result;
}

export interface DreamSchedulerOptions {
  filePath?: string;
  bus?: Bus;
  ledger?: Ledger | LedgerReader;
  /** Check interval in ms (default: 30,000 ms) */
  intervalMs?: number;
}

export interface AutonomousDreamScheduler {
  stop: () => void;
  runNow: () => DreamCycleResult;
  lastRunDay: () => string;
}

export function startAutonomousDreamScheduler(opts: DreamSchedulerOptions = {}): AutonomousDreamScheduler {
  const filePath = opts.filePath ?? DEFAULT_MEMORY_PATH;
  const intervalMs = opts.intervalMs ?? 30_000;
  let lastDay = new Date().toISOString().slice(0, 10);
  let timer: NodeJS.Timeout | number | null = null;

  const tick = () => {
    const currentDay = new Date().toISOString().slice(0, 10);
    const utcHours = new Date().getUTCHours();
    const utcMinutes = new Date().getUTCMinutes();

    // Trigger when date changes or at 00:00 UTC
    if (currentDay !== lastDay && (utcHours === 0 || utcMinutes === 0)) {
      log.info("autonomous 00:00 UTC dream cycle triggered", { day: currentDay, prevDay: lastDay });
      lastDay = currentDay;
      try {
        executeDreamCycle(filePath, opts.bus, opts.ledger);
      } catch (err) {
        log.error("autonomous dream cycle failed", { error: String(err) });
      }
    }
  };

  timer = setInterval(tick, intervalMs);
  log.info("autonomous dream scheduler started", { intervalMs, currentDay: lastDay });

  return {
    stop: () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
        log.info("autonomous dream scheduler stopped");
      }
    },
    runNow: () => {
      lastDay = new Date().toISOString().slice(0, 10);
      return executeDreamCycle(filePath, opts.bus, opts.ledger);
    },
    lastRunDay: () => lastDay,
  };
}
