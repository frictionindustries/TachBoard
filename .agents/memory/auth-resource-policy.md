---
name: Authentication resource policy
description: Security scope and proxy-identity tradeoffs for homelab auth hardening.
---

Keep resource-abuse hardening within the existing signup/login flows; do not substitute invitation, approval, or account-management features for bounded work and storage.

**Why:** The requested remediation explicitly prioritized security safeguards over new product flows. The application is a small homelab service, not a public multi-tenant account platform.

**How to apply:** Preserve normal self-registration within documented limits. Changing the proxy-aware client identity requires a verified deployment trust boundary first; forwarded headers supplied by arbitrary clients must not create fresh rate-limit allowances.