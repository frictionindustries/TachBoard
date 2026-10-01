import express, { Router, type Request, type ErrorRequestHandler } from "express";

// Fixed, single-process homelab limits. Request/CPU windows are one minute,
// shared by login and registration, and include successful attempts. Behind a
// reverse proxy all clients intentionally share its socket-source allowance:
// forwarded headers (even when Express trusts a proxy) cannot create buckets.
// The global budget also protects against rotating IPs. No queued bcrypt work,
// no success-based reset, and no eviction of live source buckets.
export const AUTH_LIMITS = Object.freeze({
  bodyBytes: 4 * 1024,
  registerUsernameMin: 3,
  registerUsernameMax: 64, // UTF-16 code units, matching the existing minimum.
  registerPasswordMin: 6,
  registerPasswordBytes: 72, // bcrypt's effective UTF-8 input limit.
  loginUsernameMax: 256,
  loginPasswordBytes: 1024, // Bounded allowance for legacy, truncated passwords.
  accounts: 32, // Persistent users-table count; existing users are never removed.
  windowMs: 60_000,
  requestsPerSource: 30,
  requestsGlobal: 120,
  bcryptPerSource: 10,
  bcryptGlobal: 20,
  bcryptConcurrent: 2,
  sourceBuckets: 1024,
});

export type Credentials = { username: string; password: string };
export type CredentialValidation =
  | { ok: true; credentials: Credentials }
  | { ok: false; error: string };

export function validateCredentials(body: unknown, mode: "register" | "login"): CredentialValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Username and password must be strings" };
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "username" && key !== "password")) {
    return { ok: false, error: "Only username and password are allowed" };
  }
  const { username, password } = input;
  if (typeof username !== "string" || typeof password !== "string") {
    return { ok: false, error: "Username and password must be strings" };
  }
  if (!username || !password) {
    return { ok: false, error: "Username and password required" };
  }
  if (mode === "register") {
    if (username.length < AUTH_LIMITS.registerUsernameMin) {
      return { ok: false, error: "Username must be at least 3 characters" };
    }
    if (username.length > AUTH_LIMITS.registerUsernameMax) {
      return { ok: false, error: "Username must be at most 64 characters" };
    }
    if (password.length < AUTH_LIMITS.registerPasswordMin) {
      return { ok: false, error: "Password must be at least 6 characters" };
    }
    if (Buffer.byteLength(password, "utf8") > AUTH_LIMITS.registerPasswordBytes) {
      return { ok: false, error: "Password must be at most 72 UTF-8 bytes" };
    }
  } else {
    // Do not apply new signup minima to old users, trim/case-fold usernames,
    // or reject legacy passwords merely for exceeding bcrypt's 72-byte limit.
    if (username.length > AUTH_LIMITS.loginUsernameMax) {
      return { ok: false, error: "Username must be at most 256 characters" };
    }
    if (Buffer.byteLength(password, "utf8") > AUTH_LIMITS.loginPasswordBytes) {
      return { ok: false, error: "Password must be at most 1024 UTF-8 bytes" };
    }
  }
  return { ok: true, credentials: { username, password } };
}

type Window = { expires: number; requests: number; bcrypt: number };
type Rejection = { ok: false; error: string; retryAfter: number };
type Admission = { ok: true } | Rejection;
type BcryptAdmission = { ok: true; release: () => void } | Rejection;

export function authSource(req: Request): string {
  return req.socket.remoteAddress || "unknown";
}

export class AuthResourceLimiter {
  private readonly sources = new Map<string, Window>();
  private global: Window = { expires: 0, requests: 0, bcrypt: 0 };
  private activeBcrypt = 0;

  // Injectable monotonic clock for deterministic tests; no timers to leak.
  constructor(private readonly now: () => number = () => performance.now()) {}

  private window(now: number): Window {
    return { expires: now + AUTH_LIMITS.windowMs, requests: 0, bcrypt: 0 };
  }

  private reject(expires: number, now: number, error = "Too many authentication attempts"): Rejection {
    return { ok: false, error, retryAfter: Math.max(1, Math.ceil((expires - now) / 1000)) };
  }

  private refresh(now: number): void {
    if (this.global.expires <= now) this.global = this.window(now);
    for (const [source, window] of this.sources) {
      if (window.expires <= now) this.sources.delete(source);
    }
  }

  private sourceWindow(source: string, now: number): Window | Rejection {
    const existing = this.sources.get(source);
    if (existing) return existing;
    if (this.sources.size >= AUTH_LIMITS.sourceBuckets) {
      const expires = Math.min(...Array.from(this.sources.values(), (entry) => entry.expires));
      return this.reject(expires, now);
    }
    const window = this.window(now);
    this.sources.set(source, window);
    return window;
  }

  admitRequest(source: string): Admission {
    const now = this.now();
    this.refresh(now);
    if (this.global.requests >= AUTH_LIMITS.requestsGlobal) {
      return this.reject(this.global.expires, now);
    }
    const window = this.sourceWindow(source, now);
    if ("ok" in window) return window;
    if (window.requests >= AUTH_LIMITS.requestsPerSource) {
      return this.reject(window.expires, now);
    }
    window.requests++;
    this.global.requests++;
    return { ok: true };
  }

  acquireBcrypt(source: string): BcryptAdmission {
    const now = this.now();
    this.refresh(now);
    if (this.activeBcrypt >= AUTH_LIMITS.bcryptConcurrent) {
      return this.reject(now + 1000, now, "Authentication busy; try again later");
    }
    if (this.global.bcrypt >= AUTH_LIMITS.bcryptGlobal) {
      return this.reject(this.global.expires, now);
    }
    const window = this.sourceWindow(source, now);
    if ("ok" in window) return window;
    if (window.bcrypt >= AUTH_LIMITS.bcryptPerSource) {
      return this.reject(window.expires, now);
    }
    window.bcrypt++;
    this.global.bcrypt++;
    this.activeBcrypt++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.activeBcrypt--;
      },
    };
  }
}

export const authResourceLimiter = new AuthResourceLimiter();

// Mount BEFORE the general 5mb parser. Match routes using Express's own path
// rules (including case and trailing slash), just like the auth router does.
// Unknown content types cannot fall through to a more generous body parser.
export function createAuthIngress(limiter = authResourceLimiter): Router {
  const ingress = Router();
  ingress.post(
    ["/register", "/login"],
    (req, res, next) => {
      const admission = limiter.admitRequest(authSource(req));
      if (!admission.ok) {
        res.setHeader("Retry-After", admission.retryAfter);
        res.status(429).json({ error: admission.error });
        return;
      }
      if (!req.is("application/json") && !req.is("application/x-www-form-urlencoded")) {
        res.status(415).json({ error: "Use JSON or URL-encoded authentication credentials" });
        return;
      }
      next();
    },
    express.json({ limit: AUTH_LIMITS.bodyBytes, inflate: false }),
    express.urlencoded({ limit: AUTH_LIMITS.bodyBytes, extended: false, parameterLimit: 2, inflate: false }),
  );
  const parserErrors: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    const error = err as { type?: string; status?: number };
    if (error.type === "parameters.too.many") {
      res.status(413).json({ error: "Authentication body allows at most 2 form parameters" });
    } else if (error.status === 413) {
      res.status(413).json({ error: "Authentication body must be at most 4096 bytes" });
    } else if (error.status === 415) {
      res.status(415).json({ error: "Unsupported authentication encoding; send uncompressed UTF-8" });
    } else if (error.status === 400) {
      res.status(400).json({ error: "Invalid authentication body" });
    } else {
      next(err);
    }
  };
  ingress.use(parserErrors);
  return ingress;
}