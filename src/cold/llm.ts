// YEScale chat-completions client for the cold lane. One request per call; the agent loop
// owns tool iteration. Records every call in `llm_calls` with the model actually used.
// 429 → one retry after `Retry-After`; 402 → `system.llm_credits` + LlmError('credits').

import type { Bus } from "../core/bus.ts";
import { nowNs } from "../core/clock.ts";
import type { Ledger } from "../core/ledger.ts";
import { logger } from "../core/log.ts";
import type { AgentName, AgentRole } from "../core/types.ts";

const log = logger("cold.llm");

export const YESCALE_BASE_URL = "https://api.yescale.io/v1";
/** Cap on a single 429 back-off so a hostile `Retry-After` cannot stall the scheduler. */
const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 2_000;
export const YESCALE_MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-fable-5-1": { in: 10, out: 50 },
  "claude-fable-5": { in: 10, out: 50 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4-5": { in: 5, out: 25 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "deepseek-v4-pro": { in: 1.04, out: 2.08 },
  "deepseek-v4-flash": { in: 0.21, out: 0.42 },
  "deepseek-v3.2": { in: 0.5, out: 1.0 },
  "gpt-5.6-sol": { in: 2.5, out: 10 },
  "gpt-6-astra": { in: 3.0, out: 12 },
  "gpt-4.1": { in: 2.0, out: 8.0 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gemini-2.5-flash": { in: 0.3, out: 2.499 },
  "gemini-2.5-pro": { in: 1.25, out: 10 },
};

export function estimateTokenCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const norm = model.toLowerCase();
  const exact = YESCALE_MODEL_PRICES[norm];
  if (exact !== undefined) {
    return (promptTokens * exact.in + completionTokens * exact.out) / 1_000_000;
  }
  const sorted = Object.entries(YESCALE_MODEL_PRICES).sort((a, b) => b[0].length - a[0].length);
  const match = sorted.find(([key]) => norm.includes(key));
  const rates = match ? match[1] : { in: 1.0, out: 3.0 };
  return (promptTokens * rates.in + completionTokens * rates.out) / 1_000_000;
}

export interface ToolCallPart {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Assistant messages that requested tools. */
  tool_calls?: ToolCallPart[];
  /** Tool result messages. */
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema (strict-compatible). */
  parameters: object;
}

export interface ChatRequest {
  agent: AgentName;
  model: string;
  /** Fallback models (OpenRouter `models`). */
  models?: string[];
  /** Merged over `{require_parameters:true, allow_fallbacks:true}`. */
  provider?: Record<string, unknown>;
  temperature: number;
  maxTokens?: number;
  messages: Message[];
  tools?: ToolDef[];
  schema?: { name: string; json: object };
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed `function.arguments`; the raw string when it is not valid JSON. */
  args: unknown;
}

export interface ChatResult {
  content: string | null;
  /** `JSON.parse(content)` when `schema` was requested and the content parsed; else undefined. */
  parsed: unknown;
  toolCalls: ToolCall[];
  modelUsed: string;
  usage: { prompt: number; completion: number; costUsd: number };
  latencyMs: number;
  finish: string;
}

export type LlmErrorCode = "credits" | "rate" | "http" | "parse";

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface ChatDeps {
  apiKey: string;
  ledger: Ledger;
  runId: string;
  role: AgentRole;
  bus?: Bus;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** AbortSignal shared with the request fetch; the 429 retry sleep is interrupted when it fires. */
  signal?: AbortSignal;
  /** Injectable for tests; default `setTimeout`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface OpenRouterResponse {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: ToolCallPart[] };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) { reject(signal.reason ?? new Error("aborted")); return promise; }
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
  return promise;
};

function sleepInterruptible(ms: number, signal: AbortSignal | undefined, injectable: ChatDeps["sleep"]): Promise<void> {
  return (injectable ?? defaultSleep)(ms, signal);
}

export function buildBody(req: ChatRequest): Record<string, unknown> {
  const messages = [...req.messages];
  if (req.schema !== undefined && req.model.toLowerCase().includes("claude")) {
    messages.push({
      role: "system",
      content: `Respond ONLY with a valid JSON object matching the requested schema (${req.schema.name}). Do not wrap in markdown fences (\`\`\`json) and do not include any preamble or extra text.`,
    });
  }
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    temperature: req.temperature,
  };
  if (req.provider !== undefined) body.provider = req.provider;
  if (req.models !== undefined && req.models.length > 0) body.models = req.models;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.tools !== undefined && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters, strict: true },
    }));
    body.tool_choice = "auto";
  }
  if (req.schema !== undefined) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: req.schema.name, strict: true, schema: req.schema.json },
    };
  }
  return body;
}

function retryAfterMs(res: Response): number {
  const h = res.headers.get("retry-after");
  if (h === null) return DEFAULT_RETRY_AFTER_MS;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

async function post(req: ChatRequest, deps: ChatDeps, body: string): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const url = `${deps.baseUrl ?? YESCALE_BASE_URL}/chat/completions`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.apiKey}`,
      "Content-Type": "application/json",
    },
    body,
  };
  try {
    return await doFetch(url, init);
  } catch (err) {
    throw new LlmError("http", 0, `yescale fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function chat(req: ChatRequest, deps: ChatDeps): Promise<ChatResult> {
  const body = JSON.stringify(buildBody(req));
  const t0 = nowNs();

  let res = await post(req, deps, body);
  if (res.status === 429) {
    const ms = retryAfterMs(res);
    log.warn("yescale 429; retrying once", { agent: req.agent, model: req.model, retryAfterMs: ms });
    await res.body?.cancel();
    await sleepInterruptible(ms, deps.signal, deps.sleep);
    res = await post(req, deps, body);
  }

  if (res.status === 402) {
    await res.body?.cancel();
    log.error("yescale 402: out of credits", { agent: req.agent, model: req.model });
    deps.bus?.emit("system.llm_credits", { agent: req.agent, model: req.model, status: 402, tsNs: nowNs() });
    throw new LlmError("credits", 402, "yescale: insufficient credits");
  }
  if (res.status === 429) {
    await res.body?.cancel();
    throw new LlmError("rate", 429, "yescale: rate limited after retry");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError("http", res.status, `yescale ${res.status}: ${text.slice(0, 300)}`);
  }

  let json: OpenRouterResponse;
  try {
    json = (await res.json()) as OpenRouterResponse;
  } catch (err) {
    throw new LlmError("parse", res.status, `yescale: invalid JSON body (${err instanceof Error ? err.message : String(err)})`);
  }
  const latencyMs = (nowNs() - t0) / 1e6;
  if (json.error !== undefined) {
    throw new LlmError("http", json.error.code ?? res.status, `yescale error: ${json.error.message ?? "unknown"}`);
  }
  const choice = json.choices?.[0];
  if (choice === undefined || choice.message === undefined) {
    throw new LlmError("parse", res.status, "yescale: response has no choices");
  }

  const content = choice.message.content ?? null;
  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => {
    let args: unknown = tc.function.arguments;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      // keep raw string; the tool layer rejects it
    }
    return { id: tc.id, name: tc.function.name, args };
  });

  let parsed: unknown;
  let schemaValid = true;
  if (req.schema !== undefined && toolCalls.length === 0) {
    schemaValid = false;
    if (content !== null) {
      try {
        const clean = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim();
        parsed = JSON.parse(clean);
        schemaValid = true;
      } catch {
        // caller retries with a corrective message
      }
    }
  }

  const modelUsed = json.model ?? req.model;
  const promptTokens = json.usage?.prompt_tokens ?? 0;
  const completionTokens = json.usage?.completion_tokens ?? 0;
  const costUsd = typeof json.usage?.cost === "number"
    ? json.usage.cost
    : estimateTokenCostUsd(modelUsed, promptTokens, completionTokens);

  const usage = {
    prompt: promptTokens,
    completion: completionTokens,
    costUsd,
  };

  deps.ledger.insertLlmCall({
    runId: deps.runId,
    agent: req.agent,
    role: deps.role,
    model: modelUsed,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    costUsd: usage.costUsd,
    latencyMs,
    schemaValid,
  });

  return { content, parsed, toolCalls, modelUsed, usage, latencyMs, finish: choice.finish_reason ?? "unknown" };
}
