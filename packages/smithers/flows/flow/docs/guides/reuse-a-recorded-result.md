---
title: "Reuse a recorded result"
description: "Declare a cache policy on a sealed action, supply the composition's complete cache environment, and declare the file boundary that makes a result shareable across runs."
sidebar:
  order: 12
---

Every sealed action's result is recorded and replayed inside its own execution.
Reusing one across executions is a stronger claim, and it takes three
declarations. Missing any one of them scopes the key to the run that produced it,
which is safe and does nothing.

1. **An identity a second run can derive.** The action's `idempotencyKey`.
2. **A hermetic boundary.** The action's declared `FileBoundary`, with
   `boundaryMode: "hard"`.
3. **A complete environment.** The composition's `Action.CacheEnvironment`.

## Declare how long the result stays good

`Action.withCache` returns a copy of the action annotated with a `CachePolicy`.
The action is not mutated: `annotate` returns a separate declaration, and that
copy is what a plan captures.

```ts
import { Action } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const compile = Action.withCache(
  Action.make({
    name: "build/Compile",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "build/compile/v1",
    fileBoundary: { readSet: [], writeSet: [], boundaryMode: "hard" },
    execute: Effect.sync(() => "dist/server.js")
  }),
  { ttlMs: 15 * 60_000, scope: "shared" }
)
```

Both policy fields are optional and both defaults are the behavior you get
without a policy: no age bound, and the reach the composition's environment
already granted.

| Field   | Meaning                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ttlMs` | A positive whole number of milliseconds bounding the age of a row the engine may serve. Past it the dispatch executes again.                                                                                                               |
| `scope` | `shared` names the inputs and the environment, so any run on any host that would have produced the same bytes may reuse the row. `flow` and `run` narrow that, folding the flow or the execution into the key so a sibling never reads it. |

The engine journals its age judgement as a `flows.engine.cache-provenance`
record before acting on it, so a reader can tell an expiry from a plain miss, and
a resumed run reads the verdict it already took instead of re-judging it against
a fresh clock.

`Action.cachePolicyOf(annotations)` reads a policy back off an annotation bag,
and `Action.CachePolicyAnnotation` is the key it is carried under.

## Declare the file boundary

An action's typed `fileBoundary` declares its `Action.FileBoundary`, and the engine folds
that boundary into the key rather than trusting a caller-supplied field:

| Field          | Meaning                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `readSet`      | Exact files already measured (`Action.FileInput`, a workspace-relative path plus its content digest), or globs to expand while preparing. |
| `writeSet`     | The files or patterns the action may write.                                                                                               |
| `removes`      | The paths the action may delete. Optional, empty by default, and disjoint from `writeSet`: a path cannot be both promised and disclaimed. |
| `boundaryMode` | `hard` rejects undeclared access immediately. `expected` validates it later.                                                              |

`removes` exists because a declared write that is absent when the action
finishes is a defect: recording the absence as valid evidence would cache the
claim that the file should not exist, and a later replay would act on it by
deleting the path. A declared removal is what makes an absent path legitimate.

`Action.Filegroup`, `Action.Glob`, and `Action.TreeArtifact` are the reusable
vocabulary those sets are written in: named groups of declarations,
Bazel-style include and exclude patterns, and a directory output captured and
replayed as one tree artifact.

Both inline and declared actions accept `fileBoundary`. Declared actions may
compute it from decoded payload fields, and can derive `idempotencyKey` from
the same payload. They also accept `retryPolicy` and `interruptRetryPolicy`;
see the [`Action.make` reference](../reference/flow.md#actionmake) for every
option. A new typed boundary is validated before dispatch. Historical
inline `metadata` boundary declarations remain readable for existing callers.

## Declare the composition's environment

```ts
const environment = Action.layerCacheEnvironment({
  layers: ["node@22.19.0", "toolchain@3.1.0"],
  capabilities: { filesystem: ["read", "write"] }
})
```

`Action.CacheEnvironment` is `{ layers, capabilities }`: the ordered semantic
runtime layers, including versions and configuration, and the complete effective
capability groups. A composition either provides a **complete** value or leaves
it absent. When it is absent, the engine scopes action keys to the current
execution rather than presenting incomplete environment data as reusable
identity, and `Action.CurrentCacheEnvironment` reads `undefined`.

That is the safe default and it is doing real work: a half-declared environment
would let a result computed under one toolchain be served to a run under
another.

## What cannot enter a key

An object-form `idempotencyKey` is caller-owned canonical JSON. Material that
canonical serialization rejects, such as a `Date`, an `undefined`, a class
instance, or a `Redacted`, is refused with `Action.UncanonicalIdempotencyKey`
naming the offending path. The refusal is a typed, non-retryable recorded
completion rather than an untyped defect, because the same declaration derives
the same rejection on every attempt and the body never runs.

## Related pages

- [Execution identity](../concepts/execution-identity.md): the full account of
  what enters a key, and the one limit of schema-shaped key material.
- [Attach an implementation to an action](./implement-an-action.md): tiers, and
  when an inline action is the right form.
