---
phase: 4
title: "Remote access runbook, demo truthfulness, verification"
status: pending
priority: P2
effort: "0.35d"
dependencies: [2, 3]
---

# Phase 4: Remote access runbook, demo truthfulness, verification

## Overview
Close the two human-facing gaps: the missing supported remote path (G10) and the demo page's fake kill (G9). Then run the whole-surface verification (tests, security scan, browser pass) and update the older plan's Phase 8 checklist.

## Requirements
- Functional docs (`README.md` "Security model" section, replaces the two-line "Network exposure" note; `docs/agent-os-usage.md` cross-link):
  - Threat model table: local attacker with a browser (token theft, XSS, clickjacking), local malicious process (brute force, session reuse), remote attacker (nothing reachable), operator mistake (fake kill, weak token).
  - Two tokens, roles, session lifetime, lockout numbers, audit table, `hydra audit`.
  - Remote access = SSH port-forward only: `ssh -N -L 8787:127.0.0.1:8787 user@vps` then open `http://127.0.0.1:8787/` locally; Origin stays `127.0.0.1:8787` so no code path is loosened. State explicitly: `0.0.0.0` binding, cloudflared/ngrok tunnels and reverse proxies are unsupported by design (`createDashboard` throws), and why (plaintext HTTP, Origin pin, no TLS in-process).
  - Runbook: lost token -> rotate `DASHBOARD_TOKEN` in `.env`, restart (all sessions revoked); suspected session theft -> `POST /api/sessions/revoke-all` or restart; locked out -> wait 60 s, or `hydra kill` from the shell if the system must be flat now.
- Functional demo page (`hydra-demo.html`):
  - When connected with an operator session: KILL button opens a confirm dialog (typed `KILL`), calls `POST /api/kill {confirm:"KILL", reason:"demo page"}`, and shows the real `result`/`lock` from the response; the button then reads "KILL LOCK ACTIVE (unkill via CLI)" and is disabled. No "positions flattened" toast unless the response says so.
  - When connected as viewer: KILL hidden (Phase 2).
  - When not connected to a backend (static open): button labelled `SIMULATION` with a persistent badge; toast text says "simulation only".
- Functional verification:
  - `bun test` (full suite, once, at the end of this plan).
  - `security_scan` (`target_kind: scoped_path`, `include_paths: ["src/dashboard", "src/core/env.ts", "hydra-demo.html"]`) -> no High/Critical; findings triaged into `docs/evidence/security-scan-<date>.md`.
  - Browser pass on `/`, `/classic` as viewer and operator: login, WS live, Settings save (operator), 403 on write (viewer), lockout, logout, audit panel, kill dialog cancel path. Screenshots into `docs/evidence/dashboard-security/`.
  - LAN check: `curl -m 3 http://<this-machine-lan-ip>:8787/` from another device (or `Test-NetConnection` on Windows) -> connection refused. Record in evidence.
- Functional plan hygiene: `plans/260906-1650-hydra-agent-os/phase-08-verification-hardening.md` success-criteria line "dashboard unreachable from LAN" gets `-> see plans/260908-1449-dashboard-security-hardening (Phase 4)`.

## Architecture
No new modules. Demo page gains a `backendMode: "operator" | "viewer" | "offline"` state variable set by the login/ticket flow from Phase 1-2; `toggleKill()` becomes `requestKill()` branching on it.

## Related Code Files
- Modify: `README.md`, `docs/agent-os-usage.md`, `hydra-demo.html`, `plans/260906-1650-hydra-agent-os/phase-08-verification-hardening.md`
- Create: `docs/evidence/security-scan-<date>.md`, `docs/evidence/dashboard-security/*.png`

## Implementation Steps
1. README security section + runbook; `docs/agent-os-usage.md` link.
2. `hydra-demo.html`: `backendMode`, `requestKill()`, SIMULATION badge.
3. Full test run; fix anything red that this plan caused.
4. `security_scan` scoped run; triage; evidence file.
5. Browser pass (both roles, both pages) with screenshots; LAN refusal check.
6. Annotate the older plan's Phase 8 line.

## Success Criteria
- [x] README "Security model" present with threat table, roles, SSH runbook, unsupported-exposure statement
- [x] Demo page: operator kill produces a `dashboard_audit.kill` row and a `kill.lock`; offline page shows `SIMULATION`
- [x] `bun test` green; `security_scan` no High/Critical; evidence files committed
- [x] LAN curl/`Test-NetConnection` refused; recorded
- [x] Phase 8 of the original plan points here

## Risk Assessment
- **Operator triggers a real kill from the demo page by habit** -> mitigated by the typed `KILL` confirm and the persistent lock state; the kill direction is safe by design (flat + lock), and unkill remains CLI-only.
- **`security_scan` flags the demo page's remaining inline script** -> expected; the CSP hash covers it; document as accepted in the triage file, do not split the page into external assets just to satisfy a scanner.
