import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadEnv } from "../../src/core/env.ts";
import { createDashboard, DashboardBindError, WS_MAX_CLIENTS } from "../../src/dashboard/server.ts";
import { asBrowser, authed, login, type Rig, startRig, TOKEN, VIEWER_TOKEN } from "./helpers.ts";

let rig: Rig;

beforeAll(() => {
  rig = startRig();
});

afterAll(() => {
  rig.stop();
});

const auditRows = (r: Rig) => r.ledger.db.query<{ session: string; role: string; action: string; status: number }, []>("SELECT session, role, action, status FROM dashboard_audit ORDER BY id").all();

const wsOpens = (url: string): Promise<{ ok: boolean; frame?: { type: string; role?: string; logs?: unknown } }> =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      resolve({ ok: true, frame: JSON.parse(String(ev.data)) });
      ws.close();
    };
    ws.onerror = () => resolve({ ok: false });
    ws.onclose = () => resolve({ ok: false });
  });

describe("bearer auth (curl/tests)", () => {
  test("/api/state without a token is an anonymous read-only viewer; a wrong token is 401", async () => {
    const anon = await fetch(`${rig.base}/api/state`);
    expect(anon.status).toBe(200);
    const a = (await anon.json()) as { role: string; logs?: unknown };
    expect(a.role).toBe("viewer");
    expect("logs" in a).toBe(false);
    const wrong = await fetch(`${rig.base}/api/state`, { headers: { authorization: `Bearer ${TOKEN}x` } });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe("unauthorized");
  });

  test("foreign Origin is 403 even with a valid token; only the dashboard's own port passes", async () => {
    expect((await fetch(`${rig.base}/api/state`, authed({ headers: { origin: "https://evil.example" } }))).status).toBe(403);
    expect((await fetch(`${rig.base}/api/state`, authed({ headers: { origin: "http://localhost:5173" } }))).status).toBe(403);
    const boundPort = new URL(rig.base).port;
    expect((await fetch(`${rig.base}/api/state`, authed({ headers: { origin: `http://127.0.0.1:${boundPort}` } }))).status).toBe(200);
    expect((await fetch(`${rig.base}/api/state`, authed({ headers: { origin: `http://localhost:${boundPort}` } }))).status).toBe(200);
  });

  test("operator bearer sees role + logs; viewer bearer sees role, no logs, and 403 on writes", async () => {
    const op = (await (await fetch(`${rig.base}/api/state`, authed())).json()) as { role: string; logs?: unknown };
    expect(op.role).toBe("operator");
    expect(Array.isArray(op.logs)).toBe(true);
    const viewer = await fetch(`${rig.base}/api/state`, authed({}, VIEWER_TOKEN));
    expect(viewer.status).toBe(200);
    const v = (await viewer.json()) as { role: string; logs?: unknown };
    expect(v.role).toBe("viewer");
    expect("logs" in v).toBe(false);
    const denied = await fetch(`${rig.base}/api/config/budgets`, authed({ method: "PUT", body: JSON.stringify({ llm_daily_budget_usd: 1 }) }, VIEWER_TOKEN));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe("operator role required");
    expect((await fetch(`${rig.base}/api/kill`, authed({ method: "POST", body: JSON.stringify({ confirm: "KILL" }) }, VIEWER_TOKEN))).status).toBe(403);
    expect((await fetch(`${rig.base}/api/audit`, authed({}, VIEWER_TOKEN))).status).toBe(403);
    // The refused write is on the record.
    expect(auditRows(rig).some((r) => r.action === "budgets_put" && r.status === 403 && r.role === "viewer" && r.session === "bearer")).toBe(true);
  });
});

describe("cookie sessions (browsers)", () => {
  test("login sets an HttpOnly SameSite=Strict cookie; session survives; logout revokes it", async () => {
    const res = await fetch(`${rig.base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: rig.base }, body: JSON.stringify({ token: TOKEN }) });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^hydra_session=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Strict$/);
    expect(((await res.json()) as { role: string }).role).toBe("operator");
    const s = { cookie: setCookie.split(";")[0] ?? "", origin: rig.base };
    const session = await fetch(`${rig.base}/api/session`, asBrowser(s));
    expect(session.status).toBe(200);
    expect((await session.json()) as object).toEqual({ role: "operator", mode: "demo" });
    expect((await fetch(`${rig.base}/api/logout`, asBrowser(s, { method: "POST" }))).status).toBe(204);
    // The revoked cookie no longer grants operator; the request falls back to the anonymous viewer.
    const after = await fetch(`${rig.base}/api/session`, asBrowser(s));
    expect(after.status).toBe(200);
    expect(((await after.json()) as { role: string }).role).toBe("viewer");
  });

  test("wrong login token is 401; login from a foreign Origin is 403; no session created", async () => {
    const wrong = await fetch(`${rig.base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: rig.base }, body: JSON.stringify({ token: "nope" }) });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const foreign = await fetch(`${rig.base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ token: TOKEN }) });
    expect(foreign.status).toBe(403);
  });

  test("a cookie write without Origin is 403 (not a browser); with the dashboard Origin it works and is attributed to the session", async () => {
    const s = await login(rig.base);
    const noOrigin = await fetch(`${rig.base}/api/config/budgets`, { method: "PUT", headers: { cookie: s.cookie, "content-type": "application/json" }, body: JSON.stringify({ llm_daily_budget_usd: 3 }) });
    expect(noOrigin.status).toBe(403);
    const ok = await fetch(`${rig.base}/api/config/budgets`, asBrowser(s, { method: "PUT", body: JSON.stringify({ llm_daily_budget_usd: 3 }) }));
    expect(ok.status).toBe(200);
    const session8 = s.cookie.slice("hydra_session=".length, "hydra_session=".length + 8);
    const change = rig.ledger.db.query<{ actor: string }, []>("SELECT actor FROM config_changes ORDER BY id DESC LIMIT 1").get();
    expect(change?.actor).toBe(`operator:${session8}`);
    const row = auditRows(rig).filter((r) => r.action === "budgets_put" && r.status === 200).at(-1);
    expect(row?.session).toBe(session8);
    expect(row?.role).toBe("operator");
  });

  test("viewer session: GET ok without logs, every write 403, revoke-all 403", async () => {
    const s = await login(rig.base, VIEWER_TOKEN);
    expect(s.role).toBe("viewer");
    const state = (await (await fetch(`${rig.base}/api/state`, asBrowser(s))).json()) as { role: string; logs?: unknown };
    expect(state.role).toBe("viewer");
    expect("logs" in state).toBe(false);
    expect((await fetch(`${rig.base}/api/config/agents`, asBrowser(s, { method: "PUT", body: JSON.stringify({ commander: { model: "a/b" } }) }))).status).toBe(403);
    expect((await fetch(`${rig.base}/api/config/agents/commander/promote-shadow`, asBrowser(s, { method: "POST" }))).status).toBe(403);
    expect((await fetch(`${rig.base}/api/dream/run`, asBrowser(s, { method: "POST", body: JSON.stringify({ confirm: "DREAM" }) }))).status).toBe(403);
    expect((await fetch(`${rig.base}/api/sessions/revoke-all`, asBrowser(s, { method: "POST" }))).status).toBe(403);
    // Session routes stay open to the viewer.
    expect((await fetch(`${rig.base}/api/ws-ticket`, asBrowser(s, { method: "POST" }))).status).toBe(200);
    expect((await fetch(`${rig.base}/api/logout`, asBrowser(s, { method: "POST" }))).status).toBe(204);
  });

  test("revoke-all kills every session including the caller's", async () => {
    const a = await login(rig.base);
    const b = await login(rig.base, VIEWER_TOKEN);
    const res = await fetch(`${rig.base}/api/sessions/revoke-all`, asBrowser(a, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revoked: number }).revoked).toBeGreaterThanOrEqual(2);
    // Both sessions are gone; the requests fall back to the anonymous viewer (the operator loses operator).
    const sa = await fetch(`${rig.base}/api/session`, asBrowser(a));
    expect(sa.status).toBe(200);
    expect(((await sa.json()) as { role: string }).role).toBe("viewer");
    const sb = await fetch(`${rig.base}/api/session`, asBrowser(b));
    expect(sb.status).toBe(200);
    expect(((await sb.json()) as { role: string }).role).toBe("viewer");
    expect(auditRows(rig).some((r) => r.action === "revoke_all" && r.status === 200)).toBe(true);
  });

  test("dream/run needs confirm; an anonymous ticket needs a browser Origin", async () => {
    expect((await fetch(`${rig.base}/api/dream/run`, authed({ method: "POST", body: JSON.stringify({}) }))).status).toBe(400);
    // No credential and no Origin: refused as a non-browser caller.
    expect((await fetch(`${rig.base}/api/ws-ticket`, { method: "POST" })).status).toBe(403);
    // No credential but same-origin: the anonymous viewer gets a live-stream ticket without logging in.
    const anon = await fetch(`${rig.base}/api/ws-ticket`, { method: "POST", headers: { origin: rig.base } });
    expect(anon.status).toBe(200);
    expect(((await anon.json()) as { ticket: string }).ticket).toBeTruthy();
  });
});

describe("secrets endpoints", () => {
  const pass = JSON.stringify({ passphrase: "x".repeat(20), secrets: {} });
  test("status/unlock/save are operator-only; a viewer bearer is 403", async () => {
    expect((await fetch(`${rig.base}/api/secrets/status`, authed({}, VIEWER_TOKEN))).status).toBe(403);
    expect((await fetch(`${rig.base}/api/secrets/unlock`, authed({ method: "POST", body: JSON.stringify({ passphrase: "x".repeat(20) }) }, VIEWER_TOKEN))).status).toBe(403);
    expect((await fetch(`${rig.base}/api/secrets/save`, authed({ method: "POST", body: pass }, VIEWER_TOKEN))).status).toBe(403);
  });
  test("an anonymous caller cannot read status (403) or write save (401)", async () => {
    expect((await fetch(`${rig.base}/api/secrets/status`)).status).toBe(403);
    const save = await fetch(`${rig.base}/api/secrets/save`, { method: "POST", headers: { origin: rig.base, "content-type": "application/json" }, body: pass });
    expect(save.status).toBe(401);
  });
});

describe("agent model privacy", () => {
  type AgentCfg = { model: string; shadow_model?: string };
  type StateBody = { agents: { config: Record<string, AgentCfg>; overrides: Record<string, unknown> } };
  type RunsBody = { runs: Array<{ model: string }> };
  test("viewer never sees agent model names; operator does", async () => {
    const op = (await (await fetch(`${rig.base}/api/state`, authed())).json()) as StateBody;
    const opModels = Object.values(op.agents.config).map((c) => c.model);
    expect(opModels.some((m) => m !== "hidden")).toBe(true);

    const v = (await (await fetch(`${rig.base}/api/state`, authed({}, VIEWER_TOKEN))).json()) as StateBody;
    expect(Object.values(v.agents.config).every((c) => c.model === "hidden")).toBe(true);
    expect(v.agents.overrides).toEqual({});

    rig.ledger.insertAgentRun({ runId: "priv1", agent: "commander", role: "primary", model: "google/gemini-3.6-flash", decision: { x: 1 }, applied: true, toolRejections: 0, costUsd: 0.01, latencyMs: 100, schemaValid: true, agreementPct: 100 });
    const vRuns = (await (await fetch(`${rig.base}/api/agents/runs?limit=5`, authed({}, VIEWER_TOKEN))).json()) as RunsBody;
    expect(vRuns.runs.every((r) => r.model === "hidden")).toBe(true);
    const opRuns = (await (await fetch(`${rig.base}/api/agents/runs?limit=5`, authed())).json()) as RunsBody;
    expect(opRuns.runs.some((r) => r.model === "google/gemini-3.6-flash")).toBe(true);
  });
  test("model-revealing endpoints are operator-only", async () => {
    expect((await fetch(`${rig.base}/api/agents/ab?days=1`, authed({}, VIEWER_TOKEN))).status).toBe(403);
    expect((await fetch(`${rig.base}/api/config/agents`, authed({}, VIEWER_TOKEN))).status).toBe(403);
    expect((await fetch(`${rig.base}/api/agents/ab?days=1`, authed())).status).toBe(200);
    expect((await fetch(`${rig.base}/api/config/agents`, authed())).status).toBe(200);
  });
});

describe("websocket tickets", () => {
  test("?token= is gone; a ticket works once; a viewer ticket yields a frame without logs", async () => {
    // Own rig: each refused handshake counts toward the global lockout.
    const own = startRig();
    try {
      const wsUrl = own.base.replace("http", "ws");
      expect((await wsOpens(`${wsUrl}/ws?token=${TOKEN}`)).ok).toBe(false);
      expect((await wsOpens(`${wsUrl}/ws`)).ok).toBe(false);

      const tk = (await (await fetch(`${own.base}/api/ws-ticket`, authed({ method: "POST" }))).json()) as { ticket: string; ttlMs: number };
      expect(tk.ttlMs).toBe(30_000);
      const first = await wsOpens(`${wsUrl}/ws?ticket=${encodeURIComponent(tk.ticket)}`);
      expect(first.ok).toBe(true);
      expect(first.frame?.type).toBe("snapshot");
      expect(first.frame?.role).toBe("operator");
      expect(Array.isArray(first.frame?.logs)).toBe(true);
      expect((await wsOpens(`${wsUrl}/ws?ticket=${encodeURIComponent(tk.ticket)}`)).ok).toBe(false);

      const v = await login(own.base, VIEWER_TOKEN);
      const vt = (await (await fetch(`${own.base}/api/ws-ticket`, asBrowser(v, { method: "POST" }))).json()) as { ticket: string };
      const frame = await wsOpens(`${wsUrl}/ws?ticket=${encodeURIComponent(vt.ticket)}`);
      expect(frame.ok).toBe(true);
      expect(frame.frame?.role).toBe("viewer");
      expect(frame.frame?.logs).toBeUndefined();
    } finally {
      own.stop();
    }
  });
});

describe("response hardening", () => {
  test("security headers on pages, API and 404s; page CSP is hash-pinned; API is no-store", async () => {
    const page = await fetch(`${rig.base}/classic`);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain("HYDRA");
    expect(html).not.toMatch(/localStorage\.(get|set)Item/);
    const demo = await fetch(`${rig.base}/`);
    expect(demo.headers.get("content-security-policy") ?? "").toMatch(/script-src 'sha256-/);
    expect(await demo.text()).not.toContain("?token=");

    const api = await fetch(`${rig.base}/api/state`, authed());
    expect(api.headers.get("cache-control")).toBe("no-store");
    expect(api.headers.get("content-security-policy")).toContain("script-src 'none'");
    const missing = await fetch(`${rig.base}/nope`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-frame-options")).toBe("DENY");
  });

  test("bodies over 64 KB are 413", async () => {
    const big = JSON.stringify({ commander: { model: "a/" + "b".repeat(70_000) } });
    expect((await fetch(`${rig.base}/api/config/agents`, authed({ method: "PUT", body: big }))).status).toBe(413);
  });

  test(`at most ${WS_MAX_CLIENTS} live websocket clients`, async () => {
    const wsUrl = rig.base.replace("http", "ws");
    const open: WebSocket[] = [];
    const openOne = async (): Promise<boolean> => {
      const tk = (await (await fetch(`${rig.base}/api/ws-ticket`, authed({ method: "POST" }))).json()) as { ticket: string };
      return new Promise((resolve) => {
        const ws = new WebSocket(`${wsUrl}/ws?ticket=${encodeURIComponent(tk.ticket)}`);
        ws.onopen = () => {
          open.push(ws);
          resolve(true);
        };
        ws.onerror = () => resolve(false);
        ws.onclose = () => resolve(false);
      });
    };
    try {
      for (let i = 0; i < WS_MAX_CLIENTS; i++) expect(await openOne()).toBe(true);
      expect(await openOne()).toBe(false);
    } finally {
      for (const ws of open) ws.close();
    }
  });
});

describe("lockout", () => {
  test("5 failures in 60 s lock login, bearer and tickets for 60 s, even for the right token; one lockout audit row", async () => {
    const own = startRig();
    try {
      for (let i = 0; i < 4; i++) expect((await fetch(`${own.base}/api/state`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      const fifth = await fetch(`${own.base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: own.base }, body: JSON.stringify({ token: "wrong" }) });
      expect(fifth.status).toBe(429);
      expect(Number(fifth.headers.get("retry-after"))).toBeGreaterThan(0);
      const right = await fetch(`${own.base}/api/state`, authed());
      expect(right.status).toBe(429);
      expect(((await right.json()) as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
      expect((await fetch(`${own.base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: own.base }, body: JSON.stringify({ token: TOKEN }) })).status).toBe(429);
      expect((await wsOpens(`${own.base.replace("http", "ws")}/ws?ticket=x`)).ok).toBe(false);
      const rows = auditRows(own);
      expect(rows.filter((r) => r.action === "lockout")).toHaveLength(1);
      expect(rows.filter((r) => r.action === "auth_fail")).toHaveLength(1);
    } finally {
      own.stop();
    }
  });
});

describe("bind assertion", () => {
  test("a non-loopback hostname throws before anything listens", () => {
    const env = loadEnv({ source: { HYDRA_MODE: "demo", DASHBOARD_TOKEN: TOKEN }, warn: () => undefined, notice: () => undefined });
    const deps = { env, config: { engines: { engines: {} }, agents: { agents: {} }, risk: {} }, ledger: rig.ledger, stateDir: rig.stateDir, configDir: rig.dir, hot: { feed: { hub: {} }, registry: {}, executor: { stack: null } } };
    expect(() => createDashboard({ ...(deps as never as Parameters<typeof createDashboard>[0]), hostname: "0.0.0.0" })).toThrow(DashboardBindError);
    expect(() => createDashboard({ ...(deps as never as Parameters<typeof createDashboard>[0]), hostname: "192.168.1.10" })).toThrow(DashboardBindError);
  });
});
