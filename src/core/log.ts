// JSON-lines logger to stdout with a 2k-entry ring buffer for the dashboard.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  mod: string;
  msg: string;
  data?: Record<string, unknown>;
}

const RING_SIZE = 2000;
const ring: (LogEntry | undefined)[] = new Array(RING_SIZE);
let head = 0;
let count = 0;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel: LogLevel = (process.env.HYDRA_LOG_LEVEL as LogLevel | undefined) ?? "info";
let sink: (line: string) => void = (line) => {
  process.stdout.write(line + "\n");
};

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/** Replace the stdout sink (tests). Returns the previous sink. */
export function setLogSink(next: (line: string) => void): (line: string) => void {
  const prev = sink;
  sink = next;
  return prev;
}

function push(entry: LogEntry): void {
  ring[head] = entry;
  head = (head + 1) % RING_SIZE;
  if (count < RING_SIZE) count++;
  if (LEVEL_RANK[entry.level] >= LEVEL_RANK[minLevel]) sink(JSON.stringify(entry));
}

/** Most recent `n` entries, oldest first. */
export function recent(n: number = 200): LogEntry[] {
  const take = Math.min(n, count);
  const out: LogEntry[] = new Array(take);
  let idx = (head - take + RING_SIZE) % RING_SIZE;
  for (let i = 0; i < take; i++) {
    out[i] = ring[idx] as LogEntry;
    idx = (idx + 1) % RING_SIZE;
  }
  return out;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export function logger(mod: string): Logger {
  const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>) => {
    const entry: LogEntry = { ts: Date.now(), level, mod, msg };
    if (data !== undefined) entry.data = data;
    push(entry);
  };
  return {
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
  };
}
