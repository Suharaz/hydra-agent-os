// Binance MCP bridge: StreamableHTTP transport + OAuth provider + read-only tool whitelist.
// Every `call()` passes the whitelist before any network I/O, so an LLM agent that has been
// handed `mcp.*` tools can never reach a mutating endpoint through this class.

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { logger } from "../../core/log.ts";
import { HydraOAuthProvider } from "./oauth.ts";
import { TokenStore } from "./store.ts";

const log = logger("mcp");

export const DEFAULT_MCP_URL = "https://mcp.binance.com/mcp";
/** Tool-name prefixes considered read-only. Anything else is refused client-side. */
export const DEFAULT_READ_ONLY: readonly string[] = ["get_", "list_", "query_", "read_"];

/** Resolved lazily so tests and the CLI can override via `MCP_URL` without touching env.ts. */
export function mcpUrl(): string {
  const v = process.env.MCP_URL;
  return v !== undefined && v.length > 0 ? v : DEFAULT_MCP_URL;
}

export type McpErrorCode = "not_whitelisted" | "not_connected" | "auth" | "tool";

export class McpError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** True when `name` starts with one of `prefixes` (case-insensitive on the name). */
export function isReadOnlyTool(name: string, prefixes: readonly string[] = DEFAULT_READ_ONLY): boolean {
  const n = name.toLowerCase();
  for (const p of prefixes) if (n.startsWith(p)) return true;
  return false;
}

export interface McpToolInfo {
  name: string;
  description: string;
  /** Whether this bridge would allow `call()` on it. */
  readOnly: boolean;
}

export interface McpBridgeOptions {
  url?: string;
  stateDir: string;
  /** Whitelist prefixes; defaults to {@link DEFAULT_READ_ONLY}. */
  readOnly?: readonly string[];
  /** Maximum wait for the operator to complete the browser authorization. */
  authTimeoutMs?: number;
  /** Where the authorization URL is printed (stderr by default). */
  print?: (line: string) => void;
}

export class McpBridge {
  readonly url: URL;
  readonly readOnly: readonly string[];
  private readonly provider: HydraOAuthProvider;
  private readonly authTimeoutMs: number;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;

  constructor(opts: McpBridgeOptions) {
    this.url = new URL(opts.url ?? mcpUrl());
    this.readOnly = opts.readOnly ?? DEFAULT_READ_ONLY;
    this.authTimeoutMs = opts.authTimeoutMs ?? 5 * 60_000;
    const printOpt = opts.print;
    this.provider = new HydraOAuthProvider(new TokenStore(opts.stateDir), printOpt === undefined ? {} : { print: printOpt });
  }

  allowed(name: string): boolean {
    return isReadOnlyTool(name, this.readOnly);
  }

  /**
   * Connects; on a 401 with no usable tokens the SDK prints the authorization URL through the
   * provider, we wait for the loopback callback, exchange the code, and reconnect on a fresh
   * transport (the SDK requires that after `finishAuth`).
   */
  async connect(): Promise<void> {
    if (this.client !== null) return;
    const client = new Client({ name: "hydra", version: "0.1.0" });
    let transport = this.newTransport();
    try {
      await client.connect(transport);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        this.provider.close();
        throw err;
      }
      let code: string;
      try {
        code = await this.provider.waitForAuthorizationCode(this.authTimeoutMs);
        await transport.finishAuth(code);
      } catch (authErr) {
        this.provider.close();
        throw new McpError("auth", authErr instanceof Error ? authErr.message : String(authErr));
      }
      transport = this.newTransport();
      await client.connect(transport);
    }
    this.client = client;
    this.transport = transport;
    log.info("mcp connected", { url: this.url.href, sessionId: transport.sessionId ?? null });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const client = this.requireClient();
    const { tools } = await client.listTools();
    const out: McpToolInfo[] = new Array(tools.length);
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i]!;
      out[i] = { name: t.name, description: t.description ?? "", readOnly: this.allowed(t.name) };
    }
    return out;
  }

  /** Rejects non-whitelisted tools before touching the network; returns structured content when present. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.allowed(name)) {
      log.warn("mcp call refused by whitelist", { tool: name });
      throw new McpError("not_whitelisted", `mcp tool '${name}' is not read-only (allowed prefixes: ${this.readOnly.join(", ")})`);
    }
    const client = this.requireClient();
    const result = await client.callTool({ name, arguments: args });
    if (result.isError === true) {
      throw new McpError("tool", `mcp tool '${name}' failed: ${textOf(result.content)}`);
    }
    return result.structuredContent ?? result.content;
  }

  async close(): Promise<void> {
    this.provider.close();
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    if (transport !== null) await transport.close();
  }

  private newTransport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(this.url, { authProvider: this.provider });
  }

  private requireClient(): Client {
    if (this.client === null) throw new McpError("not_connected", "mcp bridge not connected; call connect() first");
    return this.client;
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c !== null && typeof c === "object" && "type" in c && c.type === "text" && "text" in c) parts.push(String(c.text));
  }
  return parts.join(" ").slice(0, 500);
}
