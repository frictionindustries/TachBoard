---
name: Desktop launcher safety semantics
description: Why desktop control sacrifices delivery certainty rather than risk duplicate or delayed launches.
---

Desktop launch delivery must remain at-most-once and fail closed. An ambiguous
acceptance response is not permission to launch again; accepted is not proof
that an application opened. Never replace this with a durable retrying job queue.

**Why:** replaying a desktop action after a network outage can surprise the user
or repeat a side effect. The task explicitly prioritizes no unexpected offline
replay and no duplicate launches over eventual delivery.

**How to apply:** retain the expiry, reconnect cancellation, server-instance
binding and deduplication invariants when changing transports or history storage.
Future USB support should reuse the action-allowlist semantics, not introduce a
remote shell. Both Pi-hosted and TrueNAS-hosted installations share the feature.
