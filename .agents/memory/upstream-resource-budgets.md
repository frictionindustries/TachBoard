---
name: Upstream resource budgets
description: Scope download limits to widget consumers rather than all homelab HTTP traffic.
---

Keep RSS response-size limits local to the news consumer, not global on the shared homelab HTTP client.

**Why:** Feed parsing requires a bounded in-memory document, but the same client serves legitimate large media and file transfers. A global RSS-sized limit would break unrelated integrations.

**How to apply:** Choose byte budgets for each buffering/parsing consumer and enforce them during download, including after decompression. Do not treat an output item limit as a memory limit.