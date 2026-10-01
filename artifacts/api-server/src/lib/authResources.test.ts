import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { AUTH_LIMITS, AuthResourceLimiter, authSource, validateCredentials } from "./authResources.js";

describe("authentication resource limiter", () => {
  it("resets source throttles after the fixed window, not after a rejection", () => {
    let now = 0;
    const limiter = new AuthResourceLimiter(() => now);
    for (let i = 0; i < AUTH_LIMITS.requestsPerSource; i++) {
      expect(limiter.admitRequest("source").ok).toBe(true);
    }
    now = 59_000;
    expect(limiter.admitRequest("source")).toMatchObject({ ok: false, retryAfter: 1 });
    now = 60_000;
    expect(limiter.admitRequest("source").ok).toBe(true);
  });

  it("enforces the global request allowance across rotating sources", () => {
    const limiter = new AuthResourceLimiter(() => 0);
    for (let i = 0; i < AUTH_LIMITS.requestsGlobal; i++) {
      expect(limiter.admitRequest(`source-${i}`).ok).toBe(true);
    }
    expect(limiter.admitRequest("new-source")).toMatchObject({ ok: false, retryAfter: 60 });
  });

  it("bounds state, prunes expired entries, and does not evict live buckets", () => {
    let now = 0;
    const limiter = new AuthResourceLimiter(() => now);
    // Inspect saturation directly: the global budget normally keeps the table
    // far below its hard ceiling, even with an entirely new IP per request.
    const sources = (limiter as unknown as {
      sources: Map<string, { expires: number; requests: number; bcrypt: number }>;
    }).sources;
    for (let i = 0; i < AUTH_LIMITS.sourceBuckets; i++) {
      sources.set(`source-${i}`, { expires: 60_000, requests: 0, bcrypt: 0 });
    }
    expect(limiter.admitRequest("new-source").ok).toBe(false);
    expect(sources.size).toBe(AUTH_LIMITS.sourceBuckets);
    expect(limiter.admitRequest("source-0").ok).toBe(true);
    now = 60_000;
    expect(limiter.admitRequest("new-source").ok).toBe(true);
    expect(sources.size).toBe(1);
  });

  it("bounds concurrent bcrypt without a queue, including across window resets", () => {
    let now = 0;
    const limiter = new AuthResourceLimiter(() => now);
    const first = limiter.acquireBcrypt("source");
    const second = limiter.acquireBcrypt("source");
    expect(first.ok && second.ok).toBe(true);
    expect(limiter.acquireBcrypt("other")).toMatchObject({ ok: false, retryAfter: 1 });
    now = AUTH_LIMITS.windowMs;
    expect(limiter.acquireBcrypt("other").ok).toBe(false);
    if (!first.ok || !second.ok) throw new Error("Expected bcrypt permits");
    first.release();
    first.release(); // Must not free a second worker.
    const third = limiter.acquireBcrypt("other");
    expect(third.ok).toBe(true);
    expect(limiter.acquireBcrypt("other").ok).toBe(false);
    second.release();
    if (third.ok) third.release();
  });

  it("charges completed work to source/global CPU budgets and resets at expiry", () => {
    let now = 0;
    const limiter = new AuthResourceLimiter(() => now);
    for (const source of ["one", "two"]) {
      for (let i = 0; i < AUTH_LIMITS.bcryptPerSource; i++) {
        const permit = limiter.acquireBcrypt(source);
        expect(permit.ok).toBe(true);
        if (permit.ok) permit.release();
      }
      expect(limiter.acquireBcrypt(source).ok).toBe(false);
    }
    expect(limiter.acquireBcrypt("three")).toMatchObject({ ok: false, retryAfter: 60 });
    now = AUTH_LIMITS.windowMs;
    const permit = limiter.acquireBcrypt("one");
    expect(permit.ok).toBe(true);
    if (permit.ok) permit.release();
  });

  it("never uses spoofable forwarding headers or Express's trusted-proxy IP", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      ip: "attacker-chosen",
      headers: { "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" },
    } as unknown as Request;
    expect(authSource(req)).toBe("127.0.0.1");
  });
});

describe("credential limits", () => {
  it("counts password UTF-8 bytes rather than characters", () => {
    expect(validateCredentials({ username: "user", password: "é".repeat(36) }, "register").ok).toBe(true);
    expect(validateCredentials({ username: "user", password: "é".repeat(37) }, "register").ok).toBe(false);
    expect(validateCredentials({ username: "user", password: "é".repeat(512) }, "login").ok).toBe(true);
    expect(validateCredentials({ username: "user", password: "é".repeat(513) }, "login").ok).toBe(false);
  });

  it("preserves username spelling and permits bounded legacy credentials", () => {
    const input = { username: " Mixed Case ", password: "123456" };
    expect(validateCredentials(input, "register")).toEqual({ ok: true, credentials: input });
    expect(validateCredentials({ username: "a", password: "a" }, "login").ok).toBe(true);
    expect(validateCredentials({ username: "u".repeat(256), password: "p".repeat(1024) }, "login").ok).toBe(true);
    expect(validateCredentials({ username: "u".repeat(257), password: "p" }, "login").ok).toBe(false);
  });
});