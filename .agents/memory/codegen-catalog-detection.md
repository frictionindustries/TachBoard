---
name: API generator catalog detection
description: Why generated clients need explicit library compatibility targets with pnpm catalogs
---
Pin the intended Zod and React Query major versions in generator options rather than relying on package auto-detection.

**Why:** Orval cannot infer majors from pnpm `catalog:` references reliably. After a generator update it fell back to Zod 4 syntax while this workspace still used Zod 3.

**How to apply:** when upgrading Orval, regenerate both clients and validate their library compatibility using the full type check. Do not migrate the application's validation library just to accommodate the generator's fallback.