// Shared domain types. Every later phase consumes these; keep names stable.

export type EngineId = "liqfade" | "basis" | "convert" | "smmirror" | "cexdex" | "tokstock";
export const ENGINE_IDS: readonly EngineId[] = ["liqfade", "basis", "convert", "smmirror", "cexdex", "tokstock"];

export type Venue = "spot" | "futures" | "dex";
export const VENUES: readonly Venue[] = ["spot", "futures", "dex"];

export type Side = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";

export type AgentName = "commander" | "supervisor" | "treasurer" | "coach" | "sales";
export const AGENT_NAMES: readonly AgentName[] = ["commander", "supervisor", "treasurer", "coach", "sales"];

/** Who is performing a write. `kill` is a pseudo-actor reserved for kill.ts. */
export type Actor = "operator" | "commander" | "supervisor" | "treasurer" | "coach" | "sales" | "guardian" | "system";
export type KillActor = "kill";

export type Mode = "demo" | "live";
export type SpotFlag = "testnet" | "live";
export type FuturesFlag = "demo" | "live";
export type OnchainFlag = "paper" | "live";
export type X402Flag = "mock" | "b402" | "cdp";
export type McpFlag = "off" | "on";

// ---- hot lane -------------------------------------------------------------

export interface Intent {
  id: string;
  engine: EngineId;
  venue: Venue;
  symbol: string;
  side: Side;
  qty: number;
  type: OrderType;
  price?: number;
  tp?: number;
  sl?: number;
  ttlMs: number;
  paper: boolean;
  /** Local monotonic ns at signal detection (frame receipt); latency base. */
  tSignalNs: number;
  /** Multi-leg intents are all-or-nothing across venues. */
  legs?: Intent[];
}

export type OrderStatus =
  | "PENDING"
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED"
  | "PAPER"
  | "FAILED";

export interface Order {
  id: number;
  intentId: number;
  venue: Venue;
  symbol: string;
  side: Side;
  qty: number;
  price?: number;
  clientId: string;
  extId?: string;
  status: OrderStatus;
  tSentNs: number;
  tAckNs?: number;
  latencyMs?: number;
}

export interface Fill {
  orderId: number;
  venue: Venue;
  symbol: string;
  tradeId: string;
  side: Side;
  price: number;
  qty: number;
  fee: number;
  feeAsset: string;
  tsNs: number;
}

/** Closed round-trip, FIFO per engine/symbol; written by positions.ts. */
export interface Trade {
  engine: EngineId;
  venue: Venue;
  symbol: string;
  openedNs: number;
  closedNs: number;
  qty: number;
  entry: number;
  exit: number;
  realized: number;
  fees: number;
  retBps: number;
}

export interface Position {
  engine: EngineId;
  venue: Venue;
  symbol: string;
  /** Signed: positive long, negative short. */
  qty: number;
  entry: number;
  mark: number;
  unrealized: number;
  notionalUsd: number;
  liqPrice?: number;
}

export interface Veto {
  intentId: string;
  engine: EngineId;
  rule: number;
  detail: string;
  tsNs: number;
}

export interface OpportunityContract {
  engine: EngineId;
  venue: Venue;
  symbol: string;
  side: Side;
  edgeBps: number;
  confidence: number;
  sizeUsd: number;
  ttlMs: number;
  tsNs: number;
  meta?: Record<string, unknown>;
}

// ---- feed payloads --------------------------------------------------------

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface DepthEvent {
  venue: Venue;
  symbol: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
  synced: boolean;
  tsNs: number;
}

export interface TradeTick {
  venue: Venue;
  symbol: string;
  price: number;
  qty: number;
  side: Side;
  tsNs: number;
}

/** One forceOrder sample: Binance pushes at most one per symbol per 1000 ms. */
export interface LiquidationEvent {
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  usd: number;
  tsNs: number;
}

export interface MarkEvent {
  symbol: string;
  mark: number;
  index: number;
  fundingRate: number;
  nextFundingTime: number;
  tsNs: number;
}

export interface SmartMoneyEvent {
  wallet: string;
  token: string;
  chain: string;
  side: Side;
  amountUsd: number;
  tsNs: number;
}

export interface DexQuote {
  pair: string;
  chain: string;
  bid: number;
  ask: number;
  gasUsd: number;
  tsNs: number;
}

// ---- cold lane ------------------------------------------------------------

export type AgentRole = "primary" | "shadow";

export interface AgentDecision {
  runId: string;
  agent: AgentName;
  role: AgentRole;
  model: string;
  decision: unknown;
  applied: boolean;
  toolRejections: number;
  costUsd: number;
  latencyMs: number;
  schemaValid: boolean;
}

export interface DreamCycleEvent {
  timestamp: number;
  tradesReviewed: number;
  lossTradesCount: number;
  vetoCount: number;
  newLessonTitle: string;
  narrative: string;
}

export interface Payment {
  direction: "in" | "out";
  counterparty: string;
  amount: number;
  asset: string;
  network: string;
  tx: string;
  meta?: Record<string, unknown>;
}

// ---- state files ----------------------------------------------------------

/** Tighten-only overlay over risk.yaml caps. Every key optional; absent = inherit. */
export interface Limits {
  nav_usd_cap?: number;
  max_net_delta_pct?: number;
  max_leverage?: number;
  min_liq_distance_pct?: number;
  max_orders_per_sec?: number;
  daily_drawdown_kill_pct?: number;
  per_engine_max_notional_usd?: Partial<Record<EngineId, number>>;
  onchain_max_notional_usd?: number;
  /** Engines forced off (Guardian pause writes "all"). */
  engines_paused?: EngineId[] | "all";
}

export interface LimitsOverlay extends Limits {
  actor: "supervisor" | "guardian" | "operator";
  reason?: string;
  /** Wall ms; null = until restart. Honoured only when no kill.lock. */
  expires_at: number | null;
  updated_at: number;
}

/** engine -> budget USD; written only via Treasurer `budget.set`. */
export type Budgets = Partial<Record<EngineId, number>>;

export interface Residue {
  symbol: string;
  qty: number;
}

export interface KillLock {
  reason: string;
  /** Wall ms. */
  at: number;
  residue: Record<Venue, Residue[]>;
}

// ---- engine params (Phase 4 tightens with zod bounds) ---------------------

export interface LiqfadeParams {
  windowMs: number;
  minSnapshots: number;
  minSampleUsd: number;
  minGapBps: number;
  minBurstRatio: number;
  minDispBps: number;
  tpBps: number;
  slBps: number;
  maxHoldMs: number;
  chaseMs: number;
  allowMarket: boolean;
}

export interface BasisParams {
  lookbackSec: number;
  zEntry: number;
  zExit: number;
  maxHoldMs: number;
}

export interface SmmirrorParams {
  minScore: number;
  slipBps: number;
  tpBps: number;
  slBps: number;
  exitOnSellPct: number;
  maxTokenAgeSec: number;
}

export interface CexdexParams {
  minEdgeBps: number;
}

export interface ConvertParams {
  minEdgeBps: number;
  pollMs: number;
}

export interface TokstockParams {
  devBps: number;
}

export type EngineParams =
  | { engine: "liqfade"; params: LiqfadeParams }
  | { engine: "basis"; params: BasisParams }
  | { engine: "smmirror"; params: SmmirrorParams }
  | { engine: "cexdex"; params: CexdexParams }
  | { engine: "convert"; params: ConvertParams }
  | { engine: "tokstock"; params: TokstockParams };

export interface EngineConfig {
  enabled: boolean;
  paper: boolean;
  symbols: string[];
  sizeUsd: number;
  params: Record<string, unknown>;
}

// ---- system events --------------------------------------------------------

export interface KillEvent {
  reason: string;
  actor: Actor | KillActor;
  tsNs: number;
}

export interface KillFailedEvent {
  reason: string;
  attempt: number;
  residue: Record<Venue, Residue[]>;
  tsNs: number;
}

export interface ThrottleEvent {
  venue: Venue;
  status: number;
  pauseMs: number;
  tsNs: number;
}

export interface LlmCreditsEvent {
  agent: AgentName;
  model: string;
  status: number;
  tsNs: number;
}

export interface GuardianBreach {
  kind: "drawdown" | "nav_jump";
  value: number;
  threshold: number;
  tsNs: number;
}

export interface RollbackEvent {
  intentId: string;
  venue: Venue;
  ok: boolean;
  detail: string;
  tsNs: number;
}
