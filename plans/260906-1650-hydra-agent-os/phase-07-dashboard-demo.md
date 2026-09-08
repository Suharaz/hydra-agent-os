---
phase: 7
title: "Dashboard + demo scenarios + submission"
status: pending
priority: P1
effort: "1.5d"
dependencies: [4, 5, 6]
---

# Phase 7: Dashboard + demo scenarios + product package

## Overview
Local-only dashboard (token-protected, `127.0.0.1`) with operational panels plus Settings (per-agent model, shadow model, budgets) and A/B panels, scripted demo scenarios, README and demo material. Scenarios exercise real Agent OS components where possible (Skills HTTP audit, `baw tracker` read-only if installed, MCP `tools/list` if bridge works) and label mocks explicitly. <!-- Updated: Validation Session 1 - Settings/A-B, no deadline -->

## Requirements
- Functional dashboard: bound to `127.0.0.1:8787`; every `/api/*` and `/ws` requires `Authorization: Bearer <DASHBOARD_TOKEN>` (or `?token=` for the WS handshake) and `Origin` check; `/api/kill` POST requires token + `confirm=KILL`, logs caller; ledger reads use the read-only sqlite connection; snapshots built only when ≥1 client connected, at 250 ms, with `bufferedAmount` check (drop frame if > 1 MB).
- Functional panels: (1) venue matrix + latency p50/p95; (2) book/mark/liq tape; (3) engines table (enabled/paper, size, budget, params, contracts, PnL 24h, hit-rate); (4) kernel/guardian log; (5) agents timeline with **model id** and role (primary/shadow) per run, cost, decision; (6) positions & orders + kill lock banner; (7) payments in/out + LLM/data spend vs budgets; (8) kill button; (9) **Settings**: per agent — model, shadow model, fallbacks, temperature, interval; global — `llm_daily_budget_usd`, `data_daily_budget_usd`; "Promote shadow → primary" button; model id validated client+server (`^[a-z0-9-]+/[a-z0-9._:-]+$`), optional live check against `GET https://openrouter.ai/api/v1/models`; (10) **A/B**: per agent, table primary vs shadow over 1/7/30 days from `abMetrics()` — runs, cost, p50 latency, schema-valid %, tool-reject %, agreement %, PnL-1h; sparkline of agreement over time.
- Functional write endpoints (token, actor `operator`, logged to `config_changes`): `PUT /api/config/agents` (partial per-agent patch → `config.writeAgents`), `PUT /api/config/budgets` (two keys → `config.writeBudgets`), `POST /api/config/agents/:agent/promote-shadow`. No endpoint writes safety caps, `allowed_symbols`, or `kill.lock`.
- Functional scenarios `cli scenario <n>`: 1 liquidation-fade replay → demo-fapi order; 2 Commander regime change (manual run, shows model id) → `engines.yaml` diff; 3 Supervisor tighten → Guardian kill → per-venue flatten → kill lock → `cli unkill`; 4 smart-money paper mirror with **real** Skills HTTP audit FAIL → veto; 5 external agent buys signal via x402 (mock, labelled); 6 MCP `tools/list` + read call.
- Functional product package: README (pitch; Agent OS components table with real-vs-mock per mode; two-speed architecture; safety model; per-agent model + shadow A/B config; modes; quick start; runbook for 418/kill; limitations & unverified items; roadmap), `docs/video-script.md`, `docs/agent-os-usage.md`, LICENSE, `.env.example`, public GitHub. Hackathon submission (X reply + survey) uses whatever is complete at the time; not a gate.
- Functional: regenerate `hydra-overview.html` from the final plan (6 engines, REST kill switch, `engines.yaml`, Guardian, Skills HTTP) so the README embed matches the code.

## Architecture
```
src/dashboard/server.ts, public/index.html
src/cli.ts (scenario runner)
docs/{video-script.md, agent-os-usage.md}, README.md, hydra-overview.html (regenerated)
```

## Related Code Files
- Create: `src/dashboard/{server.ts,public/index.html}`, `docs/*.md`
- Modify: `README.md`, `src/cli.ts`, `src/main.ts`, `hydra-overview.html`
- Create: `test/dashboard/{auth,api}.test.ts`

## Implementation Steps
1. `server.ts`: auth middleware; read-only connection; on-demand snapshots; `/api/state`, `/api/ledger/pnl`, `/api/agents/runs`, `/api/agents/ab`, `/api/config/engines`, `/api/config/agents` (GET/PUT), `/api/config/budgets` (GET/PUT), `/api/config/agents/:agent/promote-shadow`, `/api/kill`.
2. `index.html`: panels 1–10; Settings form with optimistic update + server validation errors; A/B table.
3. Scenarios 1–5; 6.
4. README, docs, checklist; regenerate overview HTML.
5. Video script: 0:00 hook; 0:20 architecture; 0:45 scenario 1; 1:20 scenario 3; 1:50 scenario 2 + Settings model swap + A/B panel; 2:20 scenario 4 (real audit) + 5 (x402 mock); 2:45 close + repo.

## Success Criteria
- [x] Dashboard refuses requests without token; panels show live demo data; agents panel lists 5 agents with distinct model ids and shadow rows
- [ ] Settings: change Commander model → next run uses it (no restart); set shadow → A/B panel populates after two runs; PUT with actor other than operator or with a safety-cap key → 403/400; `config_changes` row per save — PARTIAL: 400/403 + config_changes verified live; "next run uses it" GATED on OPENROUTER_API_KEY
- [x] `cli scenario 1..5` complete with expected state and narration — 1,3,4,5 OK offline; 2,6 print documented skip (GATED on OPENROUTER_API_KEY / MCP OAuth)
- [ ] README quick start passes on a clean clone (Phase 8)
- [x] `hydra-overview.html` matches plan decisions (reviewed against Key Decisions list)

## Risk Assessment
- No live cascade during recording → scenario 1 replay by default, `--live` waits for a real one.
- Judges can't run `baw`/MCP → README table marks exactly what is real in demo.
