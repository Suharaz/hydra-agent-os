// alert(level, msg): Telegram Bot API sendMessage with retry, generic webhook fallback,
// no-op + log.warn when nothing is configured. Never throws; callers (kill.ts, guardian) must
// not be able to die because the alert channel is down.

import { logger } from "./log.ts";

export type AlertLevel = "info" | "warn" | "critical";

export interface AlertConfig {
  telegramBotToken?: string | null;
  telegramChatId?: string | null;
  webhookUrl?: string | null;
  /** Injectable for tests. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Injectable for tests; defaults to Bun.sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const log = logger("alert");
const BACKOFF_MS = [200, 400, 800] as const;
const LEVEL_PREFIX: Record<AlertLevel, string> = { info: "INFO", warn: "WARN", critical: "CRITICAL" };

let cfg: Required<AlertConfig> = {
  telegramBotToken: null,
  telegramChatId: null,
  webhookUrl: null,
  fetch: (url, init) => globalThis.fetch(url, init),
  sleep: (ms) => Bun.sleep(ms),
};

export function configureAlert(next: AlertConfig): void {
  cfg = {
    telegramBotToken: next.telegramBotToken ?? null,
    telegramChatId: next.telegramChatId ?? null,
    webhookUrl: next.webhookUrl ?? null,
    fetch: next.fetch ?? cfg.fetch,
    sleep: next.sleep ?? cfg.sleep,
  };
}

/** POST JSON; up to 1 + BACKOFF_MS.length attempts. Returns true on a 2xx response. */
async function postWithRetry(url: string, body: unknown, channel: string): Promise<boolean> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await cfg.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
      if (res.ok) return true;
      log.warn(`${channel} responded ${res.status}`, { attempt });
    } catch (err) {
      log.warn(`${channel} request failed`, { attempt, error: err instanceof Error ? err.message : String(err) });
    }
    const wait = BACKOFF_MS[attempt];
    if (wait === undefined) return false;
    await cfg.sleep(wait);
  }
}

export async function alert(level: AlertLevel, msg: string): Promise<void> {
  const ts = Date.now();
  try {
    if (cfg.telegramBotToken !== null && cfg.telegramChatId !== null) {
      const ok = await postWithRetry(
        `https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`,
        { chat_id: cfg.telegramChatId, text: `[${LEVEL_PREFIX[level]}] ${msg}`, disable_web_page_preview: true },
        "telegram",
      );
      if (ok) return;
    }
    if (cfg.webhookUrl !== null) {
      if (await postWithRetry(cfg.webhookUrl, { level, msg, ts }, "webhook")) return;
      log.error("alert undeliverable on every channel", { level, msg });
      return;
    }
    if (cfg.telegramBotToken === null) log.warn("no alert channel configured; alert dropped", { level, msg });
    else log.error("alert undeliverable (telegram failed, no webhook fallback)", { level, msg });
  } catch (err) {
    log.error("alert() internal failure", { error: err instanceof Error ? err.message : String(err), level, msg });
  }
}
