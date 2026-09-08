// Browser sessions for the dashboard: in-memory only (a restart revokes everything), idle and
// absolute TTLs, bounded count, and single-use WebSocket tickets so no credential ever sits in a
// URL. Pure: the clock is injectable and nothing here touches the network or the filesystem.

export type Role = "viewer" | "operator";

export interface Session {
  id: string;
  role: Role;
  createdAt: number;
  lastSeenAt: number;
  ua: string;
}

export interface SessionStoreOptions {
  idleMs: number;
  absoluteMs: number;
  /** Oldest session is evicted when a new one would exceed this. */
  max: number;
  ticketMs?: number;
  now?: () => number;
}

interface Ticket {
  sessionId: string;
  expiresAt: number;
}

export const SESSION_COOKIE = "hydra_session";
export const DEFAULT_IDLE_MS = 12 * 3_600_000;
export const DEFAULT_ABSOLUTE_MS = 24 * 3_600_000;
export const DEFAULT_MAX_SESSIONS = 16;
export const DEFAULT_TICKET_MS = 30_000;

function randomId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly tickets = new Map<string, Ticket>();
  /** One live ticket per session: issuing a new one invalidates the previous. */
  private readonly ticketBySession = new Map<string, string>();
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly max: number;
  private readonly ticketMs: number;
  private readonly now: () => number;

  constructor(opts: SessionStoreOptions) {
    this.idleMs = opts.idleMs;
    this.absoluteMs = opts.absoluteMs;
    this.max = opts.max;
    this.ticketMs = opts.ticketMs ?? DEFAULT_TICKET_MS;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    this.sweep();
    return this.sessions.size;
  }

  create(role: Role, ua: string): Session {
    this.sweep();
    while (this.sessions.size >= this.max) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.revoke(oldest);
    }
    const t = this.now();
    const s: Session = { id: randomId(), role, createdAt: t, lastSeenAt: t, ua };
    this.sessions.set(s.id, s);
    return s;
  }

  /** Returns the session and refreshes its idle timer; null when unknown or expired. */
  get(id: string): Session | null {
    const s = this.sessions.get(id);
    if (s === undefined) return null;
    if (this.expired(s)) {
      this.revoke(id);
      return null;
    }
    s.lastSeenAt = this.now();
    return s;
  }

  revoke(id: string): void {
    this.sessions.delete(id);
    const ticket = this.ticketBySession.get(id);
    if (ticket !== undefined) {
      this.tickets.delete(ticket);
      this.ticketBySession.delete(id);
    }
  }

  revokeAll(): number {
    const n = this.sessions.size;
    this.sessions.clear();
    this.tickets.clear();
    this.ticketBySession.clear();
    return n;
  }

  issueTicket(sessionId: string): string | null {
    if (this.get(sessionId) === null) return null;
    const previous = this.ticketBySession.get(sessionId);
    if (previous !== undefined) this.tickets.delete(previous);
    const ticket = randomId();
    this.tickets.set(ticket, { sessionId, expiresAt: this.now() + this.ticketMs });
    this.ticketBySession.set(sessionId, ticket);
    return ticket;
  }

  /** Single use: the ticket is deleted whether or not it was still valid. */
  consumeTicket(ticket: string): Session | null {
    const t = this.tickets.get(ticket);
    if (t === undefined) return null;
    this.tickets.delete(ticket);
    if (this.ticketBySession.get(t.sessionId) === ticket) this.ticketBySession.delete(t.sessionId);
    if (t.expiresAt <= this.now()) return null;
    return this.get(t.sessionId);
  }

  private expired(s: Session): boolean {
    const t = this.now();
    return t - s.lastSeenAt > this.idleMs || t - s.createdAt > this.absoluteMs;
  }

  private sweep(): void {
    for (const [id, s] of this.sessions) if (this.expired(s)) this.revoke(id);
  }
}

/** Value of one cookie from a Cookie header, or null. */
export function cookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
