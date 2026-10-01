---
name: service_connections is per-user (migrated from global)
description: The service_connections and service_health tables were migrated from a single global row per service to per-user rows keyed by (user_id, service).
---

`service_connections` and `service_health` used to be keyed by `service` alone (no `userId`), meaning every authenticated user shared — and could read/tamper with — the same Google, IMAP, CalDAV, Spotify, and generic service (TrueNAS/Plex/Sonarr/etc.) credentials. This was a security hardening fix (2026-07-06): both tables now have a `user_id` column, `UNIQUE(user_id, service)`, and every read/write path (`connectionStmts`, `healthStmts`, `lib/google.ts`, `lib/spotify.ts`, `lib/mailAccounts.ts`, `lib/email.ts`, `lib/calendar.ts`, `lib/healthCheck.ts`, and every route in `routes/widgets.ts`/`routes/connections.ts`/`routes/google.ts`/`routes/spotify.ts`) takes an explicit `userId` and scopes queries to it.

**Why:** Any authenticated user could previously read/write another user's saved integration credentials and OAuth tokens because the schema had no per-user isolation.

**How to apply:** Any new saved-connection lookup or write MUST take `userId` as an explicit parameter (never read from a module-level `req` closure — that was a bug caught mid-migration where a helper function referenced `req.user` outside any request handler). `healthCheck.ts` now loops over all users (`SELECT id FROM users`) and checks connections per user, since health checks can no longer be done once globally. New users get seeded empty connection rows via `createDefaultServiceConnections(userId)` on signup. Existing test mocks for `connectionStmts.findByService`/`upsert` must accept `(userId, service, ...)` in that order, not `(service, ...)`.

## Legacy environment configuration compatibility

Treat user-saved service settings as one credential bundle, never as field-by-field overrides of deployment settings. Preserve legacy environment configuration only when the saved connection is genuinely empty; partially saved settings must not borrow deployment credentials.

**Why:** Legacy environment-only installations must continue working with automatically seeded empty connection rows. Mixing a user's chosen endpoint with deployment credentials discloses shared secrets, while falling back wholesale on incomplete saved media settings can expose deployment service data unexpectedly.

**How to apply:** Preserve the distinction between empty seeded rows and meaningful partial user configuration when adding service resolvers. Scope upstream login reuse to the Tachboard account and current credential bundle, not just upstream identity, so password changes cannot keep using old sessions.
