---
title: VIP-44 durable values, Smithers side
status: in-progress
area: SDK values
owner: Claude vip44-smithers
updated: 2026-11-09
links:
  - https://github.com/smithersai/vibelang/blob/vibe/docs/design/vips/0044-durable-values.md
---

Build every row of VIP-44's "Changes to Smithers" table, one commit per row.
Library catalog entries: `@smthrs/canonical`, `@smthrs/keys`, `@smthrs/flow`
and Effect's `RpcSerialization`. Supersedes the unpushed Codex canonical-sort
attempt (392b6cd8262d), which was never landed.

| Row | Change | Commit |
| --- | --- | --- |
| 1 | `@smthrs/canonical` `sortCollections` | f4b973ab2789 |
| 2 | `ExecutionIds` sorts before encoding | pending |
| 3 | One shared payload identity for every hashing site | pending |
| 4 | Action results through `RpcSerialization.codecFor` | pending |
| 5 | `layerMemory` snapshot sorts | pending |
| 6 | `smithers-build` payloads have a JSON codec | pending |

Open question 1 (walk the Schema or the value): the value. A value walk that
visits every own data property, enumerable or not, and keeps prototypes gives
a declared class with a hidden field one identity
(`canonical/test/sortCollections.test.ts`). A private `#field` is unreachable
from both a value walk and a Schema walk, which sees only the codec's output,
so such a class orders its collection in its own encoder.
