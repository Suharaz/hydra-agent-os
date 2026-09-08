// scripts/seed-demo-data.ts
// Generates realistic, production-grade 24h trading history, liquidation events,
// risk vetoes, and triggers a full Dream Coin neural reflection cycle for video recording.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { executeDreamCycle, loadDreamMemory, saveDreamMemory, type DreamLesson } from "../src/cold/dream.ts";
import { Database } from "bun:sqlite";

console.log("=== HYDRA DEMO DATA GENERATOR & DREAM COIN SYNCHRONIZER ===");

const STATE_DIR = "state";
const DB_PATH = `${STATE_DIR}/hydra.db`;
const DREAM_FILE = `${STATE_DIR}/dream-memory.json`;

mkdirSync(STATE_DIR, { recursive: true });

// 1. Seed Rich Neural Memory Lessons if not present
const initialDream = loadDreamMemory(DREAM_FILE);
console.log(`Current Dream Memory Store: ${initialDream.lessons.length} lessons, ${initialDream.totalCycles} cycles`);

// Add high-impact trading lessons for the showcase
const richLessons: DreamLesson[] = [
  {
    id: "lesson-01",
    timestamp: Date.now() - 86400000 * 2,
    category: "anti-loss",
    title: "Prohibit LiqFade Entries Under Severe Negative Funding (< -0.025%)",
    trigger: "SOL -$6.00 stop-loss triggered as second liquidation cascade overwhelmed wick bids.",
    counterfactual: "If waiting for funding rate to normalize above -0.01%, position avoids secondary cascade pressure.",
    invariantRule: "LiqFade only activates when funding_rate >= -0.020% across all derivative altcoins.",
    confidence: 0.96,
    appliedToAgents: ["commander", "supervisor", "coach"]
  },
  {
    id: "lesson-02",
    timestamp: Date.now() - 86400000,
    category: "risk-management",
    title: "Reduce Order Size by 50% Ahead of High-Impact Macro News (CPI/FOMC)",
    trigger: "ETHUSDT spread widened from 0.8 bps to 18.2 bps within 30s during Fed rate announcement.",
    counterfactual: "If auto-reducing max notional to $2,500 ahead of release, slippage adverse impact drops 75%.",
    invariantRule: "Automatically engage Macro-Guard mode ahead of scheduled high-volatility economic announcements.",
    confidence: 0.98,
    appliedToAgents: ["supervisor", "commander"]
  },
  {
    id: "lesson-03",
    timestamp: Date.now() - 43200000,
    category: "fee-optimization",
    title: "Route Stablecoin Rebalancing via Binance Convert RFQ",
    trigger: "Large-scale USDC/USDT spot transactions incurred 7.5 bps taker fees, eroding execution alpha.",
    counterfactual: "If routed via Binance Convert RFQ with zero trading fees, saves $42.50 per day.",
    invariantRule: "All stablecoin/bluechip rebalancing orders under $5,000 must route through Convert RFQ.",
    confidence: 0.95,
    appliedToAgents: ["commander", "treasurer"]
  },
  {
    id: "lesson-04",
    timestamp: Date.now() - 21600000,
    category: "execution",
    title: "Reject DEX Smart Money Tracking if Slippage Exceeds 10 bps",
    trigger: "Copy-trade of whale 0x7a2... on Uniswap v3 suffered 14.5 bps slippage due to shallow pool depth.",
    counterfactual: "If placing limit orders or executing on equivalent Binance Spot pair, profit margin increases +$34.00.",
    invariantRule: "SmartMoney Mirror on DEX must verify pool depth: reject order if estimated impact > 10 bps.",
    confidence: 0.93,
    appliedToAgents: ["coach", "treasurer"]
  }
];

initialDream.lessons = richLessons;
saveDreamMemory(initialDream, DREAM_FILE);

// 2. Trigger an immediate Dream Reflection Cycle to distill a new lesson
console.log("\n-> Executing live Dream Cycle (24h Neural Reflection & Rule Distillation)...");
const dreamResult = executeDreamCycle(DREAM_FILE);
console.log(`[DREAM ENGINE] Total Cycles: ${initialDream.totalCycles + 1}`);
console.log(`[DREAM ENGINE] Trades Reviewed: ${dreamResult.tradesReviewed}`);
console.log(`[DREAM ENGINE] Losses Isolated: ${dreamResult.lossTradesCount}`);
console.log(`[DREAM ENGINE] Vetoes Analyzed: ${dreamResult.vetoCount}`);
console.log(`[DREAM ENGINE] New Golden Rule: "${dreamResult.lessonsDistilled[0]?.title}"`);

// 3. Populate SQLite database with rich realistic trade history
console.log("\n-> Populating SQLite database with 24h trading transactions...");
const db = new Database(DB_PATH);

db.run(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    engine TEXT NOT NULL,
    venue TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    qty REAL NOT NULL,
    status TEXT NOT NULL,
    latency_ms REAL NOT NULL,
    pnl_usd REAL DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS vetoes (
    id TEXT PRIMARY KEY,
    engine TEXT NOT NULL,
    symbol TEXT NOT NULL,
    rule_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS agent_runs (
    run_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    primary_model TEXT NOT NULL,
    shadow_model TEXT,
    cost_usd REAL NOT NULL,
    latency_ms REAL NOT NULL,
    agreement_pct REAL,
    decision_json TEXT,
    created_at INTEGER NOT NULL
  )
`);

// Insert recent trades
const engines = ["liqfade", "basis", "smmirror", "imbalance", "cexdex", "convert"];
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT"];
const now = Date.now();

const insertOrder = db.prepare(`
  INSERT OR REPLACE INTO orders (id, symbol, engine, venue, side, price, qty, status, latency_ms, pnl_usd, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let totalPnl = 0;
for (let i = 0; i < 60; i++) {
  const engine = engines[i % engines.length]!;
  const symbol = symbols[i % symbols.length]!;
  const side = i % 2 === 0 ? "BUY" : "SELL";
  const basePrice = symbol.startsWith("BTC") ? 88400 : symbol.startsWith("ETH") ? 3280 : symbol.startsWith("SOL") ? 184 : 610;
  const price = basePrice * (1 + (Math.sin(i) * 0.004));
  const qty = symbol.startsWith("BTC") ? 0.05 : symbol.startsWith("ETH") ? 0.8 : 8;
  const isLoss = (i === 11 || i === 23 || i === 47);
  const pnl = isLoss ? -(12 + Math.random() * 25) : (4.5 + Math.random() * 38);
  totalPnl += pnl;
  const latency = 120 + Math.random() * 85;
  const time = now - (60 - i) * 60 * 1000;

  insertOrder.run(
    `ord-${1000 + i}`,
    symbol,
    engine,
    "futures",
    side,
    Number(price.toFixed(2)),
    qty,
    "FILLED",
    Number(latency.toFixed(1)),
    Number(pnl.toFixed(2)),
    time
  );
}

// Insert representative vetoes
const insertVeto = db.prepare(`
  INSERT OR REPLACE INTO vetoes (id, engine, symbol, rule_id, reason, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

insertVeto.run("veto-01", "smmirror", "PEPEUSDT", 9, "Token Security Audit failed: HoneyPot tax 15% detected on Base DEX", now - 3600000 * 3);
insertVeto.run("veto-02", "liqfade", "SOLUSDT", 2, "Dream Coin Rule: Cascade funding rate -0.031% < threshold -0.020%", now - 3600000 * 2);
insertVeto.run("veto-03", "imbalance", "ETHUSDT", 0, "Kill switch active / drawdown protection lock engaged", now - 3600000 * 1);

// Insert Agent runs with shadow model comparison
const insertAgent = db.prepare(`
  INSERT OR REPLACE INTO agent_runs (run_id, agent, primary_model, shadow_model, cost_usd, latency_ms, agreement_pct, decision_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

insertAgent.run(
  "run-cmd-01",
  "commander",
  "anthropic/claude-fable-5.1",
  "openai/gpt-5.6-sol",
  0.0142,
  1840,
  94.5,
  JSON.stringify({ regime: "high_volatility", engine_allocations: { liqfade: 0.35, basis: 0.25, imbalance: 0.20, smmirror: 0.20 } }),
  now - 600000
);

insertAgent.run(
  "run-sup-01",
  "supervisor",
  "deepseek/deepseek-v4-pro",
  null,
  0.0031,
  620,
  100.0,
  JSON.stringify({ max_drawdown_tightened: "3.5%", status: "HEALTHY", risk_level: "MODERATE" }),
  now - 300000
);

insertAgent.run(
  "run-coach-01",
  "coach",
  "openai/gpt-6-astra-pro",
  null,
  0.0210,
  3450,
  null,
  JSON.stringify({ dream_cycle: "00:00_UTC", counterfactual_reviewed: 12, invariant_injected: true }),
  now - 120000
);

db.close();

console.log(`\n-> Successfully seeded 60 orders (Total 24h PnL: +$${totalPnl.toFixed(2)}), 3 vetoes, and 3 agent runs.`);
console.log("-> State files ready for professional video recording and demonstration!");
