---
title: "Compose a durable engine"
description: "Wire EngineStore.layer: the services it requires, the ones it resolves optionally, what each option changes, and how to give engine bookkeeping its own repository."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/guides/compose-a-durable-engine.md"
---

`EngineStore.layer(options)` provides `FlowRuntime` and
`FlowEngine.SnapshotBoundary`. This guide covers what you have to provide
underneath it, what you may provide, and what each choice changes.

## Provide the required services

A composition failure is an unmet requirement in the layer's type, so a
composition that forgets one of these fails to compile. There is no run-time
composition error to handle.

| Service              | From                                    | Why                                                |
| -------------------- | --------------------------------------- | -------------------------------------------------- |
| `Journal`            | [`@smthrs/journal`](https://journal.smithers.sh/reference/api/)       | Every engine decision is written here.             |
| `RunStore`           | [`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/)   | Run rows, claims, leases, cancellation.            |
| `AttemptStore`       | [`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/)   | Attempt rows.                                      |
| `CacheStore`         | [`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/) | Recorded step results.                             |
| `DurableEngineState` | this package                            | Deferreds, clocks, waiting rows, the run DAG.      |
| `OwnerIdentity`      | this package                            | Mints the `OwnerId` this incarnation fences with.  |
| `StepBoundary`       | this package                            | Measures each step's declared read and write sets. |
| `Jj`                 | [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)         | Compensable snapshots for the snapshot boundary.   |
| `Crypto`             | `effect/Crypto`                         | Digests the step keys and mints the owner nonce.   |
| `Scope`              | `effect`                                | Registrations and active fibers are scoped.        |

The [Quickstart](/quickstart/) builds all of them over one SQLite file.

## Provide the optional services deliberately

Both halves of the isolated-execution lane are optional and are resolved at
composition time, because `actionExecute` runs on the engine's own fiber, which
does not carry the store's layer context. Anything a dispatch needs has to be
captured when the store is built and re-provided onto that fiber.

| Optional service   | Absent                                                                                                                    | Present                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `WorkspaceSandbox` | The body runs against the host directly; results stay run-local.                                                          | The body runs isolated, so evidence can claim the whole tree and results become shareable.                        |
| `EffectDispatcher` | The engine journals what a transaction queued and sends nothing.                                                          | Queued effects are dispatched after copy-back, deduplicated by idempotency key.                                   |
| `StepSandbox`      | No per-step isolated workspace is acquired.                                                                               | Each step opens its own scoped workspace.                                                                         |
| `WakeBus`          | The composition builds a private bus.                                                                                     | Your own wake sources share one bus with the engine.                                                              |
| `ArtifactSync`     | `makeLocal()`: publish is a no-op, hydrate reports nothing arrived.                                                       | Referenced blobs reach a shared tier before their cache entry does.                                               |
| `CacheSync`        | `makeLocal()`: a recorded entry is already everywhere it will be.                                                         | Durable local entries are published to a shared step-result tier.                                                 |
| `Inconsistency`    | Conflicts are journaled and fail the dispatch (the strict default); provide `layerTolerant(owner)` to continue past them. | Cache conflicts and corrupt evidence are journaled. `layerStrict(owner)` fails; `layerTolerant(owner)` continues. |
| `Reconciliation`   | Deviations and conflicts have no reader.                                                                                  | `layerDefault` answers them deterministically.                                                                    |
| `Selection`        | Everything is admitted.                                                                                                   | Sinks may be deferred to a guess-free pass.                                                                       |

## Set the options

```ts
import { EngineStore } from "@smthrs/engine-store"
import { Ownership } from "@smthrs/run-store"

const engine = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "worker-a-engine",
  isAlive: Ownership.sameHostPidProbe
})
```

`owner.hostId` is this engine's stable identity. Which host a store speaks for
is a composition decision, not a host fact, so the store asks you rather than
guessing.

`journalSource` is the source id every record this engine writes carries. Give
two engines over one database two different source ids so their records are
distinguishable.

`isAlive` decides whether a run whose lease expired may be stolen. Omit it and
the lease alone decides, which is enough to reclaim from a SIGKILL. Supply one
to refuse a takeover for longer. See
[Reclaim runs from a dead host](/guides/reclaim-runs-from-a-dead-host/).

`clockFireRetryPolicy` is the redispatch `Schedule` for a durable clock whose
fire failed. It defaults to exponential from 100ms capped at 30s, forever.

## Build the service instead of the layer

`EngineStore.make(options)` returns the `FlowRuntime` service itself, for a host
that composes it by hand rather than through a layer:

```ts
import * as Effect from "effect/Effect"

const runtime = Effect.gen(function*() {
  const flowRuntime = yield* EngineStore.make({
    owner: { hostId: "worker-a" },
    journalSource: "worker-a-engine"
  })
  return flowRuntime
})
```

`make` does not provide `FlowEngine.SnapshotBoundary`; `layer` does.

## Give engine bookkeeping a private repository

The engine uses `Jj` for two different purposes: the repository an action body
may reach, and the bookkeeping the snapshot boundary performs. A host that
guards action access wants those to be different services.

`EngineStore.layerWithPrivilegedJj(options, privilegedJj)` takes a second `Jj`
layer for engine bookkeeping and leaves the ambient `Jj` for action bodies:

```ts
const engine = EngineStore.layerWithPrivilegedJj(
  { owner: { hostId: "worker-a" }, journalSource: "worker-a-engine" },
  privilegedJjLayer
)
```

Use `layer` when both roles may use the same repository access.

## Install the schema underneath

`Migrations.layer` runs journal, run store, step cache, this package's own
tables, and the plan store, in that order. It must complete before any durable
service is exposed, so provide it under the stores rather than beside them:

```ts
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Migrations } from "@smthrs/engine-store"
import * as Layer from "effect/Layer"

const database = (filename: string) =>
  Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  )
```

The plan store's set comes last because its id block is the highest, and the
migrator decides what to run from a single high-water mark. See
[`@smthrs/database`](https://database.smithers.sh/reference/api/) for how namespaced sets compose without
colliding.

## Related

- [Quickstart](/quickstart/): the whole composition, runnable.
- [Test against a durable store](/guides/testing/): the same composition with
  `test/TestStores` doing the wiring.
