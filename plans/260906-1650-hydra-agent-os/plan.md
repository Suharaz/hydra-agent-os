---
title: "HYDRA — two-speed autonomous scalping system on Binance Agent OS"
description: "Hot path (pure Bun/TS) trades Spot/Futures/DEX; cold path (5 LLM agents, per-agent OpenRouter model) commands, supervises, funds, learns and sells signals via x402. Demo-first on Spot testnet + Futures demo."
status: in-progress
priority: P1
effort: 9d
issue:
branch: main
tags: [feature, backend, api, trading, agents, payments, critical]
blockedBy: []
blocks: []
created: 2026-09-06
---

# HYDRA — two-speed autonomous scalping system on Binance Agent OS

## Overview

Track A submission for the Binance Agent OS Mini Hackathon. One Bun/TypeScript process with two lanes:

- **Hot lane (code only, ms):** Feed Hub → Signal Engines → Risk Kernel → Executor → Ledger, plus a code-owned **Guardian** (1 s drawdown/NAV breaker) and REST **kill switch**. Binance WS/REST directly (Spot testnet + Futures demo in `demo`; mainnet in `live`). No LLM on this path.
- **Cold lane (LLM agents, minutes):** Commander, Risk Supervisor, Treasurer, Coach, Sales. Each agent has its own OpenRouter model in `config/agents.yaml`. They write engine config, tighten-only limits and budgets that the hot lane hot-reloads; they can never loosen limits, whitelist symbols, promote paper→live, move funds, or clear a kill lock (all code-owned or human-only).
- **Agent OS surface used:** Exchange REST+WS API (core); Skills Hub public HTTP APIs (token audit, leaderboard, token info — no wallet, used in demo too); Agentic Wallet `baw` CLI (DEX leg, x402 buyer, tracker WS; live); x402/B402 (Sales sells signals; Treasurer buys data); Binance MCP (showcase/onboarding via OAuth bridge); `square-post` (draft in demo).

Research: [Binance API](./research/researcher-01-binance-api.md) · [Agent stack](./research/researcher-02-agent-stack.md) · [Red-team findings](./reports/red-team-findings.md).

## Delivery order

Full scope, phases in order, no deadline-driven cut (Validation Session 1). The hackathon submission is a by-product: whatever is complete on 2026-09-08 is submitted as-is; work continues afterwards. Phase 7 keeps README/video as demo material.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | End-to-end demo: liquidation-fade trade on Futures demo, signal→ack **p95 ≤300 ms from this VN workstation** (≤150 ms target on SG/TYO VPS), fills in ledger, visible on dashboard | P1 |
| 2 | Risk Kernel vetoes + Guardian breaker + REST kill switch (per-venue flatten) proven live in demo | P1 |
| 3 | 5 cold-lane agents run on distinct OpenRouter models, hot-reload engine config, budgets, tighten-only limits | P1 |
| 4 | x402 signal endpoint: external agent pays (mock facilitator in demo; B402 or CDP facilitator in live) and receives feed | P2 |
| 5 | On-chain leg (smart-money mirror, CEX↔DEX arb) via `baw` in live; paper adapter + real Skills HTTP audit in demo | P2 |
| 6 | Product package: README, demo video script, dashboard scenarios, Settings panel (per-agent model, shadow A/B, budgets), public GitHub | P1 |

## Phases

| # | Phase | Status | Depends on |
|---|-------|--------|------------|
| 1 | [Foundation: repo, config, modes, bus, ledger, CLI](./phase-01-start.md) | Pending | — |
| 2 | [Feed Hub: Binance WS + on-chain adapters](./phase-02-feed-hub.md) | Pending | 1 |
| 3 | [Risk Kernel + Guardian + Executor + kill switch](./phase-03-risk-kernel-executor.md) | Pending | 1 |
| 4 | [Signal Engines](./phase-04-signal-engines.md) | Pending | 2, 3 |
| 5 | [LLM agents on OpenRouter + MCP bridge](./phase-05-llm-agents-openrouter.md) | Pending | 1, 3 |
| 6 | [Payments (x402) + on-chain (baw)](./phase-06-payments-onchain.md) | Pending | 2, 5 |
| 7 | [Dashboard + demo scenarios + submission](./phase-07-dashboard-demo.md) | Pending | 4, 5, 6 |
| 8 | [Verification + hardening](./phase-08-verification-hardening.md) | Pending | 7 |

Phases 2 and 3 are independent; 4 and 5 overlap once 3 lands.

## Key Decisions

- **Runtime:** Bun 1.3 + TypeScript, single package, `bun:sqlite` ledger (write-through for orders; batched for telemetry). Thin `fetch` client to OpenRouter; no Vercel AI SDK.
- **Safety is code-owned.** Kill lock = `state/kill.lock` (only `kill.ts` writes; cleared only by human `cli unkill` after reconcile). Symbol whitelist and paper→live promotion live in `config/risk.yaml` / human CLI, never in LLM-written files. Guardian (1 s loop) enforces drawdown/NAV breakers independent of any LLM or OpenRouter credit state.
- **Kill switch is REST, per venue, retry-until-flat**, bypasses executor throttle pause; alerts via `ALERT_WEBHOOK_URL` from code. MCP is never on the safety path.
- **Modes:** `HYDRA_MODE=demo|live` with per-venue flags (`SPOT=testnet|live`, `FUTURES=demo|live`, `ONCHAIN=paper|live`, `X402=mock|b402|cdp`, `MCP=off|on`). Engines/kernel/agents identical across modes. Live requires `HYDRA_I_UNDERSTAND_REAL_MONEY=1` and passes an API-key permission check (trade-only, no withdraw/universal transfer).
- **Network exposure:** dashboard/admin bound to `127.0.0.1` with `DASHBOARD_TOKEN`; x402 seller on a separate port exposing only `/v1/*`.
- **Hot lane uses raw WebSocket/fetch**: futures routed `/public`, `/market`, `/private` (verified 101 on demo-fstream); spot WS-API `userDataStream.subscribe.signature`. HMAC keys. Server-time offset per base URL.
- **On-chain:** one `OnchainAdapter` (`PaperAdapter` demo, `BawAdapter` live via pinned `BAW_BIN`) plus `SkillsHttp` for audit/leaderboard/token-info via public `web3.binance.com` endpoints (no wallet; real in demo).
- **Accounts:** hot lane = normal sub-account with master-issued trade-only key. Agentic virtual sub (MCP) is a separate showcase account; MCP balance/transfer scopes do not reach the hot-lane sub, so MCP is not used for reconciliation or funding.
- **No automated fund transfers.** Treasurer allocates budgets only; any transfer is a human CLI/MCP action.
- **Per-agent model is operator-configurable at runtime.** Dashboard Settings panel (token-authenticated human actor) edits `agents.yaml` (model, fallbacks, temperature, interval, `shadow_model`) and the two budget keys in `risk.yaml`; hot-reloaded by the scheduler. Safety caps in `risk.yaml` remain file-only (restart required). LLM agents never write these files.
- **Shadow A/B per agent.** Optional `shadow_model` runs in parallel on the same context; its decision is logged only (never applied). Metrics per model: cost USD, latency, schema-valid rate, tool-rejection rate, agreement % with primary, and engine PnL attributed 1 h after the primary's decision. Visible in the A/B panel; operator promotes B→primary in Settings.
- **Alerts:** Telegram bot (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) from `alert.ts`; generic webhook kept as fallback.

## Success Criteria

- [ ] `bun run hydra --mode demo` boots, connects 3 futures sockets + spot WS-API, dashboard at `127.0.0.1:8787` (token) shows live feed
- [ ] Liquidation replay → engine intent → kernel PASS → demo-fapi order ACK; ledger `orders.latency_ms` p95 ≤300 ms over ≥30 intents (t_signal = local frame receipt, t_ack = REST response)
- [ ] Kernel VETO on leverage breach; Guardian kill at drawdown ≥4% with cold lane disabled; kill flattens futures+spot(+DEX residue report) ≤5 s; `cli kill` re-run verifies flat instead of no-op
- [ ] `agents.yaml` with 5 different `provider/model` ids; `HYDRA_MODEL_COMMANDER` override changes only that agent (`llm_calls.model` proves it); Commander output schema passes strict json_schema
- [ ] Settings panel changes Commander's model without restart; `shadow_model` set → both models' runs appear in `agent_runs` with `role='primary'|'shadow'`; A/B panel shows cost/latency/schema-valid/agreement/PnL-1h per model
- [ ] `curl :8788/v1/signals/liquidation` → 402 → paid request (mock facilitator) → 200 feed; `payments` row present
- [ ] README + demo script + GitHub public + video storyboard; `hydra-overview.html` regenerated to match plan

## Open Questions

- Agentic virtual sub API key: unverified; design does not depend on it.
- Binance MCP DCR for custom OAuth client: unverified; fallback = `claude -p` showcase.
- B402 facilitator credentials: form-gated; live x402 fallback = CDP facilitator (Base mainnet, API keys), never the public Sepolia facilitator.
- `baw` on Windows: unverified; live on-chain documented for Linux/WSL.

## Red Team Review

### Session — 2026-09-06
**Findings:** 32 raw → 15 adjudicated (15 accepted, 0 rejected) + 12 mechanical contract fixes applied in sweep; 1 rejected (MCP bridge kept); 4 lower-severity items folded into accepted ones.
**Severity breakdown:** 5 Critical, 9 High, 1 Medium (adjudicated set)

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Kill lock lives in Supervisor-writable overlay; tighten validated vs base not current | Critical | Accept | Phase 3, 5 |
| 2 | Kill switch shares throttled REST path; idempotency as no-op; no alert channel | Critical | Accept | Phase 3 |
| 3 | Kill/rollback flatten futures only; spot/DEX legs orphaned | High | Accept | Phase 3 |
| 4 | Unauthenticated `/api/kill` + admin API on internet-exposed x402 port | Critical | Accept | Phase 6, 7 |
| 5 | LLM-written `engines.yaml` is the symbol whitelist and paper→live switch | High | Accept | Phase 3, 4, 5 |
| 6 | Treasurer REST transfer unbounded; API key never permission-scoped | High | Accept | Phase 1, 5, 8 |
| 7 | `npx baw` resolves unrelated package; binary unpinned | High | Accept | Phase 2, 6, 8 |
| 8 | 9-day effort vs 2.5-day deadline; no cut line | Critical | Accept → superseded by Validation Session 1 (user removed deadline priority) | plan.md |
| 9 | Treasurer budgets have no consumer/storage; budget keys homeless | High | Accept | Phase 1, 3, 5 |
| 10 | No writers/columns for pnl_daily, hit-rate, Sharpe, latency | High | Accept | Phase 1, 3 |
| 11 | liqfade sums `forceOrder`, a 1-per-second-per-symbol snapshot stream | High | Accept | Phase 4 |
| 12 | Fills missed during user-data gaps never replayed; no trade-id dedupe | High | Accept | Phase 1, 2 |
| 13 | No boot-time recovery; ledger batch loses ACKed orders on crash | High | Accept | Phase 1, 3 |
| 14 | Continuous drawdown breaker only in kernel-on-intent or in an LLM that 402 disables | Critical | Accept | Phase 3 |
| 15 | Commander zod schema incompatible with strict json_schema | High | Accept | Phase 5 |

Mechanical fixes applied in the consistency sweep (from remaining findings): `cli.ts` moved to Phase 1; bus event registry completed; `Intent` gains `paper`, `tSignalNs`; per-engine typed params; single `OnchainAdapter` + `SkillsHttp` (audit/leaderboard via public HTTPS, real in demo); `X402=mock|b402|cdp` with `network`/`asset` in `pricing.yaml`; latency target unified (≤300 ms VN / ≤150 ms VPS); MCP scope mismatch (no reconciliation via MCP); basis engine signal source in demo; `book.synced` flag; server-time offset per base URL; dashboard snapshot on-demand + backpressure; `hydra-overview.html` regeneration step; real Agent OS calls in demo (Skills HTTP, `baw tracker` read-only, MCP `tools/list` when available).
Rejected: "MCP OAuth bridge is gold plating" — MCP is a headline Agent OS component; kept with `claude -p` fallback.

### Whole-Plan Consistency Sweep
Re-read all files after edits. Decision deltas: kill lock file; per-venue flatten; Guardian module; `allowed_symbols` in risk.yaml; `cli promote` human-only; no automated transfers; `BAW_BIN`; tiers; `state/budgets.json` + kernel rule; `trades` table + latency columns; liqfade scoring; fill recovery; write-through orders + boot recovery; strict schemas; dashboard bind/token + separate x402 port; `X402` enum; `SkillsHttp`. Searched for stale terms (`config.json`, `/api/kill` unauthenticated, `facilitator.x402.org` as live, `mcp.get_balance` reconciliation, `budget.data`, `imbalance` as engine, "second invocation is a no-op", `REST /sapi/v1/asset/transfer`): none remain. Unresolved contradictions: none.

## Validation Log

### Session 1 — 2026-09-06
**Trigger:** `/ak:plan validate` after red-team session.
**Questions asked:** 8

#### Verification Results
- Claims checked: 6 open `[UNVERIFIED]`/open-question items from red team
- Verified: 2 (demo-fstream routed paths `/market`,`/public` upgrade 101; demo-fapi `POST /fapi/v1/listenKey` exists — reviewer probe) | Failed: 0 | Unverified: 4 (Agentic sub API key; MCP DCR; B402 creds; `baw` on Windows) — all isolated behind adapters/flags
- Tier: Full (8 phases); Red Team Review already carries file:line evidence

#### Questions & Answers
1. **[Scope]** Plan chia Tier S (phải nộp trước 08/09) và Tier A (stretch). Bạn muốn chạy implementation theo cách nào?
   - Options: Tier S trước, Tier A sau khi nộp | Full scope tuần tự, không ưu tiên deadline | Tier S + x402 mock + MCP bridge
   - **Answer:** Full scope tuần tự, không ưu tiên deadline
   - **Rationale:** Removes tier tags and cut line; phases run in dependency order.
2. **[Assumptions]** Model OpenRouter trong agents.yaml đang là placeholder. Chốt thế nào?
   - Options: Giữ placeholder, xác minh ở Phase 5 | Bạn cung cấp danh sách | Dùng 1 model cho tất cả
   - **Answer:** Other
   - **Custom input:** "Có giao diện để set model linh hoạt, có cái để a/b test luôn"
   - **Rationale:** Adds Settings panel + shadow A/B; placeholders verified at Phase 5.
3. **[Assumptions]** risk.yaml đặt llm_daily_budget_usd=5, data_daily_budget_usd=1, nav_usd_cap=5000. Phù hợp?
   - Options: Giữ nguyên | Tăng LLM budget $20 | Khác
   - **Answer:** Other
   - **Custom input:** "có giao diện set"
   - **Rationale:** Budgets editable in Settings panel; defaults unchanged.
4. **[Architecture]** Kill switch/Guardian gửi alert qua ALERT_WEBHOOK_URL. Kênh nào?
   - Options: Telegram bot | Discord webhook | Generic HTTP POST | Chưa cần
   - **Answer:** Telegram bot
5. **[Scope]** Giao diện set model/budget/A-B test đặt ở đâu và mức nào?
   - Options: Panel Settings trong dashboard, ghi thẳng agents.yaml/risk.yaml | Trang riêng /settings | Chỉ CLI + YAML
   - **Answer:** Panel Settings trong dashboard, ghi thẳng agents.yaml/risk.yaml
6. **[Architecture]** A/B test model của agent hoạt động thế nào?
   - Options: Shadow (B chỉ log) | Split (luân phiên, cả hai tác động thật) | Cả hai per-agent
   - **Answer:** Shadow: model B chạy song song, quyết định chỉ log, so sánh sau
7. **[Assumptions]** Chấm điểm A/B theo gì?
   - Options: Chi phí & latency | Schema-valid / tool-rejected rate | PnL attribution 1h | Đồng thuận A vs B
   - **Answer:** All four
8. **[Scope]** Với hạn 08/09 23:59 UTC?
   - Options: Nộp bản có-gì-nộp-nấy đúng hạn | Bỏ qua hạn nộp, làm sản phẩm trước
   - **Answer:** Bỏ qua hạn nộp, làm sản phẩm trước

#### Confirmed Decisions
- Delivery: full scope in phase order; no cut line; submission is a by-product.
- Runtime-configurable per-agent model + budgets via Settings panel (human, token-authenticated); LLM agents never write these.
- Shadow A/B per agent with four metric families; promotion by operator only.
- Alerts via Telegram bot; generic webhook fallback.
- Model ids stay placeholders until verified in Phase 5.

#### Action Items
- [x] Remove tier tags and cut-line section
- [x] Phase 1: `agents.yaml.shadow_model`, `agent_runs` table, `ab_metrics` read API, Telegram in `alert.ts`, `config.writeAgents/writeBudgets(actor='operator')`
- [x] Phase 5: shadow runner, agreement/attribution computation, hot-reload of agents.yaml
- [x] Phase 7: Settings panel + A/B panel + `/api/config/agents`, `/api/config/budgets` (PUT, token)
- [x] Phase 8: soak 6 h (no reduced variant)

#### Impact on Phases
- Phase 1: schema/ledger/alert additions.
- Phase 5: shadow execution path and A/B metrics.
- Phase 7: two new panels and two write endpoints; remove submission-deadline language.
- Phase 8: single 6-h soak.

### Whole-Plan Consistency Sweep
Re-read all files after propagation. Removed: tier tags, cut-line table, "Tier A" references, deadline-driven wording. Added consistently: `shadow_model`, `agent_runs(role)`, `abMetrics()`, Telegram env vars, Settings/A-B panels, `/api/config/*` PUT with actor `operator`. Searched for `Tier`, `[S]`, `[A]`, `cut line`, `deadline`: only the neutral "Delivery order" note and red-team history remain. Unresolved contradictions: none.

<!-- slug: hydra-agent-os -->
