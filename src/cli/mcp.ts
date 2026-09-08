// cli mcp list | mcp call <tool> [json-args] — showcase bridge to the Binance MCP server.
// Disabled unless MCP=on (env.ts defaults the flag to "off"); the skip message documents the
// `claude -p` fallback for servers that refuse dynamic client registration.

import { DEFAULT_MCP_URL, McpBridge, McpError, mcpUrl } from "../cold/mcp/client.ts";
import { STATE_DIR } from "./intent.ts";

export const description = "Inspect or invoke Binance MCP read-only tools: mcp list | mcp call <tool> [json-args]";
export const subverbs = ["list", "call"] as const;

export default async function mcp(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === undefined || !(subverbs as readonly string[]).includes(sub)) {
    console.error(`usage: hydra mcp <${subverbs.join("|")}> [tool] [json-args]`);
    return 2;
  }
  if (process.env.MCP !== "on") {
    const url = mcpUrl();
    console.error(
      [
        "mcp: skipped (MCP=off is the default; set MCP=on to enable the bridge).",
        `Bridge target: ${url}${url === DEFAULT_MCP_URL ? "" : " (MCP_URL override)"}; OAuth callback on http://127.0.0.1:8790/callback.`,
        "",
        "Fallback if the server refuses dynamic client registration: use Claude Code with the server registered,",
        `  claude mcp add --transport http binance ${url}`,
        '  claude -p "list the Binance MCP tools available to me"',
        "Claude Code completes the OAuth flow in its own browser session; HYDRA's bridge is not required for the showcase.",
      ].join("\n"),
    );
    return 2;
  }

  let callArgs: Record<string, unknown> = {};
  const tool = args[1];
  if (sub === "call") {
    if (tool === undefined) {
      console.error("usage: hydra mcp call <tool> [json-args]");
      return 2;
    }
    const raw = args[2];
    if (raw !== undefined) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("json-args must be an object");
        callArgs = parsed as Record<string, unknown>; // validated above: non-null, non-array object
      } catch (err) {
        console.error(`mcp call: bad json-args: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
      }
    }
  }

  const bridge = new McpBridge({ stateDir: STATE_DIR });
  try {
    await bridge.connect();
    if (sub === "list") {
      const tools = await bridge.listTools();
      for (const t of tools) console.log(`${t.readOnly ? "  " : "x "}${t.name}\t${t.description}`);
      console.error(`${tools.length} tools; 'x' marks tools the read-only whitelist refuses.`);
      return 0;
    }
    const result = await bridge.call(tool!, callArgs);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`mcp ${sub} failed: ${msg}`);
    return err instanceof McpError && err.code === "not_whitelisted" ? 3 : 1;
  } finally {
    await bridge.close();
  }
}
