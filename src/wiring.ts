// Composes the process from module factories. Kept out of main.ts so `boot()` stays testable and
// CLI verbs can pick a subset. Start order: feed -> user-data -> executor (kernel, guardian,
// recovery-boot) -> engines -> agents + x402 seller. Shutdown is the reverse.

import type { Config } from "./core/config.ts";
import type { Env } from "./core/env.ts";
import type { Ledger } from "./core/ledger.ts";
import { logger } from "./core/log.ts";
import { createDashboard, type Dashboard } from "./dashboard/server.ts";
import { AuditCache } from "./hot/audit-cache.ts";
import { createExecutorModule, type ExecutorStack } from "./hot/executor.ts";
import { createEnginesModule, type EngineRegistry } from "./hot/engines/registry.ts";
import { createFeedModule, type FeedModule } from "./hot/feed-hub.ts";
import { createAgentsModule } from "./cold/scheduler.ts";
import type { Module } from "./main.ts";
import { startAutonomousDreamScheduler, type AutonomousDreamScheduler } from "./cold/dream.ts";
import { bus as globalBus, type Bus } from "./core/bus.ts";
import { Catalog } from "./pay/catalog.ts";
import { BawSigner, LocalSigner, randomPrivateKey, type Signer } from "./pay/client.ts";
import { selectFacilitator } from "./pay/facilitator.ts";
import { SignalFeeds } from "./pay/feeds.ts";
import { createPayServer } from "./pay/server.ts";
import { recoverFills } from "./venues/binance/recovery.ts";
import { urlMatrix } from "./venues/binance/urls.ts";
import { FuturesUserData, SpotUserData } from "./venues/binance/userdata.ts";

export interface ModuleContext {
  env: Env;
  config: Config;
  ledger: Ledger;
  stateDir: string;
  configDir: string;
  bus?: Bus;
}

export interface HotLane {
  modules: Module[];
  feed: FeedModule;
  audit: AuditCache;
  registry: EngineRegistry;
  /** `stack` is populated once the executor module has started. */
  executor: Module & { stack: ExecutorStack | null };
  catalog: Catalog;
  dashboard: Dashboard;
}

const log = logger("wiring");

/** User-data streams + fill recovery on boot and after every reconnect. Skipped when a venue has no key. */
function createUserDataModule(ctx: ModuleContext, feed: FeedModule): Module {
  const { env, config, ledger } = ctx;
  const urls = urlMatrix(env);
  const recover = () =>
    recoverFills({
      ledger,
      futuresRest: env.keys.futures === null ? undefined : feed.futuresRest,
      spotRest: env.keys.spot === null ? undefined : feed.spotRest,
      futuresSymbols: config.risk.allowed_symbols.futures,
      spotSymbols: config.risk.allowed_symbols.spot,
    }).then((r) => log.info("fill recovery", { inserted: r.inserted, skipped: r.skipped }));
  const futures = env.keys.futures === null ? null : new FuturesUserData({ rest: feed.futuresRest, ledger, baseWs: urls.futuresWs, onReconnect: recover });
  const spot =
    env.keys.spot === null
      ? null
      : new SpotUserData({ rest: feed.spotRest, key: env.keys.spot.key, secret: env.keys.spot.secret, ledger, wsApiUrl: urls.spotWsApi, onReconnect: recover });
  return {
    name: "userdata",
    order: "executor",
    async start() {
      if (futures === null && spot === null) {
        log.warn("no venue keys: user-data streams and fill recovery disabled");
        return;
      }
      futures?.start();
      spot?.start();
    },
    stop() {
      futures?.stop();
      spot?.stop();
    },
  };
}

/** x402 buyer identity. Demo: local key (env or throwaway). Live: the paired `baw` wallet, connected when the seller module starts. */
function buyerSigner(env: Env): Signer | undefined {
  if (env.x402 === "mock") return new LocalSigner(env.x402DemoPrivateKey ?? randomPrivateKey());
  return env.bawBin === null ? undefined : new BawSigner(env.bawBin);
}

/** Every runtime module. One on-chain adapter is shared by feed and executor; one Catalog by seller and Sales tool. */
export function hotLaneModules(ctx: ModuleContext): HotLane {
  const feed = createFeedModule(ctx);
  const audit = new AuditCache();
  const userdata = createUserDataModule(ctx, feed);
  const executor = createExecutorModule({ ...ctx, feed: feed.hub, onchain: feed.onchain, audit });
  const engines = createEnginesModule({
    ...ctx,
    feed: feed.hub,
    skills: feed.skills,
    audit,
    submit: (intent) => {
      const stack = executor.stack;
      if (stack === null) return Promise.reject(new Error("executor not started"));
      return stack.executor.submit(intent);
    },
  });
  const catalog = new Catalog(ctx.config.pricing);
  const signer = buyerSigner(ctx.env);
  const agents = createAgentsModule({ ...ctx, stack: () => executor.stack, registry: engines.registry, catalog, signer });
  const signals = new SignalFeeds({});
  const pay = createPayServer({
    env: ctx.env,
    catalog,
    facilitator: selectFacilitator(ctx.env),
    ledger: ctx.ledger,
    feeds: signals,
    payTo: process.env.X402_PAY_TO,
  });
  const seller: Module = {
    name: "x402",
    order: "agents",
    async start() {
      if (signer instanceof BawSigner) await signer.connect(feed.onchain);
      signals.start();
      const { port } = pay.start();
      log.info("x402 seller listening", { port, facilitator: ctx.env.x402 });
    },
    stop() {
      pay.stop();
      signals.stop();
    },
  };
  let dreamScheduler: AutonomousDreamScheduler | null = null;
  const dream: Module = {
    name: "dream",
    order: "agents",
    start() {
      dreamScheduler = startAutonomousDreamScheduler({
        filePath: `${ctx.stateDir}/dream-memory.json`,
        bus: ctx.bus ?? globalBus,
        ledger: ctx.ledger,
      });
      log.info("dream coin module active", { check_utc_00: true });
    },
    stop() {
      dreamScheduler?.stop();
      dreamScheduler = null;
    },
  };
  const dashboard = createDashboard({
    ...ctx,
    hot: { feed, registry: engines.registry, executor },
    agentRuntime: () => agents.scheduler?.runtimeStatus() ?? {
      commander: { active: false }, supervisor: { active: false },
      treasurer: { active: false }, coach: { active: false }, sales: { active: false },
    },
    coldLane: () => (agents.scheduler ? agents.scheduler.coldLaneStatus() : { enabled: false, paused: false, pausedUntil: 0, budgetPct: 0 }),
    resumeColdLane: () => {
      const s = agents.scheduler;
      if (s === null) return false;
      s.resume();
      return true;
    },
  });
  return {
    modules: [feed, executor, userdata, engines, agents, seller, dream, dashboard.module],
    feed,
    audit,
    registry: engines.registry,
    executor,
    catalog,
    dashboard,
  };
}
