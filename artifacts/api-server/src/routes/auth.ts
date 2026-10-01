import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, userStmts, createDefaultPage, createDefaultDeviceMode, createDefaultServiceConnections, type DbUser } from "../lib/db.js";
import { signToken, requireAuth, type AuthRequest } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { AUTH_LIMITS, authResourceLimiter, authSource, validateCredentials, type AuthResourceLimiter } from "../lib/authResources.js";

const countUsers = db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM users");

// Hashing is asynchronous; the quota and username must be rechecked afterwards.
// BEGIN IMMEDIATE serializes this check with inserts even across SQLite
// connections. Defaults and the account are committed/rolled back together.
const createAccount = db.transaction((username: string, hashed: string) => {
  if (countUsers.get()!.count >= AUTH_LIMITS.accounts) return { error: "quota" } as const;
  if (userStmts.findByUsername.get(username)) return { error: "duplicate" } as const;
  const row = userStmts.create.get(username, hashed)!;
  const user = userStmts.findById.get(row.id)!;
  createDefaultPage(user.id);
  createDefaultDeviceMode(user.id);
  createDefaultServiceConnections(user.id);
  return { user } as const;
});

function formatUser(user: DbUser) {
  return { id: user.id, username: user.username };
}

export function createAuthRouter(limiter: AuthResourceLimiter = authResourceLimiter): Router {
  const router = Router();

  // POST /api/auth/register
  router.post("/register", async (req, res) => {
    try {
      const input = validateCredentials(req.body, "register");
      if (!input.ok) {
        res.status(400).json({ error: input.error });
        return;
      }
      const { username, password } = input.credentials;

      if (countUsers.get()!.count >= AUTH_LIMITS.accounts) {
        res.status(403).json({ error: `Account limit reached (${AUTH_LIMITS.accounts} users)` });
        return;
      }
      const existing = userStmts.findByUsername.get(username);
      if (existing) {
        res.status(400).json({ error: "Username already taken" });
        return;
      }

      const admission = limiter.acquireBcrypt(authSource(req));
      if (!admission.ok) {
        res.setHeader("Retry-After", admission.retryAfter);
        res.status(429).json({ error: admission.error });
        return;
      }
      let hashed: string;
      try {
        hashed = await bcrypt.hash(password, 12);
      } finally {
        admission.release();
      }
      const created = createAccount.immediate(username, hashed);
      if ("error" in created) {
        if (created.error === "quota") {
          res.status(403).json({ error: `Account limit reached (${AUTH_LIMITS.accounts} users)` });
        } else {
          res.status(400).json({ error: "Username already taken" });
        }
        return;
      }
      const { user } = created;
      const token = signToken({ userId: user.id, username: user.username });
      res.status(201).json({ token, user: formatUser(user) });
    } catch (err) {
      logger.error({ err }, "Registration failed");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/auth/login
  router.post("/login", async (req, res) => {
    try {
      const input = validateCredentials(req.body, "login");
      if (!input.ok) {
        res.status(400).json({ error: input.error });
        return;
      }
      const { username, password } = input.credentials;

      const user = userStmts.findByUsername.get(username);
      if (!user) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      const admission = limiter.acquireBcrypt(authSource(req));
      if (!admission.ok) {
        res.setHeader("Retry-After", admission.retryAfter);
        res.status(429).json({ error: admission.error });
        return;
      }
      let valid: boolean;
      try {
        valid = await bcrypt.compare(password, user.password);
      } finally {
        admission.release();
      }
      if (!valid) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      const token = signToken({ userId: user.id, username: user.username });
      res.json({ token, user: formatUser(user) });
    } catch (err) {
      logger.error({ err }, "Login failed");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/auth/me
  router.get("/me", requireAuth, (req: AuthRequest, res) => {
    res.json({ id: req.user!.userId, username: req.user!.username });
  });

  return router;
}

export default createAuthRouter();
