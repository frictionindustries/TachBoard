---
name: Homelab outbound authorization
description: Why private-network HTTP access is limited to the earliest account and must follow background/request identity.
---

Reserve the intentional homelab HTTP private-network allowance for the earliest
existing account, following the legacy global-connection ownership convention.
Do not treat self-registration, possession of upstream credentials, or a saved
connection as authorization to use the instance's private network.

**Why:** Open registration otherwise makes the dashboard a private-network
reader for any registrant. The remediation must preserve owner LAN integrations
without introducing invitations, approval flows, or a new role-management UI.

**How to apply:** Keep authorization at the actual outbound transport boundary,
including authenticated streaming and per-user scheduled work. Missing identity
must fail closed; explicit public-only restrictions must stay strict for owners.
Save/import validation alone cannot cover old settings or DNS rebinding.
Service URL validation must preserve legitimate reverse-proxy prefixes while
rejecting query/fragment suffix swallowing, including bare delimiters.

Do not apply base-URL restrictions to full resource URLs such as RSS feeds.

**Why:** Legitimate feeds frequently use query parameters (Google News searches,
PHP feeds). They do not receive fixed API suffixes, so blocking their queries is
a compatibility regression rather than a security safeguard.

**How to apply:** Keep full-resource normalization separate and preserve query
strings, while retaining public-only transport checks for news. Test with the
real normalizer so stale helper mocks cannot hide this distinction.