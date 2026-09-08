---
phase: 2
title: "Roles and least privilege"
status: pending
priority: P1
effort: "0.4d"
dependencies: [1]
---

# Phase 2: Roles and least privilege

## Overview
Split the single all-powerful credential into `viewer` and `operator` (G4) and bring `POST /api/dream/run` under the same write discipline as the other mutations (G5). The presentation page (`/`) runs as viewer; Settings, budgets, promote-shadow, kill, dream/run, revoke-all require operator.

## Requirements
- Functional: `core/env.ts` adds optional `DASHBOARD_VIEWER_TOKEN` (same length rule as Phase 1; must differ from `DASHBOARD_TOKEN`, else boot error). `Env` gains `dashboardViewerToken: string | null`.
- Functional: `POST /api/login` resolves role: matches operator token -> `operator`; matches viewer token -> `viewer`; else 401. Bearer requests resolve the same way per request. Response body of login: `{role}` so the UI can hide write controls.
- Functional: route policy in one table, not per-handler `if`s:
  ```ts
  const WRITE = new Set(["PUT /api/config/agents", "PUT /api/config/budgets", "POST /api/config/agents/:agent/promote-shadow", "POST /api/kill", "POST /api/dream/run", "POST /api/sessions/revoke-all"]);
  ```
  Auth middleware: method != GET and route not in `{login, logout, ws-ticket}` -> requires `operator`, else `403 {error:"operator role required"}`. Any route not listed and not GET -> 403 by default (deny-by-default for future writes).
- Functional: viewer snapshot redaction: `snapshot(role)` omits `logs` for viewer (log lines may echo config diffs, wallet labels, error bodies). Everything else is already operator-facing telemetry and stays.
- Functional: WS frames respect the ticket's role: a viewer socket receives the redacted frame. Two frames are built per tick only when at least one client of each role is connected.
- Functional: `POST /api/dream/run` requires body `{confirm:"DREAM"}`; at most one run in flight (409 while running); logs actor session.
- Functional: UI: `index.html` hides Settings save/promote/kill/dream-run controls and shows a `viewer` pill when `role === "viewer"`; a 403 on a write shows "operator role required". `hydra-demo.html` logs in with whichever token is entered and shows the role pill next to the connection state.
- Non-functional: role check is a Set lookup on a precomputed `"${method} ${routePath}"` key (Hono exposes `c.req.routePath`).

## Architecture
```
login(token) -> role
authorize(req) -> {role, sessionId}
policy(method, routePath, role) -> allow | 403
snapshot(role) -> operator frame | viewer frame (no logs)
```
Roles are a closed union `"viewer" | "operator"`; no permission matrix, no config file. Adding a third role later is a type change, not a data-migration.

## Related Code Files
- Modify: `src/core/env.ts`, `.env.example`, `README.md` env table (`DASHBOARD_VIEWER_TOKEN`)
- Modify: `src/dashboard/server.ts` (login role resolution, policy table, `snapshot(role)`, dream/run confirm+mutex, WS per-role broadcast)
- Modify: `src/dashboard/session.ts` (role already on `Session` from Phase 1; nothing else)
- Modify: `src/dashboard/public/index.html`, `hydra-demo.html` (role pill, hidden write controls)
- Modify: `test/dashboard/helpers.ts` (`VIEWER_TOKEN`, `loginAs(role)`), `test/dashboard/auth.test.ts`, `test/dashboard/api.test.ts`

## Implementation Steps
1. `env.ts`: parse `DASHBOARD_VIEWER_TOKEN`; equality with operator token -> problem.
2. `server.ts`: `resolveRole(token)`; login returns `{role}`; bearer path resolves role too.
3. Policy middleware replacing the plain `/api/*` auth middleware; deny-by-default for non-GET.
4. `snapshot(role)`; `broadcast()` builds per-role frames lazily; `/api/state` uses the caller's role.
5. `dream/run`: confirm body + in-flight flag.
6. UI role pill + hidden controls; 403 message.
7. Tests: viewer GET 200 / PUT 403 / kill 403 / dream 403; viewer `/api/state` has no `logs`; viewer WS frame has no `logs`; operator unchanged; `DASHBOARD_VIEWER_TOKEN == DASHBOARD_TOKEN` -> boot error; dream/run without confirm 400, concurrent -> 409.

## Success Criteria
- [x] `test/dashboard/auth.test.ts`: viewer/operator matrix green
- [x] Demo page opened with the viewer token: live NAV/tape stream works, KILL/Settings controls hidden, `viewer` pill visible
- [x] Operator page unchanged in behaviour (Settings save, promote-shadow, kill dialog)
- [x] `hydra --check` fails when the two tokens are equal

## Risk Assessment
- **Deny-by-default 403s a route the UI still needs** -> signal: 403 in DevTools on an action that used to work; response: add the route to the policy table explicitly, never relax the default.
- **Per-role frame doubles snapshot cost** -> bounded: two JSON.stringify per 250 ms only when both roles are connected; measured today at <2 ms per frame on this workstation (Phase 7 evidence). If p95 tick > 50 ms, build the operator frame and derive the viewer frame by deleting `logs` before stringify.
