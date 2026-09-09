# Binance Agent OS Technical Integration Specification

This document details every integration surface, API endpoint, WebSocket stream, command line interface, and protocol wire format utilized by HYDRA across the Binance Agent OS ecosystem. Every entry is mapped directly to the implementing source code files.

---

## 1. Binance Exchange REST & WebSocket APIs

HYDRA maintains real-time, low-latency communication with Binance Spot and USD(S)-M Futures exchanges across demo, testnet, and live production environments.

### 1.1 Base URL Matrix (`src/venues/binance/urls.ts`)

| Venue & Mode | REST Base URL | WebSocket Base URL |
|---|---|---|
| **Futures (Demo)** | `https://demo-fapi.binance.com` | `wss://demo-fstream.binance.com` |
| **Futures (Live)** | `https://fapi.binance.com` | `wss://fstream.binance.com` |
| **Spot (Testnet)** | `https://testnet.binance.vision/api` | Stream: `wss://stream.testnet.binance.vision`<br>WS-API: `wss://ws-api.testnet.binance.vision/ws-api/v3` |
| **Spot (Live)** | `https://api.binance.com/api` | Stream: `wss://stream.binance.com:9443`<br>WS-API: `wss://ws-api.binance.com/ws-api/v3` |
| **Reference Feed** | — | `wss://stream.binance.com:9443` (Used in demo as mainnet price benchmark) |

### 1.2 Futures REST Endpoints (`src/venues/binance/rest-futures.ts`)

All private REST requests are signed using HMAC-SHA256 over query strings and request bodies using `BINANCE_FUTURES_API_SECRET`. Server-time synchronization offsets are maintained dynamically per base URL (`/fapi/v1/time`).

| Method | Endpoint Path | Description | Invocation Site (`FuturesRest`) |
|---|---|---|---|
| `GET` | `/fapi/v1/time` | Retrieves exchange server timestamp for clock drift calculation | `FuturesRest.time()` |
| `GET` | `/fapi/v1/exchangeInfo` | Loads trading pairs, price/quantity filters, and status | `FuturesRest.exchangeInfo()` |
| `GET` | `/fapi/v1/depth` | Order book depth snapshot | `FuturesRest.depth()` |
| `GET` | `/fapi/v1/ticker/24hr` | 24-hour ticker price change statistics | `FuturesRest.ticker24h()` |
| `GET` | `/fapi/v1/premiumIndex` | Mark price and funding rate index | `FuturesRest.premiumIndex()` |
| `GET` | `/fapi/v1/userTrades` | Historical execution fills for boot-time reconciliation | `FuturesRest.userTrades()` |
| `POST` | `/fapi/v1/listenKey` | Generates user data stream listen key | `FuturesRest.listenKeyCreate()` |
| `PUT` | `/fapi/v1/listenKey` | Extends user data stream listen key validity (keepalive) | `FuturesRest.listenKeyKeepalive()` |
| `DELETE` | `/fapi/v1/listenKey` | Closes active user data stream | `FuturesRest.listenKeyClose()` |
| `POST` | `/fapi/v1/order` | Submits new orders (`LIMIT`, `MARKET`, `STOP_MARKET`) | `FuturesRest.order()` |
| `DELETE` | `/fapi/v1/order` | Cancels an individual order by symbol and order ID / client order ID | `FuturesRest.cancelOrder()` |
| `DELETE` | `/fapi/v1/allOpenOrders` | Cancels all active orders for a symbol simultaneously | `FuturesRest.cancelAllOpenOrders()` |
| `GET` | `/fapi/v1/openOrders` | Queries currently open orders | `FuturesRest.openOrders()` |
| `GET` | `/fapi/v3/positionRisk` | Real-time position risks, leverage, and unrealized profit | `FuturesRest.positionRisk()` |
| `GET` | `/fapi/v3/account` | Account balances and margin details | `FuturesRest.account()` |
| `POST` | `/fapi/v1/leverage` | Sets symbol initial leverage | `FuturesRest.leverage()` |

### 1.3 Spot REST Endpoints (`src/venues/binance/rest-spot.ts`)

| Method | Endpoint Path | Description | Invocation Site (`SpotRest`) |
|---|---|---|---|
| `GET` | `/v3/time` | Retrieves spot exchange timestamp | `SpotRest.time()` |
| `GET` | `/v3/exchangeInfo` | Loads spot market precision, filters, and trading status | `SpotRest.exchangeInfo()` |
| `GET` | `/v3/depth` | Spot order book depth snapshot | `SpotRest.depth()` |
| `GET` | `/v3/myTrades` | Trade fills for gap replay and reconciliation | `SpotRest.myTrades()` |
| `POST` | `/v3/order` | Submits spot orders (`LIMIT`, `MARKET`) | `SpotRest.order()` |
| `DELETE` | `/v3/order` | Cancels an individual spot order | `SpotRest.cancelOrder()` |
| `DELETE` | `/v3/openOrders` | Cancels all open spot orders on a specific symbol | `SpotRest.cancelOpenOrders()` |
| `GET` | `/v3/openOrders` | Lists active unfilled spot orders | `SpotRest.openOrders()` |
| `GET` | `/v3/account` | Queries asset balances (free and locked) | `SpotRest.account()` |
| `GET` | `/sapi/v1/account/apiRestrictions` | Checks API key permissions (trade-only, no withdraw/transfer; live only) | `SpotRest.apiRestrictions()` |

### 1.4 WebSocket Stream Channels (`src/venues/binance/ws.ts`, `src/venues/binance/userdata.ts`)

HYDRA probes and establishes distinct WebSocket connections for public market data and private account telemetry:

- **Futures Market Streams:**
  - Route options probed at startup (`src/venues/binance/urls.ts`): `/market`, `/public`, or standard legacy `/ws`.
  - Aggregated Trades: `<symbol>@aggTrade`
  - Liquidation Snapshot Stream: `<symbol>@forceOrder` (monitored for cascade fade detection)
  - Orderbook Depth: `<symbol>@depth20@100ms`
  - Mark Price & Funding: `<symbol>@markPrice@1s`
- **Spot Market Streams:**
  - Combined stream URL: `/stream?streams=<symbol>@aggTrade/<symbol>@bookTicker`
- **Spot WS-API (`src/venues/binance/userdata.ts`):**
  - Connects to `wss://ws-api.binance.com/ws-api/v3` (or testnet equivalent) using message-based request/response framing.
  - Subscribes to private user events via signed JSON payload:
    ```json
    {
      "id": "sub_userdata_1",
      "method": "userDataStream.subscribe.signature",
      "params": {
        "apiKey": "...",
        "timestamp": 1725690000000,
        "signature": "..."
      }
    }
    ```
- **Futures User Data Stream (`src/venues/binance/userdata.ts`):**
  - Listens on `wss://fstream.binance.com/ws/<listenKey>`.
  - Captures `ORDER_TRADE_UPDATE` and `ACCOUNT_UPDATE` payloads to drive real-time balance and position adjustments.

---

## 2. Binance Skills Hub Public HTTP APIs

HYDRA consumes public data APIs from the Binance Web3 Skills Hub without requiring wallet connection or private API key authorization. These calls run live in both `demo` and `live` modes.

**Implementation File:** `src/venues/onchain/skills-http.ts`  
**Base URL:** `https://web3.binance.com` (Default, configurable via `SKILLS_HTTP`)  
**User-Agent Header:** `binance-web3/1.4 (Skill)`

### 2.1 API Route Reference

| Constant Name | HTTP Path | Method | Description |
|---|---|---|---|
| `AUDIT_PATH` | `/bapi/defi/v1/public/wallet-direct/security/token/audit` | `POST` | Security audit assessing honeypot status, buy/sell taxes, contract mintability, and blacklists. Required by Kernel Rule 9 for all DEX intents. |
| `TOKEN_DYNAMIC_PATH` | `/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info/ai` | `GET` | Dynamic on-chain metrics: token pricing, 24-hour volume, total liquidity, market capitalization, and holder counts. |
| `LEADERBOARD_PATH` | `/bapi/defi/v1/public/wallet-direct/market/leaderboard/query` | `GET` | Smart money wallet rankings, historical win rates, and 30-day realized PnL scores. |
| `RWA_LIST_PATH` | `/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai` | `GET` | Tokenized real-world equity listings and metadata (served via `https://www.binance.com`). |
| `RWA_DYNAMIC_PATH` | `/bapi/defi/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai` | `GET` | Real-time pricing, stock underlying price, and market session open/close status for tokenized securities. |

### 2.2 Token Security Audit Payload Format

Request dispatched by `SkillsHttp.audit(chainId, contractAddress)`:

```http
POST /bapi/defi/v1/public/wallet-direct/security/token/audit HTTP/1.1
Host: web3.binance.com
Content-Type: application/json
User-Agent: binance-web3/1.4 (Skill)

{
  "chainId": "56",
  "contractAddress": "0x55d398326f99059ff775485246999027b3197955"
}
```

Response evaluated by the Risk Kernel:
- Evaluates `data.riskLevel` (`LOW`, `MEDIUM`, `HIGH`).
- Only tokens returning `riskLevel === "LOW"` pass Kernel Rule 9; `HIGH` or `MEDIUM` triggers an immediate trade veto.

---

## 3. Binance Agentic Wallet (`baw`) Integration

For live on-chain operations (DEX trading, tracker feeds, and x402 buyer signing), HYDRA wraps the official `@binance/agentic-wallet` CLI.

**Implementation File:** `src/venues/onchain/baw-adapter.ts`  
**Binary Enforcement:** The binary path specified in `BAW_BIN` is resolved via `realpathSync` and validated against package metadata:
- Package name must strictly equal `@binance/agentic-wallet`.
- Package version must be $\ge 1.9.0$.
- Invocation via `npx baw` is prohibited in code to prevent supply-chain package confusion.

### 3.1 Subcommand Invocations

All commands execute via `Bun.spawn` with stdout parsed as JSON:

1. **Wallet Connection Status:**
   ```bash
   baw wallet status --json
   ```
   - Checks whether the operator has paired the wallet (`status.connected === true`).
   - Retrieves the active EVM wallet address.

2. **DEX Aggregator Quote:**
   ```bash
   baw market-order quote --chain-id <chainId> --from <fromToken> --to <toToken> --amount <amount> --json
   ```
   - Fetches execution pricing and estimated gas fees in USD across on-chain liquidity venues.

3. **DEX Swap Execution:**
   ```bash
   baw market-order swap --chain-id <chainId> --from <fromToken> --to <toToken> --amount <amount> --json
   ```
   - Dispatches a market swap. Returns transaction hash (`txHash`) and executed quantity.

4. **Smart Money WebSocket Tracker:**
   ```bash
   baw tracker ws --smy --json
   ```
   - Spawns a persistent background process streaming NDJSON push notifications of top-ranked wallet movements directly into the `smmirror` signal engine.

5. **Wallet Pairing Flow:**
   ```bash
   bun run cli baw pair
   # Spawns foreground process: baw wallet pair
   ```
   - Displays terminal QR code for operator mobile app signature pairing.

---

## 4. x402 v2 Payment Protocol

HYDRA natively implements the x402 v2 protocol (`scheme: exact`, EIP-3009) to monetize proprietary trading signals and purchase external market feeds.

**Implementation Files:** `src/pay/server.ts`, `src/pay/facilitator.ts`, `src/pay/catalog.ts`, `src/pay/client.ts`

### 4.1 Wire Protocol Headers

x402 requests use standard HTTP headers with Base64-encoded JSON payloads:

- **`PAYMENT-REQUIRED` (Server -> Client, HTTP 402):**
  Returned when an unauthenticated client requests a monetized endpoint (`/v1/signals/*`):
  ```json
  {
    "x402Version": 2,
    "accepts": [
      {
        "scheme": "exact",
        "network": "eip155:84532",
        "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "payTo": "0x000000000000000000000000000000000000dEaD",
        "maxAmountRequired": "100000",
        "resource": "/v1/signals/liquidation",
        "description": "Real-time liquidation fade signal feed",
        "maxTimeoutSeconds": 60,
        "extra": {
          "name": "USDC",
          "version": "2"
        }
      }
    ]
  }
  ```

- **`PAYMENT-SIGNATURE` (Client -> Server, Retry Request):**
  The client signs an EIP-712 `TransferWithAuthorization` message and includes it on the request retry:
  ```json
  {
    "x402Version": 2,
    "scheme": "exact",
    "network": "eip155:84532",
    "payload": {
      "signature": "0x...",
      "authorization": {
        "from": "0xPayerAddress...",
        "to": "0x000000000000000000000000000000000000dEaD",
        "value": "100000",
        "validAfter": "1725690000",
        "validBefore": "1725690060",
        "nonce": "0xUniqueHexNonce..."
      }
    }
  }
  ```

- **`PAYMENT-RESPONSE` (Server -> Client, HTTP 200):**
  Returned upon successful settlement verification alongside the requested resource payload:
  ```json
  {
    "success": true,
    "transaction": "0xSettledTxHash...",
    "network": "eip155:84532",
    "payer": "0xPayerAddress..."
  }
  ```

### 4.2 Facilitator Implementations (`src/pay/facilitator.ts`)

1. **`MockFacilitator` (Demo):**
   - Verifies the EIP-712 typed signature locally in Bun using `viem`.
   - Maintains an in-memory nonce set to prevent replay attacks.
   - Generates deterministic mock transaction hashes without touching live blockchain networks.

2. **`B402Facilitator` (Live - Binance B402 on BSC):**
   - Endpoints:
     - Verify: `POST /papi/v2/b402/verify`
     - Settle: `POST /papi/v2/b402/settle`
   - Authentication (UNVERIFIED): B402 docs and base URL are issued only with merchant onboarding (see `plans/260906-1650-hydra-agent-os/research/researcher-02-agent-stack.md` §4: "RSA-signed with clientId/accessToken", no header names published). The code signs RSA-SHA256 over `jsonBody + timestamp` and sends `X-Tesla-ClientId`, `X-Tesla-SignAccessToken`, `X-Tesla-Timestamp`, `X-Tesla-Signature` (`src/pay/facilitator.ts` `B402Facilitator.headers`). These names are an inference, not a documented contract; the first live `/verify` call is the contract check.
   - Settle is polled asynchronously until confirmed or timeout.

3. **`CdpFacilitator` (Live Fallback - Coinbase Developer Platform on Base):**
   - Connects to Coinbase CDP facilitator endpoints on Base mainnet.
   - Signs requests with short-lived (120 s) Ed25519 JWT bearer tokens.

---

## 5. Binance Model Context Protocol (MCP) Bridge

HYDRA provides an integrated MCP client connecting to the Binance Model Context Protocol server, enabling cold-lane agents to discover and invoke tools securely.

**Implementation Files:** `src/cold/mcp/client.ts`, `src/cold/mcp/oauth.ts`, `src/cold/mcp/store.ts`  
**Default Server URL:** `https://mcp.binance.com/mcp` (Configurable via `MCP_URL`)

### 5.1 Transport & Authentication
- **Transport:** StreamableHTTP transport via `@modelcontextprotocol/sdk`.
- **OAuth 2.0 PKCE Bridge (`HydraOAuthProvider`):** Handles authorization code exchange using proof key for code exchange (PKCE) over a local one-shot loopback callback server on `http://127.0.0.1:8790/callback` (`CALLBACK_PORT = 8790`, `CALLBACK_HOST = "127.0.0.1"`, `CALLBACK_PATH = "/callback"`). Tokens, client registration, and PKCE verifier are stored in `<stateDir>/mcp/tokens.json`.
- **Fallback Mode:** When MCP dynamic client registration is unverified or offline, the system falls back to `claude -p` desktop showcase flows or mock tools in demo mode.

### 5.2 Strict Read-Only Tool Whitelist
To guarantee that LLM agents cannot invoke mutating operations (such as withdrawals, balance transfers, or unauthorized orders) via MCP, `McpBridge.call()` enforces a strict client-side prefix whitelist before dispatching any network request:

```typescript
export const DEFAULT_READ_ONLY: readonly string[] = ["get_", "list_", "query_", "read_"];
```

Any attempt by an agent to execute an unapproved tool (e.g. `transfer_assets`, `place_order`) is blocked client-side and throws an `McpError("not_whitelisted")`.

---

## 6. YEScale Cold-Lane LLM Integration

The cold-lane supervisory agents (Commander, Supervisor, Treasurer, Coach, Sales) communicate with YEScale AI Gateway using a thin, direct `fetch` client with no heavy external agent SDKs.

**Implementation File:** `src/cold/llm.ts`  
**Endpoint:** `POST https://api.yescale.io/v1/chat/completions`

### 6.1 Request Wire Format

Requests enforce structured outputs and parameter validation:

```json
{
  "model": "claude-fable-5-1",
  "models": ["gpt-5.6-sol"],
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "temperature": 0.2,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "update_engine_params",
        "description": "Writes parameter updates to engines.yaml",
        "strict": true,
        "parameters": {
          "type": "object",
          "properties": { ... },
          "required": [ ... ],
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

### 6.2 Error Handling & Telemetry
- **HTTP 429 (Rate Limit):** Inspects `Retry-After` header and retries once (clamped between 2,000 ms and 30,000 ms).
- **HTTP 402 (Insufficient Credits):** Emits `system.llm_credits` over the event bus and halts further scheduled runs until the next UTC day. The hot execution lane remains entirely unaffected.
- **Ledger Recording:** Every call is persisted to the `llm_calls` SQLite table recording prompt tokens, completion tokens, dollar cost, execution latency in milliseconds, and the actual model ID selected by YEScale's gateway router.

## 7. Dashboard Access

The operator dashboard (`src/dashboard/server.ts`, `127.0.0.1:8787`) is not part of the Agent OS integration surface and is never reachable from the network: the server refuses any non-loopback bind, browser sessions are `HttpOnly` cookies obtained via `POST /api/login`, WebSocket auth uses one-time tickets, and every action is written to the `dashboard_audit` ledger table (`bun run cli audit`). Roles (viewer/operator), the lockout policy, the SSH port-forward runbook, and why tunnels and reverse proxies are unsupported are documented in the README under [Dashboard Architecture > Security model](../README.md#security-model).
