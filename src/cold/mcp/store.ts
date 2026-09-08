// Persistence for the MCP OAuth client: client registration, tokens, PKCE verifier and discovery
// state live in `<stateDir>/mcp/tokens.json`. Writes are atomic (tmp + rename) so a crash mid-save
// never leaves a truncated file that would force re-registration.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface McpTokenFile {
  /** Result of dynamic client registration (or a pre-registered client id). */
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** PKCE verifier for the in-flight authorization; cleared once the code is exchanged. */
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
}

export type TokenScope = "all" | "client" | "tokens" | "verifier" | "discovery";

export class TokenStore {
  readonly path: string;
  private cache: McpTokenFile | null = null;

  constructor(stateDir: string) {
    this.path = join(stateDir, "mcp", "tokens.json");
  }

  load(): McpTokenFile {
    if (this.cache !== null) return this.cache;
    let parsed: McpTokenFile = {};
    try {
      const raw = readFileSync(this.path, "utf8");
      const json: unknown = JSON.parse(raw);
      if (json !== null && typeof json === "object" && !Array.isArray(json)) parsed = json as McpTokenFile;
    } catch {
      // Missing or corrupt file: start empty; the next save rewrites it.
    }
    this.cache = parsed;
    return parsed;
  }

  patch(update: Partial<McpTokenFile>): void {
    const next = { ...this.load(), ...update };
    this.cache = next;
    this.flush(next);
  }

  clear(scope: TokenScope): void {
    if (scope === "all") {
      this.cache = {};
      this.flush({});
      return;
    }
    const next = { ...this.load() };
    if (scope === "client") delete next.clientInformation;
    else if (scope === "tokens") delete next.tokens;
    else if (scope === "verifier") delete next.codeVerifier;
    else delete next.discovery;
    this.cache = next;
    this.flush(next);
  }

  private flush(file: McpTokenFile): void {
    mkdirSync(join(this.path, ".."), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
