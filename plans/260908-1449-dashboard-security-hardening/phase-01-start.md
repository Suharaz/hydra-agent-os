---
phase: 1
title: "Sessions, tickets, token hygiene, headers"
status: pending
priority: P1
effort: "0.75d"
dependencies: []
---

# Phase 1: Sessions, tickets, token hygiene, headers

## Overview
Get the credential out of URLs and `localStorage` (G1, G8), refuse weak tokens (G2), and put standard security headers on every response (G6). After this phase the only place the raw token ever appears in a browser is the login form's POST body.

## Requirements
- Functional: `POST /api/login` `{token}` -> `204` + `Set-Cookie: hydra_session=<id>; HttpOnly; SameSite=Strict; Path=/` (`; Secure` when the request is https). Wrong token -> `401`. Session id = 32 random bytes base64url.
- Functional: `POST /api/logout` -> deletes the caller's session, clears the cookie. `POST /api/sessions/revoke-all` -> deletes every session (operator only once Phase 2 lands; until then any session).
- Functional: session TTL 12 h idle, 24 h absolute; max 16 live sessions (oldest evicted). Sweep on each auth check (cheap: Map iteration of <=16 entries), no timer.
- Functional: `authorize()` accepts, in order, `Authorization: Bearer` (constant-time compare against the token(s)) or a valid `hydra_session` cookie. Cookie-authenticated **non-GET** requests must carry an `Origin` header (browsers always send it on POST/PUT); missing Origin on a cookie request -> `403`. Bearer requests keep the existing "no Origin is fine" rule for curl/tests.
- Functional: `POST /api/ws-ticket` -> `{ticket, ttlMs:30000}`; ticket = 32 random bytes base64url, single use, stored with `expiresAt` and the issuing session's role. `/ws?ticket=` consumes it; `/ws?token=` is removed. Expired/used/unknown ticket -> `401`.
- Functional: `core/env.ts`: `DASHBOARD_TOKEN` shorter than 24 chars -> hard error in `live`, `warn` in `demo`. Generated demo tokens are already 48 hex chars.
- Functional: response headers on every route (static + api + errors): `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; script-src 'sha256-<index>' 'sha256-<demo>'; style-src 'sha256-<...>' (or 'unsafe-inline' for style only); img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. API responses add `Cache-Control: no-store`.
- Functional: `hydra-demo.html` inline `onclick="..."` attributes (>= 10 occurrences, e.g. lines 616-617) become `data-action` + one delegated `addEventListener`; the file keeps a single inline `<script>` so one hash covers it.
- Functional: both UIs: login form POSTs to `/api/login`; on 401 from any API call show the login form; WS connect = `POST /api/ws-ticket` then `new WebSocket("/ws?ticket=...")`; "token" button becomes "logout" -> `POST /api/logout`. Remove `localStorage.hydra.token` reads/writes and the `?token=` URL parsing in `hydra-demo.html:1569-1571`.
- Non-functional: no allocation on the WS snapshot path changes; auth check is one Map lookup + one constant-time compare.

## Architecture

```
browser ── POST /api/login {token} ──> sessions.create(role) ──> Set-Cookie hydra_session
browser ── GET /api/state (cookie) ──> authorize(): cookie -> sessions.get(id) -> touch() -> ok
browser ── POST /api/ws-ticket (cookie) ──> tickets.issue(role) ──> {ticket}
browser ── WS /ws?ticket=... ──> tickets.consume(t) -> upgrade({data:{role, sessionId}})
curl    ── GET /api/state  Authorization: Bearer ──> tokenMatches -> ok   (unchanged)
```

New module `src/dashboard/session.ts` (pure, testable without a server):

```ts
export type Role = "viewer" | "operator";          // Phase 2 uses viewer; Phase 1 always "operator"
export interface Session { id: string; role: Role; createdAt: number; lastSeenAt: number; ua: string }
export class SessionStore {
  constructor(opts: { idleMs: number; absoluteMs: number; max: number; now?: () => number })
  create(role: Role, ua: string): Session
  get(id: string): Session | null          // null when expired; expired entries are deleted on read
  revoke(id: string): void
  revokeAll(): number
  issueTicket(sessionId: string): string   // 30 s, single use
  consumeTicket(ticket: string): Session | null
}
```

Cookie parsing: one small function `cookie(header, name)` in `session.ts` (no dependency). Hashing for CSP: `new Bun.CryptoHasher("sha256")` over the inline script body extracted once at `createDashboard()` (regex `<script>([\s\S]*?)</script>` on the two files; assert exactly one match each, throw otherwise so a second inline script cannot silently ship un-hashed).

## Related Code Files
- Create: `src/dashboard/session.ts`
- Modify: `src/dashboard/server.ts` (`authorize`, `/api/login`, `/api/logout`, `/api/sessions/revoke-all`, `/api/ws-ticket`, `/ws`, header middleware, CSP hash computation)
- Modify: `src/dashboard/public/index.html` (login/logout/ws-ticket, drop localStorage)
- Modify: `hydra-demo.html` (drop `?token=`/localStorage, ws-ticket, `onclick` -> delegated listeners)
- Modify: `src/core/env.ts` (token length rule), `.env.example` (comment: >= 24 chars)
- Modify: `test/dashboard/helpers.ts` (add `login()` helper returning the cookie), `test/dashboard/auth.test.ts`
- Create: `test/dashboard/session.test.ts`

## Implementation Steps
1. `session.ts`: `SessionStore` with injectable clock; unit tests for idle/absolute expiry, max eviction, ticket single-use and TTL.
2. `server.ts`: header middleware first (`app.use("*")`), then auth middleware. Compute CSP hashes at `createDashboard()`; fail fast if a file has != 1 inline script.
3. `server.ts`: `authorize(req)` returns `{role, sessionId} | Response`. Bearer path unchanged; cookie path via `SessionStore`; Origin rule as specified. Login/logout/revoke-all/ws-ticket routes. `/ws` reads `ticket` only; upgrade data carries `{role, sessionId}` (used by Phase 2 for viewer redaction and Phase 3 for the client cap).
4. `env.ts`: length rule + `.env.example` comment.
5. `index.html`: replace the auth block (lines 145-171) with login POST / logout POST / ws-ticket flow; keep everything else.
6. `hydra-demo.html`: remove lines 1569-1571 token handling; replace WS connect with ticket flow; `onclick` -> `data-action` delegation. Verify the page still renders with no backend (static open from disk) since `fetch` to `/api/*` fails gracefully today.
7. Tests: cookie login flow, cookie POST without Origin -> 403, `/ws?token=` -> 401, ticket reuse -> 401, headers present on `/`, `/api/state`, and a 404.

## Success Criteria
- [x] `grep -n "token=" src/dashboard/public/index.html hydra-demo.html` -> no matches; `grep -n localStorage` -> no credential keys
- [x] `bun test test/dashboard/session.test.ts test/dashboard/auth.test.ts` green
- [x] Browser check (both `/` and `/classic`): login, live snapshot over WS, logout -> next API call 401 -> login form; hard refresh keeps the session (cookie) without re-entering the token
- [x] `DASHBOARD_TOKEN=short bun run hydra --mode live --check` refuses; in demo it warns
- [x] DevTools console shows zero CSP violations on both pages after a full interaction pass (Settings save, A/B tab, kill dialog open/cancel)

## Risk Assessment
- **CSP breaks an inline handler I missed** -> signal: console `Refused to execute inline event handler`; response: fix the handler, never add `'unsafe-inline'` to `script-src`.
- **`SameSite=Strict` blocks the cookie after an external link into the dashboard** -> acceptable: the user just clicks once more; do not downgrade to `Lax`.
- **Tests run the server on port 0 and the Origin check uses the bound port** -> already handled by `allowedPorts` update in `start()`; the cookie path reuses it.
- **Demo page opened from `file://`** -> `fetch('/api/ws-ticket')` throws; wrap exactly like the existing try/catch so the static demo still works offline.
