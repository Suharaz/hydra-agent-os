// Offline rig for cold-lane tests: temp config/state dirs seeded from the repo, in-memory ledger,
// tool deps with a fake kill switch, and a scripted `chat` replacement keyed by model.

import type { AgentDeps } from "../../src/cold/agent.ts";
import type { ChatDeps, ChatRequest, ChatResult } from "../../src/cold/llm.ts";
import type { ToolDeps } from "../../src/cold/tools.ts";
import { Bus } from "../../src/core/bus.ts";
import { loadConfig } from "../../src/core/config.ts";
import { anyVenueLive, type Env, loadEnv } from "../../src/core/env.ts";
import { effective } from "../../src/core/limits.ts";
import { openLedger } from "../../src/core/ledger.ts";
import { readKillLock, readLimits } from "../../src/core/state.ts";
import type { Mode } from "../../src/core/types.ts";
import { cleanup, tempConfigDir, tempDir } from "../core/helpers.ts";

export const NOW = 1_760_000_000_000; // 2025-10-09T08:53:20Z

export interface Rig {
  deps: AgentDeps;
  toolDeps: ToolDeps;
  kills: string[];
  configDir: string;
  stateDir: string;
  dispose(): void;
}

export function makeEnv(mode: Mode): Env {
  const env = loadEnv({ source: { HYDRA_MODE: "demo" }, warn: () => {}, notice: () => {} });
  return { ...env, mode, openrouterApiKey: "test-key" };
}

export function rig(opts: { mode?: Mode; chat?: AgentDeps["chat"]; nav?: number } = {}): Rig {
  const configDir = tempConfigDir();
  const stateDir = tempDir();
  const config = loadConfig(configDir);
  const ledger = openLedger(":memory:");
  const env = makeEnv(opts.mode ?? "demo");
  const kills: string[] = [];
  const killLocked = () => readKillLock(stateDir) !== null;
  const toolDeps: ToolDeps = {
    ledger,
    configDir,
    stateDir,
    risk: config.risk,
    // Mirror buildAgentDeps: mode reflects actual real-money status of any venue flag.
    mode: anyVenueLive(env) ? "live" : env.mode,
    engines: () => loadConfig(configDir).engines,
    limits: () => effective(config.risk, readLimits(stateDir), NOW, killLocked()),
    killLocked,
    kill: async (reason) => {
      kills.push(reason);
      return { flat: true };
    },
    nav: () => opts.nav ?? 5000,
  };
  const deps: AgentDeps = {
    env,
    config,
    ledger,
    stateDir,
    configDir,
    risk: config.risk,
    toolDeps,
    apiKey: "test-key",
    chat: opts.chat,
    registry: null,
    positions: null,
    now: () => NOW,
    bus: new Bus(),
  };
  return {
    deps,
    toolDeps,
    kills,
    configDir,
    stateDir,
    dispose() {
      ledger.close();
      cleanup(configDir);
      cleanup(stateDir);
    },
  };
}

export interface ChatCall {
  req: ChatRequest;
  deps: ChatDeps;
}

export type Script = (call: ChatCall, index: number) => ChatResult | Promise<ChatResult>;

/** A `ChatResult` carrying `obj` as JSON content (no tool calls). */
export function answer(obj: unknown, model: string, costUsd = 0.01): ChatResult {
  const content = typeof obj === "string" ? obj : JSON.stringify(obj);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = undefined;
  }
  return { content, parsed, toolCalls: [], modelUsed: model, usage: { prompt: 100, completion: 50, costUsd }, latencyMs: 5, finish: "stop" };
}

/** Scripted chat keyed by requested model; each script sees its own per-model call index. Records every call. */
export function fakeChat(scripts: Record<string, Script>): { chat: NonNullable<AgentDeps["chat"]>; calls: ChatCall[] } {
  const calls: ChatCall[] = [];
  const counts: Record<string, number> = {};
  const chat: NonNullable<AgentDeps["chat"]> = async (req, deps) => {
    calls.push({ req, deps });
    const script = scripts[req.model];
    if (script === undefined) throw new Error(`no script for model ${req.model}`);
    const i = counts[req.model] ?? 0;
    counts[req.model] = i + 1;
    const r = await script({ req, deps }, i);
    deps.ledger.insertLlmCall({
      runId: deps.runId,
      agent: req.agent,
      role: deps.role,
      model: r.modelUsed,
      promptTokens: r.usage.prompt,
      completionTokens: r.usage.completion,
      costUsd: r.usage.costUsd,
      latencyMs: r.latencyMs,
      schemaValid: r.parsed !== undefined,
    });
    return r;
  };
  return { chat, calls };
}
