---
title: "Dashboard security hardening: sessions, roles, abuse controls, audit"
description: "Close the real gaps in the operator dashboard's access model: token-in-URL and localStorage exposure, single all-powerful role, no lockout, no persisted audit of dashboard actions, fake KILL on the demo page. Keep the local-only/loopback design; add a supported remote path (SSH tunnel) without loosening code."
status: completed
priority: P1
effort: 2d
tags: [security, dashboard, auth, audit, hardening]
blockedBy: []
blocks: []
created: 2026-09-08
---

# Dashboard security hardening

## Current state (measured, not assumed)

What already exists in `src/dashboard/server.ts` (verified 2026-09-08):

| Control | Status | Where |
|---|---|---|
| Bind loopback only (`127.0.0.1`) | present | `start()` hostname default; not env-configurable |
| Bearer token on every `/api/*` and `/ws` | present | `authorize()`; `tokenMatches()` is constant-time (sha256 + `timingSafeEqual`) |
| Origin pinned to `localhost:<bound port>` | present | `originAllowed()`; foreign origin -> 403 even with valid token |
| Kill needs `{confirm:"KILL"}` + logs caller | present | `POST /api/kill` |
| Safety caps, `allowed_symbols`, paper->live, `kill.lock` clear | **not writable via dashboard at all** | `writeAgents`/`writeBudgets` only; unkill is CLI-only |
| "Shut down the server" endpoint | **does not exist** | only SIGINT/SIGTERM in `main.ts` |
| Tests | present | `test/dashboard/auth.test.ts` (401/403/ws) |

So the premise "anyone can set everything and stop the server" is false for a stranger on the network: the port is loopback-only and the token is required. The real exposure is narrower and is the subject of this plan:

| # | Gap | Evidence | Impact |
|---|---|---|---|
| G1 | Token travels in the URL (`/?token=...` on the demo page, `/ws?token=...` for both UIs) and is persisted in `localStorage` | `hydra-demo.html:1569-1575`, `public/index.html:145,167` | leaks into browser history, proxy/OS logs, screenshots, screen-share; XSS on either page = full operator token theft |
| G2 | No token strength rule; `DASHBOARD_TOKEN=hydra-demo-token` accepted silently | `core/env.ts:132-142` only checks non-empty in live | guessable token + G3 = trivial local brute force |
| G3 | No throttle/lockout on failed auth | `authorize()` | any local process (malware, another user on the box) can brute-force |
| G4 | One role: the presentation page (`/`, `hydra-demo.html`) holds the same full-operator token as Settings | `server.ts:456-458` | a screen-share of the demo page = operator credential |
| G5 | `POST /api/dream/run` is a write (spends LLM budget) with no confirm, no persisted actor | `server.ts:521-524` | budget burn via a stolen session |
| G6 | No response security headers (CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`) | all handlers | clickjacking of KILL/Settings; inline-script XSS surface |
| G7 | Dashboard actions are not persisted as an audit trail: `config_changes.actor` is the literal `"operator"`, kill is log-only | `server.ts:556,573,587,599` | cannot answer "who changed the Commander model at 03:12" |
| G8 | No server-side session -> "logout" is client-only, no revocation short of restart, no session TTL | `index.html:161` | stolen token valid until process restart |
| G9 | Demo page `toggleKill()` is theatre: toasts "positions flattened" without calling `/api/kill` | `hydra-demo.html:1362-1373` | operator believes the system is flat when it is not |
| G10 | No documented safe remote path; a tunnel (cloudflared/ngrok) 403s on Origin, tempting someone to loosen the check | README `Network exposure` | the pressure to add `0.0.0.0` is the highest-blast-radius mistake available |
| # | Goal | Priority |
|---|---|---|
| 1 | No credential in any URL or `localStorage`; HttpOnly cookie sessions with TTL, logout, revoke-all; short-lived one-time WS tickets | P1 |
| 2 | Two roles (viewer / operator); the demo page runs as viewer; every mutating route is operator-only | P1 |
| 3 | Brute-force lockout, body-size cap, WS client cap, security headers incl. hash-based CSP | P1 |
| 4 | Persisted `dashboard_audit` ledger table for login/logout/lockout/every mutation, joined to `config_changes` via session id; `hydra audit` CLI | P2 |
| 5 | Loopback bind enforced in code; SSH-tunnel runbook; demo KILL is real or clearly labelled simulation | P2 |
| 6 | Regression tests for every control above; `security_scan` on `src/dashboard` clean | P1 |

## Phases

| # | Phase | Status | Depends on |
|---|---|---|---|
| 1 | [Sessions, tickets, token hygiene, headers](./phase-01-start.md) | Completed | - |
| 2 | [Roles and least privilege](./phase-02-roles-and-least-privilege.md) | Completed | 1 |
| 3 | [Abuse controls and audit trail](./phase-03-abuse-controls-and-audit-trail.md) | Completed | 1 |
| 4 | [Remote access runbook, demo truthfulness, verification](./phase-04-remote-access-runbook-demo-truthfulness-verification.md) | Completed | 2, 3 |
Phases 2 and 3 are independent once 1 lands.

## Key decisions

- **Keep bearer, add cookie sessions.** `Authorization: Bearer <token>` stays for curl/tests/CLI. Browsers use `POST /api/login` -> `hydra_session` cookie (`HttpOnly; SameSite=Strict; Path=/; Secure` when https). Sessions live in a process `Map<sessionId, Session>`; restart revokes all. No persistence on purpose: a crash-restart should never resurrect a session.
- **WS auth = one-time ticket.** `POST /api/ws-ticket` (any authenticated session) returns `{ticket, ttlMs: 30000}`; `/ws?ticket=` consumes it (single use). `?token=` on `/ws` is removed. A ticket in a log is worthless 30 s later.
- **Two tokens, two roles.** `DASHBOARD_TOKEN` = operator; optional `DASHBOARD_VIEWER_TOKEN` = viewer (read-only). Role is bound to the session at login. GET/WS = viewer or operator; PUT/POST = operator. Kill stays operator + `confirm:"KILL"`, no extra step-up: the safe direction must stay one click.
- **Lockout is global, not per-IP.** Everything arrives from `127.0.0.1`, so per-IP buckets are meaningless. 5 failures / 60 s -> 429 for 60 s on `/api/login` and bearer paths; alert via `core/alert.ts`.
- **CSP by script hash.** Both HTML files keep their single inline `<script>`; the server computes `sha256` of the inline script once at start and emits `script-src 'sha256-...'`. Inline `onclick=` attributes in `hydra-demo.html` are refactored to `addEventListener` (mechanical) so no `'unsafe-inline'`/`'unsafe-hashes'` is needed.
- **Audit in the ledger, not in logs.** New table `dashboard_audit`; `config_changes.actor` becomes `operator:<session8>` so the two tables join. Logs stay as they are.
## Success Criteria

- [x] `grep -n "token=" src/dashboard/public/index.html hydra-demo.html` returns nothing; `localStorage` no longer holds a credential
- [x] Viewer session: every `PUT`/`POST` under `/api/*` -> 403; snapshot omits `logs`
- [x] 6th wrong token within 60 s -> 429 on login and bearer; alert emitted once per lockout
- [x] Every HTML/API response carries `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; API adds `Cache-Control: no-store`
- [x] `dashboard_audit` row for login, logout, lockout, agents PUT, budgets PUT, promote-shadow, kill, dream/run; `config_changes.actor` = `operator:<session8>`
- [x] `createDashboard({hostname:"0.0.0.0"})` throws in production wiring
- [x] Demo page KILL either calls `/api/kill` (operator session) with a confirm dialog or shows a persistent `SIMULATION` badge and no "flattened" toast
- [x] `bun test test/dashboard` green; `security_scan` scoped to `src/dashboard` reports no High/Critical
- [x] README security section documents the threat model, the two tokens, and the SSH-tunnel runbook; explicitly lists `0.0.0.0`/cloudflared/ngrok as unsupported

## Related plan

`plans/260906-1650-hydra-agent-os/phase-08-verification-hardening.md` item "LAN curl test of dashboard" is absorbed by Phase 4 here (loopback assertion + test). Phase 8 there is annotated to point at this plan.

<!-- slug: dashboard-security-hardening -->
