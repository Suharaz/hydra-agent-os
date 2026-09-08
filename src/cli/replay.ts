// `replay <fixture.ndjson> [--speed N]` — OFFLINE REPLAY: pushes recorded `{t_ms, stream, data}`
// frames through FeedHub.applyFrame with the original relative timing divided by `speed`, then
// prints how many bus events each name saw.
// No network: REST, sockets and on-chain adapters are all null.  This command is explicitly an
// offline, deterministic replay harness; it never contacts any venue or account.

import { readFileSync } from "node:fs";
import { bus, EVENT_NAMES, type EventName } from "../core/bus.ts";
import { FeedHub } from "../hot/feed-hub.ts";
import type { Frame } from "../venues/binance/ws.ts";
export const description = "[OFFLINE REPLAY] Replay a recorded NDJSON feed fixture through the FeedHub (no network, no accounts) and print bus event counts";

interface FixtureFrame {
  t_ms: number;
  frame: Frame;
}

export function parseFixture(text: string): FixtureFrame[] {
  const out: FixtureFrame[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const obj = JSON.parse(line) as Record<string, unknown>;
    const data = obj.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    const rec = data as Record<string, unknown>;
    out.push({
      t_ms: typeof obj.t_ms === "number" ? obj.t_ms : out.length * 1000,
      frame: { stream: typeof obj.stream === "string" ? obj.stream : null, e: typeof rec.e === "string" ? rec.e : null, data: rec },
    });
  }
  return out;
}

export default async function replay(args: string[]): Promise<number> {
  console.log("[OFFLINE REPLAY] no network, no accounts — deterministic fixture playback only");
  let file: string | null = null;
  let speed = 1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--speed") {
      speed = Number(args[++i]);
      if (!Number.isFinite(speed) || speed <= 0) {
        console.error("replay: --speed must be a positive number");
        return 2;
      }
    } else if (a.startsWith("--speed=")) {
      speed = Number(a.slice("--speed=".length));
      if (!Number.isFinite(speed) || speed <= 0) {
        console.error("replay: --speed must be a positive number");
        return 2;
      }
    } else if (file === null) file = a;
    else {
      console.error(`replay: unexpected argument ${a}`);
      return 2;
    }
  }
  if (file === null) {
    console.error("usage: replay <fixture.ndjson> [--speed N]");
    return 2;
  }
  let frames: FixtureFrame[];
  try {
    frames = parseFixture(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`replay: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const counts: Record<string, number> = {};
  const offs: (() => void)[] = [];
  for (const name of EVENT_NAMES) {
    counts[name] = 0;
    offs.push(bus.on(name as EventName, () => {
      counts[name] = (counts[name] as number) + 1;
    }));
  }
  const hub = new FeedHub({
    futuresRest: null,
    spotRest: null,
    wsFactory: null,
    onchain: null,
    skills: null,
    urls: null,
    mode: "demo",
    risk: { allowed_symbols: { futures: [], spot: [], dex: [] } },
  });

  const started = Date.now();
  let prevT = frames.length > 0 ? (frames[0] as FixtureFrame).t_ms : 0;
  for (const f of frames) {
    const delay = (f.t_ms - prevT) / speed;
    if (delay > 0) await Bun.sleep(delay);
    prevT = f.t_ms;
    hub.applyFrame(f.frame);
  }
  for (const off of offs) off();

  console.log(`replayed ${frames.length} frames from ${file} at ${speed}x in ${Date.now() - started} ms`);
  for (const name of EVENT_NAMES) if ((counts[name] as number) > 0) console.log(`${name} ${counts[name]}`);
  return 0;
}
