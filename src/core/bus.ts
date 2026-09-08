// Typed in-process event bus. Synchronous dispatch; listeners run in registration order.
// Adding an event = adding a key to `HydraEvents`; test/core/bus.test.ts greps src/** for undeclared names.

import type {
  AgentDecision,
  DepthEvent,
  DexQuote,
  DreamCycleEvent,
  Fill,
  GuardianBreach,
  Intent,
  KillEvent,
  KillFailedEvent,
  LiquidationEvent,
  LlmCreditsEvent,
  MarkEvent,
  OpportunityContract,
  Order,
  RollbackEvent,
  SmartMoneyEvent,
  ThrottleEvent,
  TradeTick,
  Veto,
} from "./types.ts";

export interface HydraEvents {
  "feed.depth": DepthEvent;
  "feed.trade": TradeTick;
  "feed.liq": LiquidationEvent;
  "feed.mark": MarkEvent;
  "feed.onchain.smartmoney": SmartMoneyEvent;
  "feed.dexquote": DexQuote;
  "engine.intent": Intent;
  "engine.contract": OpportunityContract;
  "kernel.veto": Veto;
  "exec.order": Order;
  "exec.fill": Fill;
  "exec.rollback": RollbackEvent;
  "guardian.breach": GuardianBreach;
  "system.kill": KillEvent;
  "system.kill.failed": KillFailedEvent;
  "system.kill.cleared": { actor: string; tsNs: number };
  "system.throttle": ThrottleEvent;
  "system.llm_credits": LlmCreditsEvent;
  "config.reload": { file: "engines" | "agents"; hash: string };
  "limits.reload": { hash: string };
  "budgets.reload": { hash: string };
  "agent.decision": AgentDecision;
  "dream.cycle": DreamCycleEvent;
}

export type EventName = keyof HydraEvents;
export type Listener<K extends EventName> = (payload: HydraEvents[K]) => void;

export const EVENT_NAMES: readonly EventName[] = [
  "feed.depth",
  "feed.trade",
  "feed.liq",
  "feed.mark",
  "feed.onchain.smartmoney",
  "feed.dexquote",
  "engine.intent",
  "engine.contract",
  "kernel.veto",
  "exec.order",
  "exec.fill",
  "exec.rollback",
  "guardian.breach",
  "system.kill",
  "system.kill.failed",
  "system.kill.cleared",
  "system.throttle",
  "system.llm_credits",
  "config.reload",
  "limits.reload",
  "budgets.reload",
  "agent.decision",
  "dream.cycle",
];

export class Bus {
  private readonly listeners = new Map<EventName, Listener<EventName>[]>();

  on<K extends EventName>(name: K, cb: Listener<K>): () => void {
    let list = this.listeners.get(name);
    if (list === undefined) {
      list = [];
      this.listeners.set(name, list);
    }
    list.push(cb as Listener<EventName>);
    return () => this.off(name, cb);
  }

  off<K extends EventName>(name: K, cb: Listener<K>): void {
    const list = this.listeners.get(name);
    if (list === undefined) return;
    const i = list.indexOf(cb as Listener<EventName>);
    if (i >= 0) list.splice(i, 1);
  }

  once<K extends EventName>(name: K, cb: Listener<K>): () => void {
    const wrapped: Listener<K> = (payload) => {
      this.off(name, wrapped);
      cb(payload);
    };
    return this.on(name, wrapped);
  }

  /**
   * Synchronous dispatch. Listener list is snapshotted by index so an `off` inside a
   * listener cannot skip a sibling; a listener that throws does not stop the others.
   */
  emit<K extends EventName>(name: K, payload: HydraEvents[K]): void {
    const list = this.listeners.get(name);
    if (list === undefined || list.length === 0) return;
    if (list.length === 1) {
      (list[0] as Listener<K>)(payload);
      return;
    }
    const snapshot = list.slice();
    let firstError: unknown;
    for (let i = 0; i < snapshot.length; i++) {
      try {
        (snapshot[i] as Listener<K>)(payload);
      } catch (err) {
        if (firstError === undefined) firstError = err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  listenerCount(name: EventName): number {
    return this.listeners.get(name)?.length ?? 0;
  }

  removeAll(name?: EventName): void {
    if (name === undefined) this.listeners.clear();
    else this.listeners.delete(name);
  }
}

/** Process-wide singleton. Tests may construct their own `new Bus()`. */
export const bus = new Bus();
