---
title: "Store control state in a database"
description: "Compose SqlControlRuntime over a SQL database and the fenced run store: the layer stack, the migration order, the owner identity every claim is stamped with, and what sharing a database with the engine buys."
sidebar:
  order: 7
---

`ControlRuntime.layerMemory` models the production seams in a `Map`, and
nothing it decides survives the process. `SqlControlRuntime` is the durable
adapter: the same contract, over a SQL database and the fenced run store from
[`@smthrs/run-store`](/api/run-store).

## Compose the layer

```ts
import * as ControlLive from "@smthrs/control/ControlLive"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store"
import * as Layer from "effect/Layer"

const storage = RunStore.layer.pipe(
  Layer.provideMerge(RunStoreMigrations.layer),
  Layer.provideMerge(DurableWriter.layer()),
  Layer.provideMerge(NodeDatabase.layer({ filename: "control.sqlite" }))
)

const controlPlane = ControlLive.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SqlControlRuntime.layer({ owner: { hostId: "gateway", pid: process.pid, nonce: "boot" } })
        .pipe(Layer.orDie),
      NotificationQueue.layer,
      Registry.layerNoop()
    )
  )
)
```

`SqlControlRuntime.layer` requires `Crypto`, `DurableWriter`, `SqlClient`, and
`RunStore`, and fails with `PersistenceError` if its migration cannot run.
`layerWithStore` is the same layer with `RunStore.layer` already provided, for
a composition that has no other use for the store.

Build the storage once. `Layer.provideMerge` builds what it provides privately,
so composing it twice hands the control plane its own empty copy of the rows it
is supposed to be reading.

`SqlControlRuntime` stores the decoded plan input and the plan card summary as
raw plaintext JSON. The durable adapter does not redact or encrypt those
columns because the input must be replayed exactly. Never put a credential in
plan input: store it through `Credential`, pass only a `CredentialRef`, and
resolve that reference at the adapter boundary that needs the secret.

The Node CLI creates its `.flows/` directory with mode `0700` and, on POSIX,
repairs existing directory permissions to `0700` and SQLite database, WAL,
and shared-memory file permissions to `0600` when opening the control store.
Windows does not use this POSIX chmod policy. If you embed the durable adapter
with your own database layer, configure equivalent storage access controls.

### Options

| Option      | Meaning                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flows`     | The catalog this plane may plan, as `DurableFlow` entries. Defaults to the plannable reserved system flows.                                                                             |
| `owner`     | The process identity every claim is stamped with. Omitted, one synthetic identity is minted for this runtime only, so separately constructed runtimes cannot cross each other's fences. |
| `principal` | The fallback identity stamped on a mutation whose caller named none.                                                                                                                    |

Supply a real `owner` whenever the host can report its process identity, so
liveness probes can reason about the operating-system process.

## Run the migrations

The package reserves a namespaced migration block, and a host composes it
beside the journal and run-store sets before opening a shared control database:

```ts
import * as ControlMigrations from "@smthrs/control/Migrations"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as RunStoreMigrations from "@smthrs/run-store/Migrations"

const migrations = DatabaseMigrations.run([
  JournalMigrations.set,
  RunStoreMigrations.set,
  ControlMigrations.set
])
```

`ControlMigrations.layer` runs the control set alone before exposing the
database to control services, and `ControlMigrations.run` is the effect behind
it.

Each adapter also bootstraps its own tables idempotently, through
`SqlControlRuntime.migrate` and `SqlCredentialStore.migrate`, so standalone
construction works. Prefer the composed set: a standalone runtime that recorded
control's high-offset migration first would make the later journal and
run-store sets look skipped.

The tables the set creates are `control_plans`, `control_plan_keys`,
`control_tokens`, `control_mutations`, `control_runs`, `control_run_resumes`,
`control_run_messages`, `control_signal_commands`, `control_sequences`, and
`control_credentials`. `control_run_messages` holds signal history from before
the signal inbox; it is read, never written.

## What the durable runtime adds

Several `RunSummary` fields exist only here, because they are read from the
engine's own columns and journal entries:

| Field                                                | Read from                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `waitingReason`                                      | `flows_runs.waiting_reason`                                                                   |
| `parentRunId`, `lineageId`, `roundOrdinal`, `origin` | the run row's columns and the `flows_run_parents` spawn edges                                 |
| `cancellation`                                       | `cancel_requested_at_ms`, `flows.engine.interrupted`, and the plane's own attributed requests |

They are read through the `SqlClient` the runtime was built over. A composition
that wants them must give the control runtime and the engine **one** database.
The [`smthrs` CLI](/api/cli) does not: it keeps `.flows/control.db` and
`.flows/engine.db` as two files, so one run has two rows and these projections
are empty there. Cancellation still converges, because the request travels
through the [executor port](./implement-an-executor.md) and the owning driver
settles from it.

The listing covers every row in `flows_runs`, not only the runs this plane
launched. A run whose `state_json` is not a control summary, an engine-created
run, is projected from the row's own columns with the engine's `flowName` as
its `flowId`.

## Reading one run stays cheap

A listing folds the whole database, because every row is going to be answered
for anyway. Reading one run, which is what every mutation does before it
writes, reads that run and its ancestor chain and nothing else. The cost of
steering or cancelling a run therefore does not grow with the size of the
database.

## Where to go next

- [Ownership, fences, and claims](../concepts/ownership.md): what a fence is
  and what the status mapping means.
- [Connect an execution engine](./implement-an-executor.md): the other half of
  a real deployment.
- [Store and resolve a credential](./store-credentials.md): the durable
  credential table lives in this same set.
