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
| 2 | `ExecutionIds` sorts before encoding | e119afb8dd32 |
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

## Row 3: payload hashing sites

One module, `flow/src/Flow/PayloadIdentity.ts`: `Flow.payloadSnapshot`
(sort, then the JSON codec) and `Flow.payloadPreimage` (the payload as written
when it holds no set or map, else its snapshot, so released ids keep their
bytes).

| Site | What it hashes or compares | Now |
| --- | --- | --- |
| `flow` `Flow/ExecutionIds.ts` `canonicalKey` | derived execution id | `payloadSnapshot` |
| `flow` `Interpreter.ts` `runChild` -> `childExecutionId` | child execution id | `payloadPreimage` |
| `flow` `Interpreter.ts` `planIdentity` | recorded plan's root input | `payloadPreimage`; a set payload used to refuse (`canonical_unsupported_value` at `$.material.inputs[0].value`) |
| `flow` `Interpreter.ts` `handOff` | next round's payload, compared at admission | `payloadSnapshot` |
| `engine-store` `RunDriver.ts` `ensureRun` | stored payload compared with an existing row | `payloadSnapshot` |
| `engine-store` `RunDriver.ts` `normalizePayload` | handoff payload stored for the next round | `payloadSnapshot` |
| `platform-cloudflare` `ExecutionObject.ts` `intent` | persisted intent compared on restart | `payloadSnapshot` |
| `engine` `FlowEngine/layerMemory.ts` `snapshot`, `samePayload` | memory admission | row 5 |

Audited and left alone: `StepIdentity.allocationScope` and `ActionKey`
idempotency objects (caller-owned, schema-less; RFC 8785 refuses a set with a
typed error), `CallFacts` truncation digest and `StepBoundary`/`WorkspaceSandbox`
digests (already JSON, not payloads), `platform-browser` `BrowserEngine.start`
and `platform-node` `SandboxedFlow` (wire encodings: VIP-44 does not sort Rpc
messages; the receiving engine admits through `ensureRun`).

Gap found: `@smthrs/plan` JSON-mirrors every authored node payload
(`.call`, `.child`, `.to`, action calls) and refuses a `Set`/`Map`
(`internal/JsonMirror.ts`) before any hash. A set reaches a flow only through
its own payload. Two tests are committed as expected failures (TEST-5) in
`flow/test/FlowChild.test.ts` and `flow/test/Trampoline.test.ts`. Plan ASTs that
carry collections need the callee schema; that belongs with the task and
workflow VIPs.
