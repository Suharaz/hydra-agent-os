---
phase: 6
title: "Payments (x402) + on-chain (baw)"
status: pending
priority: P2
effort: "1.5d"
dependencies: [2, 5]
---

# Phase 6: Payments (x402) + on-chain (baw)

## Overview
Agent-to-agent economy and on-chain execution. Sales sells signal feeds behind HTTP 402 (x402 v2) on a **separate public port**; Treasurer buys external data with x402; the `OnchainAdapter` from Phase 2 gains `swap()` (live via `baw`, paper in demo). Audit/leaderboard/tokenized-stock data come from `SkillsHttp` (Phase 2), not `baw`.

## Requirements
- Functional seller : Hono app on `X402_PORT` (default 8788) exposing only `/v1/catalog` (free) and `/v1/signals/{liquidation,basis,contracts}` behind `@x402/hono` `paymentMiddleware`; `config/pricing.yaml` per route `{price_usd, min, max, network, asset}`; `payTo` from env; settled payment → ledger `payments(direction='in')`; `PAYMENT-RESPONSE` header with tx; rate limit 10 req/s/IP; no admin/dashboard routes on this port.
- Functional facilitator selection by `X402`: `mock` (demo: local EIP-712 verify with `viem`, nonce replay set, fake tx; network `eip155:84532` Base Sepolia, asset USDC), `b402` (Binance facilitator on BSC `eip155:56`, RSA-signed calls to `{BASE_URL}/papi/v2/b402/*`, async settle polling; assets USD1/U for eip3009 or USDT/USDC via permit2), `cdp` (Coinbase CDP facilitator, Base mainnet `eip155:8453`, API keys). The public `facilitator.x402.org` is testnet-only and is **not** a live option.
- Functional buyer : `x402fetch(url)` — on 402 parse requirements → live: `baw x402-payment preview` → `sign` → replay; demo: `LocalSigner` from `X402_DEMO_PRIVATE_KEY`; Treasurer tool `pay.buy(url)` enforces `data_daily_budget_usd` via `ledger.dataSpendToday()`.
- Functional on-chain : `BawAdapter.swap(intent)` → `baw market-order quote|swap --json`; `walletStatus()` must be connected before live start (`cli baw pair` runs the QR flow in foreground); executor routes `venue:'dex'` intents; paper adapter fills at last `feed.dexquote` ± slippage .
- Non-functional: no private keys in repo; deps pinned; `viem` for signature verification only.

## Architecture
```
src/pay/server.ts        # separate Bun.serve on X402_PORT; Hono + paymentMiddleware
src/pay/facilitator.ts   # Facilitator interface; MockFacilitator; B402Facilitator; CdpFacilitator; HTTPFacilitatorClient adapter with createAuthHeaders + path map
src/pay/client.ts        # x402fetch; LocalSigner; BawSigner
src/pay/catalog.ts       # pricing.yaml; Sales-adjustable within [min,max]
src/venues/onchain/baw-adapter.ts (+swap) , paper-adapter.ts (+swap)
config/pricing.yaml
```
`pricing.yaml`:
```yaml
network: eip155:84532        # demo; live: eip155:56 (b402) or eip155:8453 (cdp)
asset: USDC                  # demo; live b402: USD1 (eip3009) or USDT (permit2)
routes:
  /v1/signals/liquidation: { price_usd: 0.05, min: 0.01, max: 0.50 }
  /v1/signals/basis:       { price_usd: 0.05, min: 0.01, max: 0.50 }
  /v1/signals/contracts:   { price_usd: 0.10, min: 0.02, max: 1.00 }
```

## Related Code Files
- Create: `src/pay/{server,facilitator,client,catalog}.ts`, `config/pricing.yaml`
- Create: `test/pay/{seller-402-flow,mock-facilitator-replay,client-budget}.test.ts`, `test/onchain/paper-swap.test.ts`
- Modify: `src/venues/onchain/{baw-adapter,paper-adapter}.ts`, `src/hot/executor.ts` (dex route), `src/cold/agents/{treasurer,sales}.ts`, `src/cold/tools.ts` (`pay.buy`, `pricing.set`), `src/cli.ts` (`buy`, `baw pair`), `src/main.ts`
- Deps (pinned): `@x402/core`, `@x402/evm`, `@x402/hono`, `@x402/fetch`, `viem`

## Implementation Steps
1. Add deps; confirm `@x402/hono` runs under `Bun.serve({fetch: app.fetch})`.
2. `MockFacilitator`: `verifyTypedData` for `TransferWithAuthorization` (eip3009) on Base Sepolia USDC domain; nonce replay set; fake tx.
3. `server.ts`: separate port; routes; middleware; feed payloads (2 s delayed vs internal); catalog.
4. `client.ts` with `LocalSigner`; `cli buy <path>` demo.
5. Paper `swap()`; executor dex route; ledger `orders.venue='dex'`.
6. `B402Facilitator` (RSA signing, path map, settle polling) and `CdpFacilitator`; select by `X402`.
7. `BawAdapter.swap()`, `BawSigner`, `cli baw pair`.
8. Treasurer `pay.buy`, Sales `pricing.set`.
9. Tests: 402 → paid → 200 with mock; replayed nonce rejected; budget exhaustion refuses; paper swap respects on-chain cap.

## Success Criteria
- [x] `curl -i 127.0.0.1:8788/v1/signals/liquidation` → 402; `cli buy /v1/signals/liquidation` → 200 + `PAYMENT-RESPONSE`; `payments` row present; `/api/*` absent on 8788
- [x] Demo: smmirror DEX leg produces `orders.venue='dex'` paper fill; audit FAIL from `SkillsHttp` causes kernel rule 9 veto
- [ ] One real settled payment (B402 on BSC or CDP on Base) with tx hash; otherwise README states mock-only honestly — GATED: no B402/CDP credentials; README states mock-only
- [x] Treasurer refuses purchases beyond daily data budget (test)

## Risk Assessment
- B402 creds form-gated → mock for submission; CDP as live alternative; no claim of live payments without a tx hash.
- BSC USDT/USDC permit2-only → live b402 asset default USD1 (eip3009); permit2 path via `ExactEvmScheme` if needed.
- `baw` pairing blocking ≤5 min → human runs `cli baw pair` before live; adapter refuses unpaired.
