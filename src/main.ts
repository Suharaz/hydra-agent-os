// Process entry and lifecycle owner. Each boot gets its own module instances; partial starts
// are stopped before closing the ledger. Real-venue keys are checked before modules start.

import { mkdirSync } from "node:fs";
import { configureAlert } from "./core/alert.ts";
import { applyModelOverrides, loadConfig, type Config } from "./core/config.ts";
import { loadEnv, venueMatrix, type Env } from "./core/env.ts";
import { openLedger, type Ledger } from "./core/ledger.ts";
import { readSecrets, SECRET_KEYS, SecretsError, secretsExist } from "./core/secrets.ts";
import { logger } from "./core/log.ts";
import type { Mode } from "./core/types.ts";
import { checkApiKeyPermissions } from "./venues/binance/apikey-check.ts";
import { SpotRest } from "./venues/binance/rest-spot.ts";
import { dirname } from "node:path";
import { hotLaneModules } from "./wiring.ts";

export type ModuleOrder = "feed" | "executor" | "engines" | "agents";
/** Boot order; shutdown runs the reverse (agents -> engines -> executor -> feed), then the ledger. */
export const START_ORDER: readonly ModuleOrder[] = ["feed", "executor", "engines", "agents"];

export interface Module {
  name: string;
  order: ModuleOrder;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

const registry: Record<ModuleOrder, Module[]> = { feed: [], executor: [], engines: [], agents: [] };

export function registerModule(m: Module): void {
  registry[m.order].push(m);
}

/** Tests only: drop every registered module. */
export function clearModules(): void {
  for (const order of START_ORDER) registry[order].length = 0;
}

export type ModuleFactory = (ctx: { env: Env; config: Config; ledger: Ledger; stateDir: string; configDir: string }) => Module[];

export interface BootOptions {
  /** Overrides HYDRA_MODE. */
  mode?: Mode;
  /** Boot, then shut down and return without installing signal handlers. */
  check?: boolean;
  configDir?: string;
  ledgerPath?: string;
  stateDir?: string;
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  /** Built after env/config/ledger; started after statically registered modules. */
  modules?: ModuleFactory;
}

export interface Runtime {
  env: Env;
  config: Config;
  ledger: Ledger;
  /** Resolved state directory used by this boot (may differ from "state" in scenario/soak runs). */
  stateDir: string;
  /** Idempotent. */
  shutdown(): Promise<void>;
}

export interface CliArgs {
  mode?: Mode;
  check: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--mode") {
      const v = argv[++i];
      if (v !== "demo" && v !== "live") throw new Error(`--mode expects demo|live, got "${v ?? ""}"`);
      out.mode = v;
    } else if (a?.startsWith("--mode=")) {
      const v = a.slice("--mode=".length);
      if (v !== "demo" && v !== "live") throw new Error(`--mode expects demo|live, got "${v}"`);
      out.mode = v;
    } else throw new Error(`unknown argument "${a ?? ""}"`);
  }
  return out;
}

export function formatVenueMatrix(env: Env): string {
  const rows = venueMatrix(env);
  const lines = [`HYDRA mode=${env.mode}`, "  venue     flag      real-money"];
  for (const [venue, flag, real] of rows) lines.push(`  ${venue.padEnd(9)} ${flag.padEnd(9)} ${real ? "YES" : "no"}`);
  return lines.join("\n");
}

const log = logger("main");

export async function boot(opts: BootOptions = {}): Promise<Runtime> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const source = { ...(opts.env ?? process.env) };
  if (opts.mode !== undefined) source.HYDRA_MODE = opts.mode;

  // UI-managed credentials live encrypted in state/secrets.enc. When the launch environment carries
  // the master passphrase, decrypt and layer them UNDER the process env: an explicit env var always
  // wins, so nothing already set is overridden. A wrong passphrase or a store present without a
  // passphrase is a loud warning, not a boot failure (demo still runs; live fails later on missing keys).
  const secretsDir = opts.stateDir ?? "state";
  const passphrase = source.HYDRA_MASTER_PASSPHRASE;
  if (passphrase !== undefined && passphrase !== "") {
    try {
      const stored = readSecrets(secretsDir, passphrase);
      let layered = 0;
      for (const key of SECRET_KEYS) {
        const val = stored[key];
        if (val !== undefined && (source[key] === undefined || source[key] === "")) {
          source[key] = val;
          layered++;
        }
      }
      if (layered > 0) out(`[secrets] loaded ${layered} credential(s) from state/secrets.enc`);
    } catch (err) {
      out(`[secrets] WARNING: ${err instanceof SecretsError ? err.message : String(err)}; encrypted keys NOT loaded`);
    }
  } else if (secretsExist(secretsDir)) {
    out("[secrets] state/secrets.enc present but HYDRA_MASTER_PASSPHRASE not set; encrypted keys NOT loaded");
  }
  const env = loadEnv({ source, notice: out, warn: (m) => log.warn(m) });

  // Permissions belong to each actual live venue's key, not the global demo/live label.
  // /sapi is only available on mainnet, including for the key used by Futures.
  const checkedKeys = new Set<string>();
  for (const venue of ["spot", "futures"] as const) {
    const key = env.keys[venue];
    if (env[venue] !== "live" || key === null || checkedKeys.has(key.key)) continue;
    const rest = new SpotRest({ baseUrl: "https://api.binance.com/api", key: key.key, secret: key.secret });
    const check = await checkApiKeyPermissions(rest);
    for (const warning of check.warnings) log.warn(`[apikey:${venue}] ${warning}`);
    if (!check.ok) throw new Error(`live ${venue} boot refused: ${check.problems.join("; ")}`);
    checkedKeys.add(key.key);
  }
  const configDir = opts.configDir ?? "config";
  const loaded = loadConfig(configDir);
  const config: Config = { ...loaded, agents: applyModelOverrides(loaded.agents, env.modelOverrides) };
  configureAlert({ telegramBotToken: env.telegramBotToken, telegramChatId: env.telegramChatId, webhookUrl: env.alertWebhook });

  const stateDir = opts.stateDir ?? "state";
  const ledgerPath = opts.ledgerPath ?? `${stateDir}/hydra.sqlite`;
  if (ledgerPath !== ":memory:") mkdirSync(dirname(ledgerPath), { recursive: true });
  const ledger = openLedger(ledgerPath);
  ledger.event("system.boot", JSON.stringify({ mode: env.mode, spot: env.spot, futures: env.futures, onchain: env.onchain, x402: env.x402, mcp: env.mcp }));

  out(formatVenueMatrix(env));

  const started: Module[] = [];
  let stopping: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (stopping === null) {
      stopping = (async () => {
        for (let i = started.length - 1; i >= 0; i--) {
          const m = started[i];
          if (m === undefined) continue;
          try {
            await m.stop();
            log.info(`stopped ${m.name}`);
          } catch (err) {
            log.error(`stop ${m.name} failed`, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        ledger.event("system.shutdown", null);
        ledger.close();
      })();
    }
    return stopping;
  };

  try {
    const modules = [...START_ORDER.flatMap((order) => registry[order]), ...(opts.modules?.({ env, config, ledger, stateDir, configDir }) ?? [])];
    for (const order of START_ORDER) {
      for (const m of modules) {
        if (m.order !== order) continue;
        // A rejected start may already own sockets/timers; stop it as well.
        started.push(m);
        await m.start();
        log.info(`started ${m.name}`, { order });
      }
    }
  } catch (err) {
    await shutdown();
    throw err;
  }

  return { env, config, ledger, stateDir, shutdown };
}

function installSignalHandlers(rt: Runtime): void {
  const onSignal = (sig: string) => {
    log.info(`received ${sig}; shutting down`);
    const hard = setTimeout(() => {
      log.error("shutdown timed out; hard exit");
      process.exit(1);
    }, 1000);
    rt.shutdown().then(
      () => {
        clearTimeout(hard);
        process.exit(0);
      },
      (err) => {
        clearTimeout(hard);
        log.error("shutdown failed", { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      },
    );
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    try {
      process.on(sig, () => onSignal(sig));
    } catch {
      // SIGHUP is not deliverable on every platform; console-close recovery is boot-time (Phase 3).
    }
  }
}

if (import.meta.main) {
  // A self-respawned child (dashboard "Save & Restart" without a supervisor) waits for the outgoing
  // process to release its dashboard/x402 ports before booting, so there is no EADDRINUSE bind race.
  if (process.env.HYDRA_RESPAWN === "1") await Bun.sleep(1000);
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("usage: bun run hydra [--mode demo|live] [--check]");
    process.exit(2);
  }
  let rt: Runtime;
  try {
    rt = await boot({ mode: args.mode, check: args.check, modules: args.check ? undefined : (ctx) => hotLaneModules(ctx).modules });
  } catch (err) {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  }
  if (args.check) {
    await rt.shutdown();
    console.log("check ok");
    process.exit(0);
  }
  installSignalHandlers(rt);
  log.info("running; Ctrl-C to stop");
}
