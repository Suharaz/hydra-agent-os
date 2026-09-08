---
title: HYDRA plan + red team
date: 2026-09-06
summary: "8-phase HYDRA plan for Binance Agent OS hackathon, red-teamed (15 accepted findings)"
---

# HYDRA plan + red team

## Context
Binance Agent OS Mini Hackathon Track A. Designed HYDRA: two-speed autonomous scalping system (hot lane pure Bun/TS; cold lane 5 LLM agents on OpenRouter, per-agent model).

## What happened
- Researched Binance API (demo-fapi/demo-fstream, spot testnet, sub-accounts, MCP OAuth) and agent stack (OpenRouter, Skills Hub `baw` CLI, x402/B402, MCP TS client). Reports under `plans/260906-1650-hydra-agent-os/research/`.
- Wrote 8-phase plan via `ak plan create/add-phase`.
- Red team: 5 reviewer runs (2 cut by API rate limits, re-run) → 32 findings → 15 adjudicated, all accepted; 12 mechanical contract fixes folded into sweep; MCP bridge kept as Tier A.

## Key decisions
- Safety code-owned: `state/kill.lock` (human-only clear), `allowed_symbols` in risk.yaml, paper→live promotion via `cli promote`, no automated transfers, Guardian 1 s breaker independent of LLM/credits.
- Kill switch REST per-venue retry-until-flat, exempt from throttle pause; alerts via webhook.
- Dashboard `127.0.0.1` + token; x402 seller on separate port.
- `forceOrder` is a 1/s/symbol sample → liqfade scores by consecutive samples × mark-index gap × aggTrade burst.
- Fill recovery via `userTrades?fromId`, `fills UNIQUE(venue, trade_id)`; write-through ledger for orders; boot recovery.
- Strict json_schema outputs (all-required/nullable, no z.record).
- Submission cut line: Tier S vs Tier A tags per step; latency target p95 ≤300 ms from VN.
- Verified: demo-fstream routed paths (/market,/public) upgrade 101; demo-fapi listenKey endpoint exists.

## Open
Agentic sub API keys; MCP DCR; B402 creds; `baw` on Windows.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
