---
phase: 3
title: "Abuse controls and audit trail"
status: pending
priority: P1
effort: "0.5d"
dependencies: [1]
---

# Phase 3: Abuse controls and audit trail

## Overview
Make brute force and resource abuse fail loudly (G3) and make every dashboard action attributable after the fact (G7): lockout, body/WS caps, a `dashboard_audit` ledger table joined to `config_changes`, and a `hydra audit` CLI.

## Requirements
- Functional lockout: a global failed-auth counter (wrong bearer, wrong login token, bad/expired ticket). 5 failures within 60 s -> every auth attempt answers `429 Retry-After: 60` for 60 s; successful auth is impossible during lockout (no "correct guess slips through"). On entering lockout: one `alert("warn", "dashboard auth lockout: 5 failures in 60 s")` via `core/alert.ts` and one `dashboard_audit` row. Counter and lockout are in-memory; restart clears them.
- Functional caps: `hono/body-limit` 64 KB on `/api/*`; WS clients capped at 8 (9th upgrade -> `503`); one WS ticket in flight per session (issuing a new one invalidates the previous).
- Functional audit table (ledger, write-through like `orders`):
  ```sql
  CREATE TABLE IF NOT EXISTS dashboard_audit (${BASE},
    session TEXT NOT NULL,        -- first 8 chars of session id, or 'bearer', or '-' (unauthenticated events)
    role TEXT NOT NULL,           -- viewer | operator | -
    action TEXT NOT NULL,         -- login | logout | revoke_all | lockout | agents_put | budgets_put | promote_shadow | kill | dream_run | auth_fail
    status INTEGER NOT NULL,      -- HTTP status returned
    ua TEXT NOT NULL,
    detail TEXT);                 -- JSON: request body digest (sha256 of canonical JSON) + result summary; never the raw token
  CREATE INDEX IF NOT EXISTS ix_dashboard_audit_wall ON dashboard_audit(ts_wall);
  ```
  `Ledger.insertDashboardAudit(row)`; `LedgerReader.dashboardAudit(limit, since?)`.
- Functional attribution: `writeAgents` / `writeBudgets` are called with actor `operator:<session8>` (type widens from the literal `"operator"` to `` `operator:${string}` ``; `OPERATOR_ONLY` check becomes a prefix check). `config_changes.actor` therefore joins to `dashboard_audit.session`. Kill row: `detail = {reason, result}`.
- Functional read surface: `GET /api/audit?limit=50&since=<ms>` (operator only) and CLI `hydra audit [--tail N] [--since ISO]` printing one line per row (`ts role session action status detail`). Dashboard `index.html` gets an "Audit" panel (last 50 rows, 15 s refresh) next to the existing agents timeline.
- Functional loopback assertion: `createDashboard` throws `DashboardBindError` when `hostname` is not in `{127.0.0.1, localhost, ::1}` unless `deps.allowNonLoopbackForTests === true`. `wiring.ts` never sets the flag.
- Non-functional: audit insert is one prepared-statement `run()` on the mutation path; nothing added to the snapshot tick.

## Architecture
```
authorize() ── fail ──> lockout.record() ──> (5th) alert + audit(lockout) + 429 window
mutating route ──> handler ──> audit(action, status, detail{bodyDigest,...})
writeAgents(dir, patch, `operator:${session8}`, ledger) ──> config_changes.actor
```
`src/dashboard/lockout.ts`: `class Lockout { constructor(opts:{max:5, windowMs:60_000, lockMs:60_000, now?}) fail(): boolean /* true when lock just engaged */ locked(): number /* ms remaining or 0 */ }`. Pure, unit-tested with a fake clock.

## Related Code Files
- Create: `src/dashboard/lockout.ts`, `src/cli/audit.ts`, `test/dashboard/lockout.test.ts`, `test/dashboard/audit.test.ts`
- Modify: `src/core/ledger.ts` (table, `insertDashboardAudit`, reader `dashboardAudit`, `TABLES` list), `src/core/config.ts` (actor type + prefix check), `src/dashboard/server.ts` (lockout wiring, body-limit, WS cap, audit calls, `/api/audit`, bind assertion), `src/dashboard/public/index.html` (Audit panel), `src/cli.ts` (register `audit`), `src/wiring.ts` (no flag), `test/core/config.test.ts` (actor prefix), `test/dashboard/helpers.ts`

## Implementation Steps
1. `lockout.ts` + unit test (window slide, lock engage exactly once, expiry).
2. `ledger.ts`: table, insert, reader; `ledger.test.ts` gets one row-roundtrip case.
3. `config.ts`: actor type `operator:${string}`; `OPERATOR_ONLY` -> `isOperatorActor()`; update the two dashboard call sites and `test/core/config.test.ts`.
4. `server.ts`: `Lockout` in `authorize()`; audit helper `audit(c, action, status, detail)`; call it in login/logout/revoke-all/agents PUT/budgets PUT/promote-shadow/kill/dream-run; `bodyLimit` on `/api/*`; WS cap in `fetch()` before `upgrade`; ticket-per-session rule in `SessionStore.issueTicket`; `GET /api/audit`; bind assertion at the top of `createDashboard`.
5. `cli/audit.ts` reading through `openReadOnly` (works while HYDRA is running, like `export-ledger.ts`).
6. `index.html` Audit panel.
7. Tests: lockout via 6 wrong bearers -> 429 even with the right token, `Retry-After` present, audit row `lockout`; 65 KB PUT -> 413; 9th WS -> 503; PUT agents leaves `config_changes.actor = operator:<session8>` and a `dashboard_audit.agents_put` row with the same session; `/api/audit` viewer -> 403; `createDashboard({hostname:"0.0.0.0"})` throws; `hydra audit --tail 3` prints 3 lines.

## Success Criteria
- [x] `bun test test/dashboard test/core/config.test.ts test/core/ledger.test.ts` green
- [x] Manual: 6 wrong tokens on the login form -> "locked, retry in 60 s" message; Telegram/webhook (or log fallback) shows the alert once
- [x] `sqlite3 state/ledger.db "select session, action, status from dashboard_audit order by id desc limit 5"` shows the last five actions after a Settings save + kill drill
- [x] `hydra audit --tail 20` output matches the Audit panel

## Risk Assessment
- **Lockout as a denial-of-service against the operator** (malware on the box spams wrong tokens so the human cannot log in) -> accepted and bounded: 60 s windows, the kill switch is still reachable via `hydra kill` CLI (file lock path, no HTTP). Document in the runbook.
- **`config_changes.actor` type widening breaks `OwnerError` messages/tests** -> `test/core/config.test.ts` updated in the same step; agents' `EngineWriter` actors untouched.
- **Audit row written before the handler result is known** -> write after the handler with the final status; wrap in `try/finally` so a thrown handler still produces a `500` row.
