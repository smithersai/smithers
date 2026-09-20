---
title: "Test against a durable store"
description: "Build every durable engine service over one migrated database, choose between the in-memory and file-backed bundles, and use the deterministic layers each seam ships."
sidebar:
  order: 11
---

Everything nondeterministic in this package is a service, so a test swaps the
service rather than the code. This guide is the checklist.

## Start from TestStores

`@smthrs/engine-store/test/TestStores` builds every durable engine service over
one database, with this package's composed migration set already installed:

```ts
import * as TestStores from "@smthrs/engine-store/test/TestStores"

const stores = TestStores.layer()
```

`layer(options?)` uses a private in-memory database and keeps `SqlClient` to
itself, which is what a case that only needs an engine wants. It provides the
SQL journal, the run store, the attempt store, the cache store, the plan store,
and `OwnerIdentity.layer`.

`OwnerIdentity.layer` rides along rather than a pinned identity, so a test
observes the same fresh-per-incarnation owner the production composition mints.
Pin it with `OwnerIdentity.layerConstant(owner)` when a test needs to assert on
the token itself.

`TestStoresOptions` forwards `capacity`, `overflow`, and `batchSize` to the
journal, for a test that wants to observe a saturated queue.

## Take the connection when you need it

`TestStores.databaseAt(filename)` is the migrated database alone, and
`TestStores.layerAt(filename, options?)` is the full bundle with the `SqlClient`
connection and `DurableEngineState` re-exported. Two shapes need it:

- Adding another SQL-backed service, a control runtime for instance, over the
  same database as the engine.
- Pointing two independently constructed bundles at one file, which gives two
  connections, two engines, and no shared object graph. That is what a second
  process actually has.

Use a real file for the second case. `:memory:` gives each connection its own
private database, so it cannot prove anything durable across compositions. Pass
`:memory:` to `layerAt` only when you want the cheap variant and still need the
connection.

`TestStores.database` is the in-memory migrated database exposed as `SqlClient`
and `DurableWriter`.

## The deterministic layer for each seam

| Seam                 | Deterministic layer        | What it does                                                                                                                        |
| -------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DurableEngineState` | `layerMemory`              | An in-memory implementation that, given a `runs` lookup, enforces the same park, wake, and clock ownership fences as the SQL layer. |
| `StepBoundary`       | `layerTest(options)`       | Supports explicit `failure` or `deviation` fixtures, replay, and `readSnapshot` assertions.                                         |
| `WorkspaceSandbox`   | `makeMemory(initialFiles)` | Deterministic and browser-safe, and the conformance implementation.                                                                 |
| `StepSandbox`        | `layerTest(initialFiles)`  | The same transaction behind the scope-safe front door.                                                                              |
| `StepSandbox`        | `layerNoop`                | Fails closed with `UnsupportedBoundary`, which models a host that cannot sandbox.                                                   |
| `WakeBus`            | `layerNoop(overrides?)`    | Drops every wake, so every resume travels the polling fallback.                                                                     |
| `Inconsistency`      | `layerNoop(overrides?)`    | Journals nothing and tolerates everything.                                                                                          |
| `Selection`          | `layerNoop`                | Admits every candidate.                                                                                                             |
| `Reconciliation`     | `layerDefault`             | The deterministic verdict function.                                                                                                 |
| `ArtifactSync`       | `layerLocal`               | Publish is a no-op; hydrate reports nothing arrived.                                                                                |
| `CacheSync`          | `layerLocal`               | A recorded entry is already everywhere it will be.                                                                                  |
| `OwnerIdentity`      | `layerConstant(owner)`     | Pins the whole owner token.                                                                                                         |

Both `DurableEngineState` implementations answer one behavior contract, so the
memory twin cannot drift from the SQL one and a test written against the twin
holds for the SQL store. The suite that pins them,
[`DurableEngineStateContract.ts`](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/test/contract/DurableEngineStateContract.ts),
is not part of the published package. Copy it into your own project to run it
against a third implementation you write.

## What not to stub

Do not replace `StepBoundary.layer` with `layerTest` and then assert on cache
sharing. `layerTest` defaults `wholeTreeWriteDetection` to `true`, which is a
fixture claim rather than a proof, and nothing composed that way ever proves the
cross-run admission path. Use `StepBoundary.layer` with
`WorkspaceSandbox.layerFileSystem()` when the cache behavior is what you are
testing.

Do not stub the liveness check with a function that returns `false` without
asking. That is not a test double, it is a different, wrong policy: it says the
owner is gone about an owner it never looked at.

## Assert on the durable evidence

The journal is the record, so most assertions read it back:

- Claim arbitration writes `steal-refused-owner-alive` or
  `stolen-and-activated`, each with its `evidence` kind.
- A refused cache hit writes `cache-provenance` with
  `action: "stale_read_set"`; a withheld shared entry writes the same record
  with `action: "unpublished"` and the stage that refused.
- The scheduler writes `plan-recorded`, `subgraph-appended`, `node-scheduled`,
  `node-settled`, `node-invalidated`, and `selection-deferred`. A node record
  names the tag its node dispatches under `action`, and a plan record carries
  the graph under `graph.nodes`.
- An interpreted flow writes the same records through `FlowRuntime.recordNode`,
  addressed by a replay-stable `sourceId`, so a resumed walk holds one row per
  node instead of one per observation. `@smthrs/journal`'s `EngineEvent` module
  publishes the payload schema for every one of them.
- A workspace transaction writes `diff-bundle-captured` and
  `copy-back-settled`.

`EngineStoreMetrics` is the other observable surface, and its counters are
attributed by outcome, so a test can assert that a dispatch settled as a
`VerifiedHit` rather than inferring it from timing.

## Related

- [Coordinate two processes](./coordinate-two-processes.md): the two-connection
  pattern in full.
- [Compose a durable engine](./compose-a-durable-engine.md): the production
  composition these layers substitute into.

Test filesystem classification with `StepBoundary.layer` over an in-memory `FileSystem` and `ArtifactStore`. `layerTest` returns supplied settlement evidence or failure verbatim; it does not classify changed paths, missing outputs, or surviving removals.
