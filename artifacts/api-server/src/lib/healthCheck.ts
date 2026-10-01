import { db, connectionStmts, healthStmts } from "./db.js";
import { runPing, connectionToValues, isConfigured } from "./ping.js";
import { logger } from "./logger.js";
import { runAsOutboundUser } from "./outboundPolicy.js";

const DEFAULT_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 5_000;

function resolveInterval(): number {
  const raw = process.env["HEALTH_CHECK_INTERVAL_MS"];
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed < 5_000) return DEFAULT_INTERVAL_MS;
  return parsed;
}

const listUserIds = db.prepare("SELECT id FROM users").pluck();

// Ping every configured connection once (per user) and persist the outcome.
// Connections are scoped per-user, so health is checked and stored per-user
// too — one user's service reachability/status is never visible to another.
// Unconfigured services (no base URL) are skipped and any stale health row is
// cleared so the dashboard never reports a service the user has removed.
export async function runHealthChecks(): Promise<void> {
  const userIds = listUserIds.all() as number[];

  await Promise.all(
    userIds.map(async (userId) => {
      const connections = connectionStmts.findAllByUser.all(userId);
      await Promise.all(
        connections.map(async (conn) => {
          const values = connectionToValues(conn);

          if (!isConfigured(values)) {
            healthStmts.delete.run(userId, conn.service);
            return;
          }

          const result = await runAsOutboundUser(userId, () => runPing(conn.service, values));
          healthStmts.upsert.run(userId, conn.service, result.ok ? 1 : 0, result.message);
        }),
      );
    }),
  );
}

let timer: ReturnType<typeof setInterval> | null = null;

// Start the recurring background health check. Runs an initial pass shortly
// after boot, then repeats on the configured interval.
export function startHealthChecks(): void {
  if (timer) return;

  const intervalMs = resolveInterval();

  const tick = () => {
    runHealthChecks().catch((err) => {
      logger.error({ err }, "Health check pass failed");
    });
  };

  setTimeout(tick, STARTUP_DELAY_MS);
  timer = setInterval(tick, intervalMs);

  logger.info({ intervalMs }, "Connection health checks scheduled");
}
