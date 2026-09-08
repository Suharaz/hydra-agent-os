---
phase: 8
title: "Verification + hardening"
status: pending
priority: P1
effort: "1d"
dependencies: [7]
---

# Phase 8: Verification + hardening

## Overview
Prove the system end-to-end on demo venues, run a soak, measure latency, review secrets/permissions/supply chain, and produce the evidence bundle.

## Requirements
- Functional: clean-clone quick start passes on Windows (native Bun) and Linux/WSL.
- Functional soak: 6 h in demo (shadow A/B enabled on Commander): no unhandled rejections; WS drop recovery yields no duplicate fills; `reconcile.ts` diff = 0 at end; memory flat; `agent_runs` shadow rows and `pnl_1h_usd` back-fill present. <!-- Updated: Validation Session 1 -->
- Functional latency report: `orders.latency_ms` p50/p95 over ≥30 intents (replay-driven ok); acceptance p95 ≤300 ms from this VN workstation; note VPS target.
- Functional security review: secrets scan of git history; `.env.example` demo-only; live gate; **live API key permission check** at boot (`GET /sapi/v1/account/apiRestrictions`: refuse if `enableWithdrawals` or `permitsUniversalTransfer` true; IP whitelist recommended) — live only (`/sapi` absent on testnet); `BAW_BIN` name/version check; `bun.lock` committed, exact pins for `@binance/*`, `@x402/*`, `@modelcontextprotocol/*`; dashboard bind/token verified with a curl from another host on the LAN (must fail).
- Functional: kill-switch drills ×2 during soak (one under simulated 429), time-to-flat and residue recorded; `cli unkill` path exercised.
- Functional evidence: `docs/evidence/` — screenshots, latency CSV, soak summary, ledger export, reconcile output.

## Related Code Files
- Create: `scripts/{reconcile,latency-report,export-ledger,apikey-check}.ts`, `scripts/soak.sh`, `docs/evidence/README.md`
- Modify: `README.md`, `src/main.ts` (boot apikey-check in live)

## Implementation Steps
1. Fresh clone Windows + WSL; fix docs.
2. `bun test` full; no sleep-based tests.
3. Soak 6 h with scenarios 1,3,4 every 20 min; memory log every 5 min; Settings model swap once mid-soak.
4. Network drop 20 s during open order → exactly one fill row.
5. `reconcile.ts` → 0 diffs.
6. `latency-report.ts` → CSV + p50/p95 in README.
7. Secrets/supply-chain review; `apikey-check.ts`; LAN curl test of dashboard.
8. Kill drills; record.
9. Tag `v0.1.0`, push public; hackathon submission (X reply + survey) if still open.

## Success Criteria
- [ ] Soak: 0 crashes, memory drift < 50 MB, reconcile diff 0, one fill per trade after drop
- [ ] Latency p95 ≤300 ms (document actual); VPS recommendation noted
- [x] Secrets scan clean; live boot refuses over-privileged key; dashboard unreachable from LAN — secrets scan clean; over-privileged/malformed key refused (test); LAN reachability: bound 127.0.0.1, curl-from-LAN not run → absorbed by `plans/260908-1449-dashboard-security-hardening` (Phase 3 bind assertion, Phase 4 LAN check)
- [ ] Evidence bundle committed; tag pushed; submission checklist complete

## Risk Assessment
- Demo venue maintenance → retry soak; record downtime.
- Latency above target due to VN routing → report actual; engines sized for second-scale edges.
