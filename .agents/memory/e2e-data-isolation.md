---
name: E2E account isolation
description: Why registration regression tests must not use existing app servers
---

Browser regression tests must own disposable data, never clean up shared accounts
by name or inferred test prefixes. Do not restore the old E2E_BASE_URL workflow.

**Why:** Repeated registration tests exhausted the development 32-account cap.
Per-test isolation was chosen over shared-database deletion to protect real users
and reset in-memory rate limits as well as database state on retries.

**How to apply:** Use the shared isolated fixture for new specs. Keep production
account limits unchanged. Hard-killed runs may leave temporary data, but it must
never be reused by later runs.