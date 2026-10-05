---
name: OpenAPI inline request body collisions
description: Inline request-body objects can collide across Orval Zod and generated type barrel exports.
---

Prefer named component-schema references for object request bodies rather than
inline object schemas.

**Why:** this workspace exports both Orval's Zod output and generated model types.
Inline bodies can generate the same exported `OperationBody` name twice, producing
TS2308 even though schema generation itself succeeds.

**How to apply:** when codegen succeeds but library typechecking reports duplicate
body exports, move the inline body into a uniquely named component schema and
reference it. Do not hand-edit generated barrels.
