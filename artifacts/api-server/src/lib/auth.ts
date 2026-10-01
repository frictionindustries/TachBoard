import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Request, Response, NextFunction } from "express";
import { runAsOutboundUser } from "./outboundPolicy.js";

// Known weak defaults shipped in compose files or docs — never use these as-is
const KNOWN_WEAK_SECRETS = new Set([
  "homelab-dashboard-secret-change-in-prod",
  "change-this-secret-in-production",
  "secret",
  "changeme",
]);

const dataDir = process.env["DATA_DIR"] || "./data";
const isProduction = process.env["NODE_ENV"] === "production";

// Resolve the JWT signing secret:
//  1. Use an explicitly-provided strong JWT_SECRET if present.
//  2. In dev, fall back to a stable dev-only secret.
//  3. In production with no (or a weak) secret, auto-generate a strong random
//     secret and persist it in the data volume so it survives restarts.
//     This keeps self-hosting "just works" while avoiding predictable secrets.
function resolveJwtSecret(): string {
  const provided = process.env["JWT_SECRET"];

  if (provided && provided.trim() !== "" && !KNOWN_WEAK_SECRETS.has(provided)) {
    return provided;
  }

  if (!isProduction) {
    return "homelab-dashboard-dev-only";
  }

  // Production: read or generate a persistent secret in the data volume
  const secretFile = path.join(dataDir, "jwt-secret");
  try {
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, "utf8").trim();
      if (existing) return existing;
    }
    const generated = crypto.randomBytes(48).toString("hex");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    console.warn(
      `[auth] No strong JWT_SECRET provided. Generated a persistent random secret at ${secretFile}. ` +
      "Set the JWT_SECRET environment variable to override it.",
    );
    return generated;
  } catch (err) {
    console.error(
      "[FATAL] Could not read or create a JWT secret in the data directory. " +
      "Provide a strong JWT_SECRET environment variable instead.",
      err,
    );
    process.exit(1);
  }
}

const JWT_SECRET = resolveJwtSecret();

export interface JwtPayload {
  userId: number;
  username: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    req.user = verifyToken(token);
    runAsOutboundUser(req.user.userId, next);
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
