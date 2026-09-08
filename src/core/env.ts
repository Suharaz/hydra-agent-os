// process.env -> typed Env. Mode derives per-venue defaults; explicit flags override.
// Fails fast with an EnvError listing every problem, never partially boots.

import { isAbsolute } from "node:path";
import { z } from "zod";
import { AGENT_NAMES, type AgentName, type FuturesFlag, type McpFlag, type Mode, type OnchainFlag, type SpotFlag, type X402Flag } from "./types.ts";

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid environment:\n  - ${problems.join("\n  - ")}`);
    this.name = "EnvError";
  }
}

export interface VenueKeys {
  key: string;
  secret: string;
}

export interface Env {
  mode: Mode;
  spot: SpotFlag;
  futures: FuturesFlag;
  onchain: OnchainFlag;
  x402: X402Flag;
  mcp: McpFlag;
  keys: { spot: VenueKeys | null; futures: VenueKeys | null };
  /** Operator role. */
  dashboardToken: string;
  /** Read-only role; null when unset. */
  dashboardViewerToken: string | null;
  dashboardPort: number;
  x402Port: number;
  x402DemoPrivateKey: string | null;
  openrouterApiKey: string | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  alertWebhook: string | null;
  bawBin: string | null;
  killFlattenAllSpot: boolean;
  replaySpeed: number;
  skillsHttp: string;
  /** HYDRA_MODEL_<AGENT> overrides; only agents with an override are present. */
  modelOverrides: Partial<Record<AgentName, string>>;
  /** True when DASHBOARD_TOKEN was generated at boot (demo only). */
  dashboardTokenGenerated: boolean;
  /** Admin console username. */
  dashboardUser: string;
  /** Admin console password; null when unset. */
  dashboardPassword: string | null;
  /** True when DASHBOARD_PASSWORD was generated at boot (demo only). */
  dashboardPasswordGenerated: boolean;
}

const MODEL_ID = /^[a-z0-9-]+\/[a-z0-9._:-]+$/;
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optStr = z.preprocess(blank, z.string().optional());
const port = (def: number) => z.preprocess(blank, z.coerce.number().int().min(1).max(65535).default(def));
const flag = z.preprocess(blank, z.enum(["1", "0", "true", "false"]).optional());

const RawEnv = z.object({
  HYDRA_MODE: z.preprocess(blank, z.enum(["demo", "live"]).default("demo")),
  HYDRA_I_UNDERSTAND_REAL_MONEY: flag,
  SPOT: z.preprocess(blank, z.enum(["testnet", "live"]).optional()),
  FUTURES: z.preprocess(blank, z.enum(["demo", "live"]).optional()),
  ONCHAIN: z.preprocess(blank, z.enum(["paper", "live"]).optional()),
  X402: z.preprocess(blank, z.enum(["mock", "b402", "cdp"]).optional()),
  MCP: z.preprocess(blank, z.enum(["off", "on"]).optional()),
  BINANCE_SPOT_API_KEY: optStr,
  BINANCE_SPOT_API_SECRET: optStr,
  BINANCE_FUTURES_API_KEY: optStr,
  BINANCE_FUTURES_API_SECRET: optStr,
  DASHBOARD_TOKEN: optStr,
  DASHBOARD_VIEWER_TOKEN: optStr,
  DASHBOARD_USER: optStr,
  DASHBOARD_PASSWORD: optStr,
  DASHBOARD_PORT: port(8787),
  X402_PORT: port(8788),
  X402_DEMO_PRIVATE_KEY: optStr,
  OPENROUTER_API_KEY: optStr,
  TELEGRAM_BOT_TOKEN: optStr,
  TELEGRAM_CHAT_ID: optStr,
  ALERT_WEBHOOK_URL: z.preprocess(blank, z.string().url().optional()),
  BAW_BIN: optStr,
  KILL_FLATTEN_ALL_SPOT: flag,
  REPLAY_SPEED: z.preprocess(blank, z.coerce.number().positive().default(1)),
  SKILLS_HTTP: z.preprocess(blank, z.string().url().default("https://web3.binance.com")),
});

export interface LoadEnvOptions {
  /** Defaults to process.env. */
  source?: Record<string, string | undefined>;
  /** Receives warnings (default: console.warn). */
  warn?: (msg: string) => void;
  /** Receives one-time notices such as the generated dashboard token (default: console.log). */
  notice?: (msg: string) => void;
}

export function loadEnv(opts: LoadEnvOptions = {}): Env {
  const source = opts.source ?? process.env;
  const warn = opts.warn ?? ((m) => console.warn(m));
  const notice = opts.notice ?? ((m) => console.log(m));

  const parsed = RawEnv.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  const r = parsed.data;
  const problems: string[] = [];

  const mode = r.HYDRA_MODE;
  const spot: SpotFlag = r.SPOT ?? (mode === "live" ? "live" : "testnet");
  const futures: FuturesFlag = r.FUTURES ?? (mode === "live" ? "live" : "demo");
  const onchain: OnchainFlag = r.ONCHAIN ?? (mode === "live" ? "live" : "paper");
  const x402: X402Flag = r.X402 ?? (mode === "live" ? "b402" : "mock");
  const mcp: McpFlag = r.MCP ?? "off";

  const anyLive = mode === "live" || spot === "live" || futures === "live" || onchain === "live";
  const acknowledged = r.HYDRA_I_UNDERSTAND_REAL_MONEY === "1" || r.HYDRA_I_UNDERSTAND_REAL_MONEY === "true";
  if (anyLive && !acknowledged) {
    problems.push(
      `real-money venue selected (mode=${mode} spot=${spot} futures=${futures} onchain=${onchain}) but HYDRA_I_UNDERSTAND_REAL_MONEY=1 is not set`,
    );
  }
  if (mode === "demo" && x402 !== "mock") {
    problems.push(`X402=${x402} requires HYDRA_MODE=live`);
  }

  const keyPair = (venue: "spot" | "futures", key: string | undefined, secret: string | undefined, live: boolean): VenueKeys | null => {
    if (key !== undefined && secret !== undefined) return { key, secret };
    if (key !== undefined || secret !== undefined) {
      problems.push(`BINANCE_${venue.toUpperCase()}_API_KEY and _SECRET must both be set`);
      return null;
    }
    if (live) problems.push(`BINANCE_${venue.toUpperCase()}_API_KEY/_SECRET required when ${venue}=live`);
    else warn(`[env] ${venue} keys absent; ${venue} trading will be unavailable (demo)`);
    return null;
  };
  const keys = {
    spot: keyPair("spot", r.BINANCE_SPOT_API_KEY, r.BINANCE_SPOT_API_SECRET, spot === "live"),
    futures: keyPair("futures", r.BINANCE_FUTURES_API_KEY, r.BINANCE_FUTURES_API_SECRET, futures === "live"),
  };

  const MIN_TOKEN = 24;
  let dashboardToken = r.DASHBOARD_TOKEN ?? "";
  let dashboardTokenGenerated = false;
  if (dashboardToken === "") {
    if (mode === "live") {
      problems.push("DASHBOARD_TOKEN required in live mode");
    } else {
      dashboardToken = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
      dashboardTokenGenerated = true;
      notice(`[env] DASHBOARD_TOKEN not set; generated for this run: ${dashboardToken}`);
    }
  } else if (dashboardToken.length < MIN_TOKEN) {
    if (mode === "live") problems.push(`DASHBOARD_TOKEN must be at least ${MIN_TOKEN} characters (got ${dashboardToken.length})`);
    else warn(`[env] DASHBOARD_TOKEN is only ${dashboardToken.length} characters; use >= ${MIN_TOKEN} (required in live)`);
  }
  const dashboardViewerToken = r.DASHBOARD_VIEWER_TOKEN ?? null;
  if (dashboardViewerToken !== null) {
    if (dashboardViewerToken.length < MIN_TOKEN) {
      if (mode === "live") problems.push(`DASHBOARD_VIEWER_TOKEN must be at least ${MIN_TOKEN} characters (got ${dashboardViewerToken.length})`);
      else warn(`[env] DASHBOARD_VIEWER_TOKEN is only ${dashboardViewerToken.length} characters; use >= ${MIN_TOKEN} (required in live)`);
    }
    if (dashboardViewerToken === dashboardToken) problems.push("DASHBOARD_VIEWER_TOKEN must differ from DASHBOARD_TOKEN");
  }

  const MIN_PASSWORD = 8;
  const dashboardUser = r.DASHBOARD_USER ?? "admin";
  let dashboardPassword = r.DASHBOARD_PASSWORD ?? "";
  let dashboardPasswordGenerated = false;
  if (dashboardPassword === "") {
    if (mode === "live") {
      problems.push("DASHBOARD_PASSWORD required in live mode");
    } else {
      dashboardPassword = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");
      dashboardPasswordGenerated = true;
      notice(`[env] DASHBOARD_PASSWORD not set; generated for this run: ${dashboardPassword} (user: ${dashboardUser})`);
    }
  } else if (dashboardPassword.length < MIN_PASSWORD) {
    if (mode === "live") problems.push(`DASHBOARD_PASSWORD must be at least ${MIN_PASSWORD} characters (got ${dashboardPassword.length})`);
    else warn(`[env] DASHBOARD_PASSWORD is only ${dashboardPassword.length} characters; use >= ${MIN_PASSWORD} (required in live)`);
  }

  let bawBin: string | null = r.BAW_BIN ?? null;
  if (onchain === "live") {
    if (bawBin === null) problems.push("BAW_BIN (absolute path to baw binary) required when ONCHAIN=live");
    else if (!isAbsolute(bawBin)) problems.push(`BAW_BIN must be an absolute path, got "${bawBin}"`);
  } else if (bawBin !== null && !isAbsolute(bawBin)) {
    warn(`[env] BAW_BIN "${bawBin}" is not absolute; ignored in ONCHAIN=paper`);
    bawBin = null;
  }

  const telegramBotToken = r.TELEGRAM_BOT_TOKEN ?? null;
  const telegramChatId = r.TELEGRAM_CHAT_ID ?? null;
  if ((telegramBotToken === null) !== (telegramChatId === null)) {
    problems.push("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set");
  }
  const alertWebhook = r.ALERT_WEBHOOK_URL ?? null;
  if (mode === "live" && telegramBotToken === null && alertWebhook === null) {
    warn("[env] no alert channel configured in live mode (TELEGRAM_BOT_TOKEN/CHAT_ID or ALERT_WEBHOOK_URL)");
  }

  const openrouterApiKey = r.OPENROUTER_API_KEY ?? null;
  if (openrouterApiKey === null) warn("[env] OPENROUTER_API_KEY absent; cold lane (LLM agents) disabled");

  const modelOverrides: Partial<Record<AgentName, string>> = {};
  for (const agent of AGENT_NAMES) {
    const raw = blank(source[`HYDRA_MODEL_${agent.toUpperCase()}`]);
    if (raw === undefined) continue;
    if (typeof raw !== "string" || !MODEL_ID.test(raw)) {
      problems.push(`HYDRA_MODEL_${agent.toUpperCase()}: invalid OpenRouter model id "${String(raw)}"`);
      continue;
    }
    modelOverrides[agent] = raw;
  }

  if (problems.length > 0) throw new EnvError(problems);

  return {
    mode,
    spot,
    futures,
    onchain,
    x402,
    mcp,
    keys,
    dashboardToken,
    dashboardViewerToken,
    dashboardPort: r.DASHBOARD_PORT,
    x402Port: r.X402_PORT,
    x402DemoPrivateKey: r.X402_DEMO_PRIVATE_KEY ?? null,
    openrouterApiKey,
    telegramBotToken,
    telegramChatId,
    alertWebhook,
    bawBin,
    killFlattenAllSpot: r.KILL_FLATTEN_ALL_SPOT === "1" || r.KILL_FLATTEN_ALL_SPOT === "true",
    replaySpeed: r.REPLAY_SPEED,
    skillsHttp: r.SKILLS_HTTP,
    modelOverrides,
    dashboardTokenGenerated,
    dashboardUser,
    dashboardPassword,
    dashboardPasswordGenerated,
  };
}

/** Rows for the boot banner: [venue, flag, real-money?]. */
export function venueMatrix(env: Env): Array<[string, string, boolean]> {
  return [
    ["spot", env.spot, env.spot === "live"],
    ["futures", env.futures, env.futures === "live"],
    ["onchain", env.onchain, env.onchain === "live"],
    ["x402", env.x402, env.x402 !== "mock"],
    ["mcp", env.mcp, false],
  ];
}

/** True when any trading venue operates on real money (overrides top-level mode for safety checks). */
export function anyVenueLive(env: Env): boolean {
  return env.spot === "live" || env.futures === "live" || env.onchain === "live";
}
