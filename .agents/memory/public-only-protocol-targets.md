---
name: Public-only protocol targets
description: Security policy for mail/calendar targets and panel-derived game probes, distinct from intentional LAN integrations.
---

Keep IMAP, CalDAV, and metadata-derived game-player probes public-only, including destinations loaded from saved/imported accounts.

**Why:** Open registration means an ordinary account is not authorization to reach the API server's private network. The generic homelab HTTP client's deliberate LAN allowance must not be treated as the security policy for these protocol-specific paths. Blocking private mail/calendar servers and private game-player queries is an intentional compatibility tradeoff, not a reason to add an automatic fallback.

**How to apply:** Preserve the public-only policy at the actual transport boundary. Save-time checks alone cannot prevent rebinding or old/imported configuration bypasses. Treat library DNS discovery, redirects, and returned service URLs as additional untrusted destinations. In particular, passing a checked host to a third-party protocol library is insufficient if that library resolves it again or performs its own HTTP requests.

Do not infer transport safety for every game protocol from GameDig's base socket implementation.

**Why:** Individual protocols can ignore the pinned address and construct HTTP URLs from the original hostname. Tests mocking the GameDig entry point cannot detect those protocol-specific DNS/redirect bypasses.

**How to apply:** When enabling a game type or upgrading GameDig, verify that protocol's actual network boundary, including secondary HTTP requests, with the installed library left real.

Preserve game-specific query-port selection on the validated public address.

**Why:** A panel allocation usually identifies the game port, not its query port. Suppressing same-address offsets/fallbacks breaks player counts without improving private-network isolation.

**How to apply:** Test representative offset and separate-query-port games against the installed library's attempt selection. HTTP protocol replacements must preserve the relevant port behavior too.