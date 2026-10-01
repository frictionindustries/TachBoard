// ── Short-lived upstream fetch cache ──────────────────────────────────────────
// Email/Calendar tiles poll their widgets endpoints on short intervals, and
// each refresh used to open a fresh IMAP connection (login + mailbox open) or
// re-hit the Google/CalDAV APIs per account. With several tiles that is slow
// and can trip provider connection caps (Gmail IMAP allows ~15 concurrent
// connections). This module caches the *promise* of each per-account fetch for
// a short TTL, which also dedupes concurrent requests: everyone who asks for
// the same key while a fetch is in flight shares that single upstream call.
//
// Failures are never cached — a rejected promise is evicted immediately so the
// next tile refresh retries the upstream instead of replaying the error.

const DEFAULT_TTL_MS = 90_000;
export const FETCH_CACHE_MAX_ENTRIES = 512;

interface CacheEntry {
  expiresAt: number;
  promise: Promise<unknown>;
}

const cache = new Map<string, CacheEntry>();

function pruneExpired(now = Date.now()): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

// Also release expired results when the instance is idle. Do not keep Node
// alive just for cache maintenance.
setInterval(pruneExpired, 60_000).unref();

export function cachedFetch<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
  opts?: { fresh?: boolean },
): Promise<T> {
  const now = Date.now();
  pruneExpired(now);
  const hit = cache.get(key);
  // `fresh` skips any cached entry and forces a new upstream fetch. The new
  // promise is still stored under the key, so concurrent callers arriving
  // right after the fresh request dedupe onto it as usual.
  if (hit && !opts?.fresh) {
    // Map insertion order tracks least-recently-used entries.
    cache.delete(key);
    cache.set(key, hit);
    return hit.promise as Promise<T>;
  }

  const promise = fn();
  cache.delete(key);
  while (cache.size >= FETCH_CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }
  cache.set(key, { expiresAt: now + ttlMs, promise });
  promise.catch(() => {
    // Only evict if this exact promise is still the cached one (a newer
    // fetch may have replaced it already).
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

// Drop every entry whose key starts with `prefix` (or everything when the
// prefix is omitted). Called when accounts are added/removed so stale data
// for a reconfigured provider never survives the change.
export function invalidateFetchCache(prefix?: string): void {
  if (prefix === undefined) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// Test helper — actual retained entry count, including entries awaiting pruning.
export function fetchCacheSize(): number {
  return cache.size;
}
