import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpBridge, McpError, isReadOnlyTool } from "../../src/cold/mcp/client.ts";

describe("mcp read-only whitelist", () => {
  test("prefix guard accepts reads and refuses writes", () => {
    expect(isReadOnlyTool("get_balance")).toBe(true);
    expect(isReadOnlyTool("list_orders")).toBe(true);
    expect(isReadOnlyTool("query_trades")).toBe(true);
    expect(isReadOnlyTool("Read_Account")).toBe(true);
    expect(isReadOnlyTool("create_order")).toBe(false);
    expect(isReadOnlyTool("cancel_order")).toBe(false);
    expect(isReadOnlyTool("forget_get_")).toBe(false);
    expect(isReadOnlyTool("get_balance", ["query_"])).toBe(false);
  });

  test("bridge refuses create_order before any network I/O, and get_balance only fails for lack of connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hydra-mcp-"));
    try {
      const bridge = new McpBridge({ url: "http://127.0.0.1:9/mcp", stateDir: dir, print: () => {} });
      expect(bridge.allowed("get_balance")).toBe(true);
      expect(bridge.allowed("create_order")).toBe(false);

      const refused = await bridge.call("create_order", { symbol: "BTCUSDT" }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(McpError);
      expect((refused as McpError).code).toBe("not_whitelisted");

      // Whitelisted name passes the guard; the next check is connection state, not the whitelist.
      const unconnected = await bridge.call("get_balance").catch((e: unknown) => e);
      expect(unconnected).toBeInstanceOf(McpError);
      expect((unconnected as McpError).code).toBe("not_connected");
      await bridge.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
