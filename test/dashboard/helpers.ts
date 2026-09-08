import { join } from "node:path";
import { Bus } from "../../src/core/bus.ts";
import { loadConfig } from "../../src/core/config.ts";
import { loadEnv } from "../../src/core/env.ts";
import { type Ledger, openLedger } from "../../src/core/ledger.ts";
import { AuditCache } from "../../src/hot/audit-cache.ts";
import { EngineRegistry } from "../../src/hot/engines/registry.ts";
import { createDashboard, type Dashboard, type DashboardHot } from "../../src/dashboard/server.ts";
import { cleanup, tempConfigDir, tempDir } from "../core/helpers.ts";

export const TOKEN = "test-dashboard-token-0123456789";
export const VIEWER_TOKEN = "test-viewer-token-9876543210abc";

export interface Rig {
  base: string;
  dir: string;
  stateDir: string;
  ledger: Ledger;
  dash: Dashboard;
  stop(): void;
}

/** Dashboard on port 0 over a temp config copy, a file ledger and a hot lane with no sockets/executor. */
export function startRig(): Rig {
  const dir = tempConfigDir();
  const stateDir = tempDir();
  const config = loadConfig(dir);
  const env = loadEnv({ source: { HYDRA_MODE: "demo", DASHBOARD_TOKEN: TOKEN, DASHBOARD_VIEWER_TOKEN: VIEWER_TOKEN }, warn: () => undefined, notice: () => undefined });
  const ledger = openLedger(join(stateDir, "hydra.sqlite"));
  const bus = new Bus();
  const registry = new EngineRegistry(
    {
      feed: { book: () => null, mark: () => null, burst: () => ({ buyUsd1s: 0, sellUsd1s: 0 }), gapBps: () => 0, vwap1m: () => 0, adv: () => 0, spotTopOfBook: () => null, referenceMid: () => null },
      submit: () => Promise.resolve({ ok: true, orders: [], fills: [] }),
      skills: null,
      audit: new AuditCache(),
      ledger,
      bus,
      nowNs: () => 0,
      wallMs: () => 0,
      mode: "demo",
      risk: config.risk,
    },
    {},
  );
  const hot: DashboardHot = {
    feed: { hub: { book: () => null, mark: () => null, burst: () => ({ buyUsd1s: 0, sellUsd1s: 0 }), gapBps: () => 0, spotTopOfBook: () => null } },
    registry,
    executor: { stack: null },
  };
  const dash = createDashboard({ env, config, ledger, stateDir, configDir: dir, hot, port: 0, bus, fetchModels: () => Promise.resolve(["openai/gpt-5.6-luna"]) });
  const { port } = dash.start();
  return {
    base: `http://127.0.0.1:${port}`,
    dir,
    stateDir,
    ledger,
    dash,
    stop() {
      dash.stop();
      ledger.close();
      cleanup(dir);
      cleanup(stateDir);
    },
  };
}

export function authed(init: RequestInit = {}, token: string = TOKEN): RequestInit {
  return { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } };
}

/** Browser-style login: returns the session cookie pair plus the dashboard's own Origin. */
export async function login(base: string, token: string = TOKEN): Promise<{ cookie: string; origin: string; role: string }> {
  const origin = `http://127.0.0.1:${new URL(base).port}`;
  const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ token }) });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const { role } = (await res.json()) as { role: string };
  return { cookie, origin, role };
}

/** Request init for a cookie session; `origin` is sent on every call the way a browser would. */
export function asBrowser(s: { cookie: string; origin: string }, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { cookie: s.cookie, origin: s.origin, "content-type": "application/json", ...(init.headers ?? {}) } };
}
