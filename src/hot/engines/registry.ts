// EngineRegistry: owns the six engines, fans bus events out to the ones that subscribed (one
// bus listener per event name, never one per engine), drives the 250 ms tick, publishes changed
// OpportunityContracts, and applies engines.yaml. `apply` validates each engine independently:
// symbols outside risk.allowed_symbols[venue] or params outside the zod bounds reject that engine
// only and keep its previous configuration. `createEnginesModule` wires it into the boot order
// and hot-reloads through `watchEngines`.

import { ZodError } from "zod";
import { type Bus, bus as globalBus, type EventName, type HydraEvents } from "../../core/bus.ts";
import { nowNs as monoNs, wallMs as wallNow } from "../../core/clock.ts";
import { type Config, type EnginesConfig, watchEngines } from "../../core/config.ts";
import type { Env } from "../../core/env.ts";
import type { Ledger } from "../../core/ledger.ts";
import { logger } from "../../core/log.ts";
import { ENGINE_IDS, type EngineId, type Intent, type OpportunityContract } from "../../core/types.ts";
import type { Module } from "../../main.ts";
import type { SkillsHttp } from "../../venues/onchain/skills-http.ts";
import type { AuditCache } from "../audit-cache.ts";
import type { SubmitResult } from "../executor.ts";
import { BasisEngine } from "./basis.ts";
import { CexdexEngine } from "./cexdex.ts";
import { ConvertEngine } from "./convert.ts";
import { ENGINE_VENUE, Engine, type EngineCtx, type EngineFeed, parseParams } from "./engine.ts";
import { LiqfadeEngine } from "./liqfade.ts";
import { SmmirrorEngine } from "./smmirror.ts";
import { TokstockEngine } from "./tokstock.ts";

const log = logger("engines");

export const TICK_MS = 250;

export type EngineFactory = (ctx: EngineCtx) => Engine<object>;
export type EngineFactories = Partial<Record<EngineId, EngineFactory>>;

export const DEFAULT_FACTORIES: Record<EngineId, EngineFactory> = {
  liqfade: (ctx) => new LiqfadeEngine(ctx),
  basis: (ctx) => new BasisEngine(ctx),
  convert: (ctx) => new ConvertEngine(ctx),
  smmirror: (ctx) => new SmmirrorEngine(ctx),
  cexdex: (ctx) => new CexdexEngine(ctx),
  tokstock: (ctx) => new TokstockEngine(ctx),
};

export interface ApplyResult {
  applied: EngineId[];
  rejected: Array<{ engine: EngineId; reason: string }>;
}

export class EngineRegistry {
  private readonly map = new Map<EngineId, Engine<object>>();
  private readonly byEvent = new Map<EventName, Engine<object>[]>();
  private readonly offs: Array<() => void> = [];
  private readonly published = new Map<EngineId, OpportunityContract>();
  private timer: Timer | null = null;
  private readonly bus: Bus;

  constructor(
    private readonly ctx: EngineCtx,
    factories: EngineFactories = DEFAULT_FACTORIES,
  ) {
    this.bus = ctx.bus;
    for (const id of ENGINE_IDS) {
      const make = factories[id];
      if (make === undefined) continue;
      const engine = make(ctx);
      this.map.set(id, engine);
      for (const name of engine.subscribes) {
        const list = this.byEvent.get(name);
        if (list === undefined) this.byEvent.set(name, [engine]);
        else list.push(engine);
      }
    }
  }

  engines(): ReadonlyMap<EngineId, Engine<object>> {
    return this.map;
  }

  /** Reconfigures every engine present in `cfg`; a rejected engine keeps its previous config. */
  apply(cfg: EnginesConfig): ApplyResult {
    const out: ApplyResult = { applied: [], rejected: [] };
    const allowed = this.ctx.risk.allowed_symbols;
    for (const [id, engine] of this.map) {
      const c = cfg.engines[id];
      if (c === undefined) continue;
      const venueList = allowed[ENGINE_VENUE[id]];
      const outside = c.symbols.filter((s) => !venueList.includes(s));
      if (outside.length > 0) {
        const reason = `symbols not in allowed_symbols.${ENGINE_VENUE[id]}: ${outside.join(",")}`;
        out.rejected.push({ engine: id, reason });
        log.warn("engine config rejected; keeping previous", { engine: id, reason });
        continue;
      }
      let params: Record<string, unknown>;
      try {
        params = parseParams(id, c.params) as Record<string, unknown>; // zod output is the engine's typed params object
      } catch (err) {
        const reason = `params: ${err instanceof ZodError ? err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err)}`;
        out.rejected.push({ engine: id, reason });
        log.warn("engine config rejected; keeping previous", { engine: id, reason });
        continue;
      }
      engine.configure({ ...c, params });
      out.applied.push(id);
    }
    return out;
  }

  start(): void {
    if (this.timer !== null) return;
    for (const [name, engines] of this.byEvent) {
      this.offs.push(
        this.bus.on(name, (payload: HydraEvents[typeof name]) => {
          for (const e of engines) {
            if (!e.enabled) continue;
            try {
              e.onEvent(name, payload);
            } catch (err) {
              log.error("engine onEvent threw", { engine: e.id, event: name, error: err instanceof Error ? err.message : String(err) });
            }
          }
        }),
      );
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  /** One registry tick: time stops / paper TP-SL per enabled engine, then publish new contracts. */
  tick(nowNs: number = this.ctx.nowNs()): void {
    for (const e of this.map.values()) {
      if (!e.enabled) continue;
      try {
        e.onTick(nowNs);
      } catch (err) {
        log.error("engine onTick threw", { engine: e.id, error: err instanceof Error ? err.message : String(err) });
      }
      const c = e.contract();
      if (c === null || this.published.get(e.id) === c) continue;
      this.published.set(e.id, c);
      this.bus.emit("engine.contract", c);
      this.ctx.ledger.event("engine.contract", JSON.stringify(c));
    }
  }

  contracts(): OpportunityContract[] {
    const out: OpportunityContract[] = [];
    for (const e of this.map.values()) {
      const c = e.enabled ? e.contract() : null;
      if (c !== null) out.push(c);
    }
    return out;
  }

  stats(): Record<EngineId, Record<string, number>> {
    const out = {} as Record<EngineId, Record<string, number>>;
    for (const [id, e] of this.map) out[id] = e.stats();
    return out;
  }
}

// ---- module -----------------------------------------------------------------

export interface EnginesModuleContext {
  env: Env;
  config: Config;
  ledger: Ledger;
  stateDir: string;
  configDir: string;
  feed: EngineFeed;
  submit: (intent: Intent) => Promise<SubmitResult>;
  skills: SkillsHttp | null;
  audit: AuditCache;
  bus?: Bus;
}

export function createEnginesModule(ctx: EnginesModuleContext): Module & { registry: EngineRegistry } {
  const bus = ctx.bus ?? globalBus;
  const registry = new EngineRegistry({
    feed: ctx.feed,
    submit: ctx.submit,
    skills: ctx.skills,
    audit: ctx.audit,
    ledger: ctx.ledger,
    bus,
    nowNs: monoNs,
    wallMs: wallNow,
    mode: ctx.env.mode,
    risk: ctx.config.risk,
  });
  let unwatch: (() => void) | null = null;
  return {
    name: "engines",
    order: "engines",
    registry,
    start() {
      const r = registry.apply(ctx.config.engines);
      log.info("engines configured", { applied: r.applied, rejected: r.rejected });
      registry.start();
      unwatch = watchEngines(ctx.configDir, (cfg, hash) => {
        const res = registry.apply(cfg);
        log.info("engines.yaml reloaded", { hash, applied: res.applied, rejected: res.rejected });
      });
    },
    stop() {
      if (unwatch !== null) {
        unwatch();
        unwatch = null;
      }
      registry.stop();
    },
  };
}
