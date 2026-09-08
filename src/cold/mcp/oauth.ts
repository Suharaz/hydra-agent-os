// OAuthClientProvider for the SDK's StreamableHTTP transport. The SDK drives discovery, dynamic
// client registration, PKCE and token refresh; this class persists what it hands us (TokenStore),
// prints the authorization URL (never spawns a browser), and runs a one-shot loopback callback
// server on 127.0.0.1:8790 that captures the authorization code.

import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

import { logger } from "../../core/log.ts";
import type { TokenScope, TokenStore } from "./store.ts";

const log = logger("mcp.oauth");

export const CALLBACK_HOST = "127.0.0.1";
export const CALLBACK_PORT = 8790;
export const CALLBACK_PATH = "/callback";

export interface OAuthProviderOptions {
  port?: number;
  /** Where the authorization URL is printed; defaults to stderr. */
  print?: (line: string) => void;
}

export class HydraOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly port: number;
  private readonly print: (line: string) => void;
  private lastState: string | null = null;
  private pending: { resolve: (code: string) => void; reject: (err: Error) => void } | null = null;
  private server: Bun.Server<undefined> | null = null;

  constructor(
    private readonly store: TokenStore,
    opts: OAuthProviderOptions = {},
  ) {
    this.port = opts.port ?? CALLBACK_PORT;
    this.print = opts.print ?? ((line) => process.stderr.write(line + "\n"));
    this.redirectUrl = `http://${CALLBACK_HOST}:${this.port}${CALLBACK_PATH}`;
    this.clientMetadata = {
      client_name: "HYDRA",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.lastState = crypto.randomUUID();
    return this.lastState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.load().clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.store.patch({ clientInformation: info });
    log.info("registered oauth client", { clientId: info.client_id });
  }

  tokens(): OAuthTokens | undefined {
    return this.store.load().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.patch({ tokens });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.patch({ codeVerifier });
  }

  codeVerifier(): string {
    const v = this.store.load().codeVerifier;
    if (v === undefined) throw new Error("mcp oauth: no PKCE code verifier saved; restart the authorization flow");
    return v;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.store.patch({ discovery: state });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.store.load().discovery;
  }

  invalidateCredentials(scope: TokenScope): void {
    this.store.clear(scope);
  }

  /**
   * Called by the SDK when the server demands interactive authorization. Starts the loopback
   * listener first so the redirect cannot race ahead of us, then prints the URL for the operator.
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    this.listen();
    this.print("");
    this.print("HYDRA needs authorization for the Binance MCP server. Open this URL in a browser:");
    this.print("");
    this.print(`  ${authorizationUrl.href}`);
    this.print("");
    this.print(`Waiting for the callback on ${this.redirectUrl} ...`);
  }

  /** Resolves with the authorization code once the browser hits the callback; rejects on timeout/error. */
  waitForAuthorizationCode(timeoutMs: number = 5 * 60_000): Promise<string> {
    if (this.pending !== null) return Promise.reject(new Error("mcp oauth: authorization already in progress"));
    this.listen();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(new Error(`mcp oauth: no callback within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending = {
        resolve: (code) => {
          clearTimeout(timer);
          resolve(code);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
    });
  }

  /** Stops the callback server if it is running. Safe to call repeatedly. */
  close(): void {
    if (this.server !== null) {
      this.server.stop(true);
      this.server = null;
    }
    if (this.pending !== null) {
      const p = this.pending;
      this.pending = null;
      p.reject(new Error("mcp oauth: callback server closed"));
    }
  }

  private listen(): void {
    if (this.server !== null) return;
    this.server = Bun.serve({
      hostname: CALLBACK_HOST,
      port: this.port,
      fetch: (req) => this.handle(req),
    });
    log.info("oauth callback server listening", { url: this.redirectUrl });
  }

  private handle(req: Request): Response {
    const url = new URL(req.url);
    if (url.pathname !== CALLBACK_PATH) return new Response("not found", { status: 404 });
    const error = url.searchParams.get("error");
    if (error !== null) {
      const desc = url.searchParams.get("error_description") ?? "";
      this.settle(new Error(`mcp oauth: authorization failed: ${error} ${desc}`.trim()));
      return html(400, "Authorization failed. You can close this tab.");
    }
    const state = url.searchParams.get("state");
    if (this.lastState === null || state !== this.lastState) {
      log.warn("oauth callback state mismatch");
      return html(400, "State mismatch. Restart the authorization from HYDRA.");
    }
    const code = url.searchParams.get("code");
    if (code === null || code.length === 0) return html(400, "Missing authorization code.");
    this.settle(code);
    return html(200, "HYDRA is authorized. You can close this tab.");
  }

  private settle(outcome: string | Error): void {
    const p = this.pending;
    this.pending = null;
    if (this.server !== null) {
      // Stop after the response has flushed; a hard stop here would drop the in-flight reply.
      const s = this.server;
      this.server = null;
      setTimeout(() => s.stop(true), 50);
    }
    if (p === null) return;
    if (typeof outcome === "string") p.resolve(outcome);
    else p.reject(outcome);
  }
}

function html(status: number, body: string): Response {
  return new Response(`<!doctype html><title>HYDRA</title><p>${body}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
