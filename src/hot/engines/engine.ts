// Engine SDK. An engine is a small deterministic state machine: the registry feeds it bus events
// it subscribed to plus a 250 ms tick; it reads FeedHub state synchronously and emits Intents
// through `emitIntent`, which stamps id/engine/tSignalNs/paper, applies the per-symbol cooldown
// and tracks the open position for time-stop (and paper TP/SL, which the executor does not place).
// Params come from engines.yaml validated by ENGINE_PARAM_SCHEMAS; the bounds are exported so the
// Commander/Coach tools can refuse out-of-range writes before they reach the file.

import { z } from "zod";
import type { Bus, EventName, HydraEvents } from "../../core/bus.ts";
import type { RiskConfig } from "../../core/config.ts";
import type { Ledger } from "../../core/ledger.ts";
import { logger } from "../../core/log.ts";
import type { EngineConfig, EngineId, Intent, Mode, OpportunityContract, Side, Venue } from "../../core/types.ts";
import type { SkillsHttp } from "../../venues/onchain/skills-http.ts";
import type { KlineCandle } from "../../venues/binance/rest-futures.ts";
import type { AuditCache } from "../audit-cache.ts";
import type { SubmitResult } from "../executor.ts";
import type { FeedHub } from "../feed-hub.ts";

const log = logger("engine");

export type EngineFeed = Pick<FeedHub, "book" | "mark" | "burst" | "gapBps" | "vwap1m" | "adv" | "spotTopOfBook" | "referenceMid"> & {
  klines?(symbol: string): readonly KlineCandle[];
};

export interface EngineCtx {
  feed: EngineFeed;
  submit(intent: Intent): Promise<SubmitResult>;
  skills: SkillsHttp | null;
  audit: AuditCache;
  ledger: Ledger;
  bus: Bus;
  nowNs(): number;
  wallMs(): number;
  mode: Mode;
  risk: RiskConfig;
}

// ---- params ---------------------------------------------------------------

const n = (min: number, max: number, def: number) => z.number().min(min).max(max).default(def);

export const ENGINE_PARAM_SCHEMAS = {
  liqfade: z.object({
    windowMs: n(1000, 5000, 3000),
    minSnapshots: n(2, 5, 2),
    minSampleUsd: n(5e4, 1e6, 2e5),
    minGapBps: n(2, 30, 8),
    minBurstRatio: n(1, 10, 3),
    minDispBps: n(10, 100, 40),
    tpBps: n(10, 100, 35),
    slBps: n(10, 100, 25),
    maxHoldMs: n(3e4, 3e5, 1.2e5),
    chaseMs: n(100, 2000, 400),
    allowMarket: z.boolean().default(true),
  }),
  basis: z.object({
    lookbackSec: n(60, 900, 300),
    zEntry: n(1, 4, 2),
    zExit: n(0, 1, 0.5),
    maxHoldMs: n(3e4, 3e5, 1.2e5),
  }),
  smmirror: z.object({
    minScore: n(50, 100, 80),
    slipBps: n(0, 50, 10),
    tpBps: n(10, 100, 40),
    slBps: n(10, 100, 30),
    exitOnSellPct: n(10, 100, 40),
    maxTokenAgeSec: n(60, 86_400, 3600),
  }),
  cexdex: z.object({
    minEdgeBps: n(5, 100, 25),
  }),
  convert: z.object({
    minEdgeBps: n(5, 100, 20),
    pollMs: n(1000, 60_000, 5000),
  }),
  tokstock: z.object({
    devBps: n(20, 200, 60),
  }),
  swing: z.object({
    mode: n(0, 2, 0),
    timeframeSec: n(60, 3600, 900),
    lookbackCandles: n(3, 30, 8),
    fastEma: n(5, 50, 20),
    slowEma: n(20, 200, 50),
    rsiThreshold: n(20, 45, 30),
    slAtr: n(0.5, 4.0, 1.5),
    tpAtr: n(1.0, 8.0, 3.0),
    maxHoldMs: n(60_000, 28_800_000, 7_200_000),
  }),
} satisfies Record<EngineId, z.ZodObject<z.ZodRawShape>>;

export type EngineParamSchemas = typeof ENGINE_PARAM_SCHEMAS;
export type ParamsOf<E extends EngineId> = z.infer<EngineParamSchemas[E]>;

export interface ParamBound {
  min: number;
  max: number;
  default: number;
}

function boundsOf(schema: z.ZodObject<z.ZodRawShape>): Record<string, ParamBound> {
  const out: Record<string, ParamBound> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    if (!(field instanceof z.ZodDefault)) continue;
    const inner = field.def.innerType;
    if (!(inner instanceof z.ZodNumber)) continue;
    let min = Number.NEGATIVE_INFINITY;
    let max = Number.POSITIVE_INFINITY;
    for (const check of inner.def.checks ?? []) {
      const d = (check as { _zod: { def: { check: string; value?: number; inclusive?: boolean } } })._zod.def;
      if (d.check === "greater_than" && typeof d.value === "number") min = d.value;
      else if (d.check === "less_than" && typeof d.value === "number") max = d.value;
    }
    out[key] = { min, max, default: field.def.defaultValue as number };
  }
  return out;
}

/** Numeric params only (booleans such as liqfade.allowMarket are not bounded). */
export const ENGINE_PARAM_BOUNDS: Record<EngineId, Record<string, ParamBound>> = {
  liqfade: boundsOf(ENGINE_PARAM_SCHEMAS.liqfade),
  basis: boundsOf(ENGINE_PARAM_SCHEMAS.basis),
  smmirror: boundsOf(ENGINE_PARAM_SCHEMAS.smmirror),
  cexdex: boundsOf(ENGINE_PARAM_SCHEMAS.cexdex),
  convert: boundsOf(ENGINE_PARAM_SCHEMAS.convert),
  tokstock: boundsOf(ENGINE_PARAM_SCHEMAS.tokstock),
  swing: boundsOf(ENGINE_PARAM_SCHEMAS.swing),
};

export function defaultParams(engine: EngineId): Record<string, number | boolean> {
  return ENGINE_PARAM_SCHEMAS[engine].parse({}) as Record<string, number | boolean>;
}

/** Validates `raw` against the engine's schema (defaults filled); throws ZodError. */
export function parseParams<E extends EngineId>(engine: E, raw: unknown): ParamsOf<E> {
  return ENGINE_PARAM_SCHEMAS[engine].parse(raw ?? {}) as ParamsOf<E>;
}

/** Venue whose `allowed_symbols` list constrains each engine's `symbols`. */
export const ENGINE_VENUE: Record<EngineId, Venue> = {
  liqfade: "futures",
  basis: "futures",
  convert: "spot",
  smmirror: "dex",
  cexdex: "spot",
  tokstock: "dex",
  swing: "futures",
};
// ---- base class -----------------------------------------------------------

export type IntentDraft = Pick<Intent, "venue" | "symbol" | "side" | "qty" | "type"> &
  Partial<Pick<Intent, "price" | "tp" | "sl" | "ttlMs" | "paper" | "legs" | "tSignalNs">> & {
    /** Seconds the symbol stays quiet after this intent; default `Engine.cooldownMs`. */
    cooldownMs?: number;
    /** Time stop in ms; default `params.maxHoldMs` when present, else none. */
    maxHoldMs?: number;
    /** Reduce intents (exits) are never tracked/cooled down. */
    reduce?: boolean;
  };

export interface OpenIntent {
  intent: Intent;
  openedNs: number;
  maxHoldMs: number;
}

let seq = 0;

export abstract class Engine<P extends object> {
  abstract readonly id: EngineId;
  abstract readonly subscribes: readonly EventName[];
  enabled = false;
  protected symbols: string[] = [];
  protected sizeUsd = 0;
  protected paper = true;
  protected params!: P;
  /** Default per-symbol quiet period after an entry; engines override (liqfade uses windowMs*2). */
  protected cooldownMs = 5000;
  protected readonly cooldownUntilNs = new Map<string, number>();
  protected readonly open = new Map<string, OpenIntent>();
  private intents = 0;
  private rejected = 0;
  private exits = 0;

  constructor(protected readonly ctx: EngineCtx) {}

  configure(cfg: EngineConfig & { params: P }): void {
    this.enabled = cfg.enabled;
    this.symbols = cfg.symbols.slice();
    this.sizeUsd = cfg.sizeUsd;
    this.paper = cfg.paper;
    this.params = cfg.params;
    this.onConfigure();
  }

  /** Hook after configure(); engines reset per-symbol state here. */
  protected onConfigure(): void {}

  abstract onEvent<K extends EventName>(name: K, payload: HydraEvents[K]): void;

  /** Registry tick (250 ms): time stops and paper TP/SL. Engines calling super keep both. */
  onTick(nowNs: number): void {
    for (const [id, o] of this.open) {
      const i = o.intent;
      if (o.maxHoldMs > 0 && nowNs - o.openedNs >= o.maxHoldMs * 1e6) {
        void this.close(id, "time_stop", nowNs);
        continue;
      }
      if (!i.paper || (i.tp === undefined && i.sl === undefined)) continue;
      const px = this.markOf(i.venue, i.symbol);
      if (px <= 0) continue;
      const up = i.side === "BUY";
      if ((i.tp !== undefined && (up ? px >= i.tp : px <= i.tp)) || (i.sl !== undefined && (up ? px <= i.sl : px >= i.sl))) {
        void this.close(id, "paper_tp_sl", nowNs);
      }
    }
  }

  contract(): OpportunityContract | null {
    return null;
  }

  stats(): Record<string, number> {
    return { intents: this.intents, rejected: this.rejected, exits: this.exits, open: this.open.size };
  }

  hasOpen(symbol: string): boolean {
    for (const o of this.open.values()) if (o.intent.symbol === symbol) return true;
    return false;
  }

  protected inCooldown(symbol: string, nowNs: number): boolean {
    const until = this.cooldownUntilNs.get(symbol);
    return until !== undefined && nowNs < until;
  }

  protected markOf(venue: Venue, symbol: string): number {
    if (venue === "futures") return this.ctx.feed.mark(symbol)?.mark ?? this.ctx.feed.book(symbol)?.mid ?? 0;
    if (venue === "spot") {
      const t = this.ctx.feed.spotTopOfBook(symbol);
      return t === null ? 0 : (t.bid + t.ask) / 2;
    }
    return 0;
  }

  /**
   * Stamps id/engine/paper/tSignalNs (frame receipt passed by the caller, else now), emits
   * `engine.intent` on the bus, then submits to the executor kernel.  The bus emit comes first
   * so listeners (scenario harness, dashboard) observe the intent even when submit is
   * synchronous.  No duplicate submission: the intent is constructed once and passed to both.
   */
  protected async emitIntent(draft: IntentDraft): Promise<SubmitResult> {
    const tSignalNs = draft.tSignalNs ?? this.ctx.nowNs();
    const intent: Intent = {
      id: `${this.id}-${(++seq).toString(36)}-${tSignalNs.toString(36)}`,
      engine: this.id,
      venue: draft.venue,
      symbol: draft.symbol,
      side: draft.side,
      qty: draft.qty,
      type: draft.type,
      ttlMs: draft.ttlMs ?? 5000,
      paper: draft.paper ?? this.paper,
      tSignalNs,
    };
    if (draft.price !== undefined) intent.price = draft.price;
    if (draft.tp !== undefined) intent.tp = draft.tp;
    if (draft.sl !== undefined) intent.sl = draft.sl;
    if (draft.legs !== undefined) intent.legs = draft.legs.map((l) => ({ ...l, engine: this.id, paper: l.paper ?? intent.paper, tSignalNs }));
    if (draft.reduce !== true) this.cooldownUntilNs.set(intent.symbol, tSignalNs + (draft.cooldownMs ?? this.cooldownMs) * 1e6);
    this.intents++;
    // Publish the intent on the bus BEFORE submit so listeners (scenario harness, dashboard)
    // see it even when the executor is synchronous. submit() is still called regardless.
    this.ctx.bus.emit("engine.intent", intent);
    const res = await this.ctx.submit(intent);
    if (!res.ok) {
      this.rejected++;
      log.warn("intent rejected", { engine: this.id, intent: intent.id, reason: res.reason, detail: res.reason === "veto" ? res.veto.detail : res.error });
      return res;
    }
    if (draft.reduce !== true) {
      const hold = draft.maxHoldMs ?? (this.params as { maxHoldMs?: number }).maxHoldMs ?? 0;
      this.open.set(intent.id, { intent, openedNs: tSignalNs, maxHoldMs: hold });
    }
    return res;
  }

  /** Closes a tracked position with a reduce intent (opposite side MARKET, every leg). */
  protected async close(id: string, reason: string, nowNs: number = this.ctx.nowNs()): Promise<void> {
    const o = this.open.get(id);
    if (o === undefined) return;
    this.open.delete(id);
    this.exits++;
    const i = o.intent;
    const flip = (x: Intent): Intent => ({
      id: `${x.id}-x`,
      engine: this.id,
      venue: x.venue,
      symbol: x.symbol,
      side: opposite(x.side),
      qty: x.qty,
      type: "MARKET",
      ttlMs: x.ttlMs,
      paper: x.paper,
      tSignalNs: nowNs,
    });
    const legs = i.legs !== undefined && i.legs.length > 0 ? i.legs.map(flip) : undefined;
    const exit: Intent = flip(i);
    if (legs !== undefined) exit.legs = legs;
    log.info("closing", { engine: this.id, intent: i.id, reason });
    const res = await this.ctx.submit(exit);
    if (!res.ok) log.error("close failed", { engine: this.id, intent: i.id, reason, detail: res.reason === "veto" ? res.veto.detail : res.error });
  }

  protected contractOf(symbol: string, side: Side, venue: Venue, edgeBps: number, confidence: number, ttlMs: number, meta?: Record<string, unknown>): OpportunityContract {
    const c: OpportunityContract = { engine: this.id, venue, symbol, side, edgeBps, confidence, sizeUsd: this.sizeUsd, ttlMs, tsNs: this.ctx.nowNs() };
    if (meta !== undefined) c.meta = meta;
    return c;
  }
}

export function opposite(side: Side): Side {
  return side === "BUY" ? "SELL" : "BUY";
}
