import { describe, expect, test } from "bun:test";
import { Lockout } from "../../src/dashboard/lockout.ts";
import { cookie, SessionStore } from "../../src/dashboard/session.ts";

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
};

describe("SessionStore", () => {
  test("idle and absolute expiry; get() refreshes idle but not absolute", () => {
    const c = clock();
    const s = new SessionStore({ idleMs: 100, absoluteMs: 1000, max: 4, now: c.now });
    const a = s.create("operator", "ua");
    c.tick(90);
    expect(s.get(a.id)?.role).toBe("operator");
    c.tick(90); // 180 since creation, 90 since last seen
    expect(s.get(a.id)).not.toBeNull();
    c.tick(101);
    expect(s.get(a.id)).toBeNull();

    const b = s.create("viewer", "ua");
    for (let i = 0; i < 10; i++) {
      c.tick(90);
      expect(s.get(b.id)).not.toBeNull();
    }
    c.tick(101); // 1001 ms since creation: absolute limit, even though never idle
    expect(s.get(b.id)).toBeNull();
  });

  test("oldest session is evicted at the cap", () => {
    const c = clock();
    const s = new SessionStore({ idleMs: 1e6, absoluteMs: 1e6, max: 2, now: c.now });
    const a = s.create("operator", "");
    const b = s.create("operator", "");
    const d = s.create("operator", "");
    expect(s.get(a.id)).toBeNull();
    expect(s.get(b.id)).not.toBeNull();
    expect(s.get(d.id)).not.toBeNull();
    expect(s.size).toBe(2);
  });

  test("tickets are single-use, expire, and a fresh ticket invalidates the previous one", () => {
    const c = clock();
    const s = new SessionStore({ idleMs: 1e6, absoluteMs: 1e6, max: 4, ticketMs: 30, now: c.now });
    const a = s.create("viewer", "");
    const t1 = s.issueTicket(a.id);
    expect(t1).not.toBeNull();
    const t2 = s.issueTicket(a.id);
    expect(s.consumeTicket(t1 ?? "")).toBeNull(); // superseded
    expect(s.consumeTicket(t2 ?? "")?.role).toBe("viewer");
    expect(s.consumeTicket(t2 ?? "")).toBeNull(); // single use
    const t3 = s.issueTicket(a.id) ?? "";
    c.tick(31);
    expect(s.consumeTicket(t3)).toBeNull(); // expired
    expect(s.issueTicket("nope")).toBeNull();
  });

  test("revokeAll drops sessions and their tickets", () => {
    const s = new SessionStore({ idleMs: 1e6, absoluteMs: 1e6, max: 4 });
    const a = s.create("operator", "");
    const t = s.issueTicket(a.id) ?? "";
    expect(s.revokeAll()).toBe(1);
    expect(s.get(a.id)).toBeNull();
    expect(s.consumeTicket(t)).toBeNull();
  });

  test("cookie() picks the named cookie only", () => {
    expect(cookie("a=1; hydra_session=abc; b=2", "hydra_session")).toBe("abc");
    expect(cookie("xhydra_session=abc", "hydra_session")).toBeNull();
    expect(cookie(undefined, "hydra_session")).toBeNull();
  });
});

describe("Lockout", () => {
  test("engages exactly once on the Nth failure inside the window, lifts after lockMs, ignores failures while locked", () => {
    const c = clock();
    const l = new Lockout({ max: 3, windowMs: 100, lockMs: 50, now: c.now });
    expect(l.fail()).toBe(false);
    expect(l.fail()).toBe(false);
    expect(l.locked()).toBe(0);
    expect(l.fail()).toBe(true);
    expect(l.locked()).toBe(50);
    expect(l.fail()).toBe(false); // already locked
    c.tick(50);
    expect(l.locked()).toBe(0);
    // Window slid: two old failures are gone, one new failure does not lock.
    expect(l.fail()).toBe(false);
    expect(l.locked()).toBe(0);
  });

  test("failures outside the window do not count; succeed() clears the window", () => {
    const c = clock();
    const l = new Lockout({ max: 2, windowMs: 100, lockMs: 50, now: c.now });
    l.fail();
    c.tick(101);
    expect(l.fail()).toBe(false);
    l.succeed();
    expect(l.fail()).toBe(false);
    expect(l.fail()).toBe(true);
  });
});
