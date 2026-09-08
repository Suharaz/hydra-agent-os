---
phase: 3
title: "Risk Kernel + Guardian + Executor + kill switch"
status: pending
priority: P1
effort: "1.5d"
dependencies: [1]
---

# Phase 3: Risk Kernel + Guardian + Executor + kill switch

## Overview
Deterministic safety and execution layer. Every `Intent` passes the Risk Kernel before the Executor sends it. A code-owned Guardian runs every second regardless of engines or LLM availability and triggers the kill switch. Kill switch is REST-based, per venue, retry-until-flat, and records a kill lock that only a human can clear.

## Requirements
- Functional kernel rules (first fail wins): 0 no `kill.lock`; 1 engine enabled and effective size cap > 0; 2 symbol ∈ `risk.yaml.allowed_symbols[venue]`; 3 global orders/sec token bucket; 4 notional ≤ min(per-engine cap, `budgets.json[engine]`) − open notional; 5 post-trade net delta; 6 post-trade leverage; 7 liq distance (futures); 8 daily drawdown; 9 on-chain audit PASS fresh + on-chain cap; 10 `book.synced && ageMs < 2000` for LIMIT intents on that symbol (else downgrade to skip).
- Functional: multi-leg intents all-or-nothing across venues; rollback per venue type (futures reduce-only MARKET; spot MARKET opposite side sized to fill; DEX `adapter.swap` reverse or record residue). If rollback fails → kill with reason `rollback_failed`.
- Functional Guardian (`guardian.ts`, 1 s): computes NAV, unrealized, daily drawdown from positions+marks+`pnl_daily`; breaches `daily_drawdown_kill_pct` → `system.kill`; NAV change > `nav_jump_alert_pct` in 1 min → pause all engines (`limits.json` overlay actor `guardian`) + alert; upserts `pnl_daily.max_dd_bps` hourly. Runs even when cold lane is disabled (OpenRouter 402, budget cap).
- Functional kill switch: cancel all open orders (futures per-symbol `DELETE /fapi/v1/allOpenOrders`; spot `DELETE /api/v3/openOrders`), flatten futures (reduce-only MARKET), flatten spot (MARKET SELL base assets held by engines to 0, from `/api/v3/account` + ledger attribution), DEX residue reported (reverse swap in live if adapter supports, else logged); verify per venue (`positionRisk` all 0; spot engine-attributed base balances 0); retry loop with backoff until flat or operator stop, **no 3-attempt cap**; alert after `kill_verify_attempts_before_alert`; bypasses executor throttle pause and rule-3 bucket; writes `state/kill.lock` with residue; idempotency = re-verify flat and re-flatten residue, never "already ran".
- Functional limits overlay: `limits.tighten` validates monotone against **current effective limits** (min of risk.yaml, existing overlay); overlay `expires_at` honoured only when no `kill.lock`; Guardian pause overlay has actor `guardian`.
- Functional boot recovery: on start read `openOrders`, `positionRisk`, `account`; match `hydra-<engine>-<intentId>` client ids to ledger; rebuild executor/TP-SL watcher state; unknown HYDRA-prefixed orders are cancelled; if `kill.lock` exists → engines stay locked, banner, alert.
- Functional: `cli unkill` refuses unless `reconcile` reports zero residue and prints the lock reason; `cli promote <engine>` is the only path from `paper:true` to `paper:false` in live (demo allows agents to toggle for scenarios).
- Non-functional: kernel < 20 µs typical; `orders` write-through before REST send; `latency_ms = (t_ack − t_signal)/1e6` stored.

## Architecture
```
src/hot/positions.ts   # positions from fills + 10 s REST reconcile; FIFO round-trip → trades + pnl_daily
src/hot/kernel.ts      # rules 0–10
src/hot/guardian.ts    # 1 s loop; drawdown/NAV breakers; independent of engines/LLM
src/hot/executor.ts    # venue orders; legs; per-venue rollback; TP/SL; throttle pause (kill exempt)
src/hot/kill.ts        # per-venue cancel/flatten/verify loop; kill.lock; alerts
src/hot/recovery-boot.ts
src/hot/audit-cache.ts # fed by skills-http (Phase 2)
src/core/limits.ts     # effective = min(risk.yaml, overlay); tighten-only vs effective
src/venues/binance/exchange-info.ts
```
Rules table:
| # | Rule | Source |
|---|---|---|
| 0 | no kill lock | `state/kill.lock` |
| 1 | engine enabled && effective size > 0 | engines.yaml + limits overlay |
| 2 | symbol ∈ allowed_symbols[venue] | risk.yaml (code-owned) |
| 3 | orders/sec ≤ cap | risk.yaml |
| 4 | notional ≤ min(engine cap, budget) − open | risk.yaml + budgets.json + positions |
| 5 | post-trade net delta ≤ cap | positions + mark |
| 6 | post-trade leverage ≤ cap | positions + NAV |
| 7 | liq distance ≥ cap | positionRisk / maintenance estimate |
| 8 | daily drawdown < kill pct | pnl_daily + marks |
| 9 | on-chain audit fresh PASS, notional ≤ on-chain cap | audit-cache |
| 10 | book synced & fresh for LIMIT | feed-hub |

## Related Code Files
- Create: `src/hot/{positions,kernel,guardian,executor,kill,recovery-boot,audit-cache}.ts`, `src/core/limits.ts`, `src/venues/binance/exchange-info.ts`
- Create: `test/hot/{kernel,executor-rollback,kill-per-venue,guardian,limits-tighten,recovery-boot}.test.ts` with a fake REST server (`Bun.serve`) for `/fapi/v1/order`, `allOpenOrders`, `positionRisk`, `/api/v3/order`, `openOrders`, `account`, `userTrades`, `myTrades`
- Modify: `src/main.ts`, `src/cli.ts` (`intent`, `kill`, `unkill`, `promote`), `rest-futures.ts`, `rest-spot.ts`

## Implementation Steps
1. `exchange-info.ts`: filters + rate limits; `round()`.
2. `positions.ts`: apply user-data events; reconcile 10 s; FIFO round-trip closer writes `trades` + upserts `pnl_daily`; `snapshot()` reused struct.
3. `limits.ts`: `effective()`; `tighten(overlay, actor)` monotone vs effective; expiry rules.
4. `kernel.ts`: rules 0–10 as array; ledger `vetoes`; `kernel.veto` event.
5. `executor.ts`: `submit()` — ledger `insertOrderPending` → REST → `updateOrderAck` (latency); legs sequential; per-venue rollback; TP/SL: futures reduce-only orders, spot watcher (state rebuilt by recovery-boot); 429/418 → pause + `system.throttle` (kill exempt).
6. `kill.ts`: as required; `alert()` on threshold; `system.kill.failed` while residue persists; loop continues in background until flat.
7. `guardian.ts`: 1 s loop; breakers; hourly `pnl_daily` max-dd.
8. `recovery-boot.ts`: as required; run before engines start.
9. CLI: `intent`, `kill`, `unkill` (requires reconcile clean), `promote` (live: human only).
10. Tests: each kernel rule; rollback where leg 2 (spot) fails after leg 1 (futures) filled → futures reduce-only sent; kill with 1 futures + 1 spot position ends flat on both fake venues; kill under 418 keeps retrying and alerts; Guardian kills at 4.1% with engines idle; overlay looser than current effective rejected; kill.lock survives an overlay write; boot recovery rebuilds a spot TP/SL watcher from an open order.

## Success Criteria
- [x] `bun test test/hot` green; kernel evaluate p99 < 50 µs (100k-iteration bench)
- [ ] On demo-fapi + testnet spot: `cli intent` places, fills, TP/SL present; `cli kill` flattens both venues ≤5 s and writes `kill.lock`; `cli kill` again re-verifies (not a no-op); `cli unkill` refuses until reconcile clean — GATED: needs venue keys; kill/unkill drill unverified on real venue
- [x] With `OPENROUTER_API_KEY` unset, Guardian still kills at simulated drawdown (test + manual)
- [ ] Restart mid-session recovers open orders/positions without duplicates — GATED: restoreFromFills implemented + offline test; real restart drill pending

## Risk Assessment
- Spot flatten of engine-attributed balances depends on ledger attribution; if attribution is unknown, kill flattens all non-quote balances only when `KILL_FLATTEN_ALL_SPOT=1` (documented; default off in live, on in demo).
- 418 IP ban up to days → kill loop keeps retrying; alert fires; operator must act via Binance UI (documented runbook in README).
- Spot testnet has no OCO guarantee across resets → watcher + boot recovery.

## Open findings (independent review 2026-09-07, `'C:\Users\Admin\.omp\agent\sessions\-Desktop-Vibe Coding-Binance\2026-09-06T04-04-54-907Z_01a074e4-01fb-7423-8052-37062ad6523e\SafetyReview.md'` + `'C:\Users\Admin\.omp\agent\sessions\-Desktop-Vibe Coding-Binance\2026-09-06T04-04-54-907Z_01a074e4-01fb-7423-8052-37062ad6523e\FinalReview.md'`)
Closed with regression tests: S01–S08, S10–S12, S14. Still open, blocking real-money use (not the paper demo):
- [ ] S09 — fill-driven TP/SL lifecycle: zero-fill futures ACK defers protection with no fill listener; partial fills protect only acked qty (`src/hot/executor.ts` placeProtection)
- [ ] S13 — validated close path: rules 1/8 must not veto exposure-reducing exits; `Engine.close()` must keep tracking until the exit confirms; live futures exits need `reduceOnly` (`src/hot/kernel.ts` r1/r8, `src/hot/engines/engine.ts` close)
- [ ] Demo NAV=0 without venue keys: rules 5–7 veto everything unless a scenario seeds cash (`src/hot/positions.ts` cash) — decide a documented demo bankroll or a keyless paper-NAV policy
