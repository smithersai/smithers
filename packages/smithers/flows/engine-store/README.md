# @smthrs/engine-store

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.1.1` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/engine-store/docs

The durable half of the Smithers flow engine. It persists every step a flow
takes to a SQLite database, so a flow that crashes, is killed, or waits for a
week resumes where it stopped instead of starting over.

It is an [Effect](https://effect.website) library: every surface it exports is
a `Layer` you compose or an `Effect` you run.

## Install

```bash
npm install @smthrs/engine-store@next effect
```

Node.js 22.19.0 or later. The package ships as both ESM and CommonJS with
TypeScript declarations.

## Testing

`smthrs test '//packages/smithers/flows/engine-store:test'` runs the existing
suite on SQLite and real PostgreSQL. By default the matrix starts and cleans
up its own disposable PostgreSQL server. To use an existing server, supply
`SMITHERS_TEST_PG_URL` before invoking the command; the target declares that
connection in its environment and execution key.

The canonical override accepts a credential-free `postgres:` or `postgresql:`
URL with optional `sslmode` and positive, at most two-digit `connect_timeout`.
Declared configuration is visible in plans, so passwords, credential files,
service configuration and other query options are refused without echoing the
URL. An unavailable configured server fails the PostgreSQL leg. The direct
matrix script retains its existing password support and disposable-server path.

## The shortest real use

Declaration paths use `Options.declarationRoot`, or the injected `Workspace` root from `@smthrs/kernel`. Without either, journal records omit declaration paths; the store never reads a process working directory.

`EngineStore.layer` is the composition. It provides `FlowRuntime`, the service
that executes a flow durably, and the snapshot boundary the engine measures
each step against:

```ts
import { EngineStore } from "@smthrs/engine-store"
import { FlowRuntime } from "@smthrs/flow"
import { Effect } from "effect"

const engineLayer = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "engine-store"
})

const program = Effect.gen(function*() {
  return yield* FlowRuntime.FlowRuntime
}).pipe(Effect.provide(engineLayer))
```

`engineLayer` still needs the storage it composes: `DurableWriter`, `Journal`, `RunStore`,
`AttemptStore`, `CacheStore`, `DurableEngineState`, `StepBoundary`, `Jj`,
`OwnerIdentity`, Effect's `Crypto`, and a `Scope`. Supply the same `DurableWriter`
used by the journal and run store. A missing service is an unmet
requirement in the layer's type, so a bad composition fails to compile rather
than at run time. Run the schema migrations before any SQL-backed service reads
the database, and provide `OwnerIdentity.layer` unless the host mints its own
owner tokens.

[The quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/docs/quickstart.md) wires all of it
over one SQLite file and watches a sealed step replay after a restart.

If you want the wiring rather than control over it, reach for
[`@smthrs/flows`](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/docs) instead. It ships `NodeRuntime`,
which composes this package with the flow language, the journal, the run and
cache stores, and the artifact tier over one file.

## What it gives you

- **Durable attempts.** A step opens a row before its body runs and settles it
  afterwards, so a restart replays the recorded result instead of executing the
  body a second time.
- **One owner per run.** Every durable write is fenced against the owner that
  claimed the run, so two processes over one database cannot both drive it. A
  dead owner's runs are reclaimed under a liveness check you choose.
- **Waits that outlive the process.** A parked run holds a durable deferred or
  clock row, so a timer set by a process that has since died still fires.
  A timer computes its remaining wait when its fiber starts, against that
  persisted deadline; time spent queued never restarts its duration.
- **Declared file boundaries.** The engine measures the tree a step actually
  touched against what it declared, refuses a step that wrote outside it, and
  admits only whole-tree evidence into the cache other runs read.
- **Explicit deletion.** Old run history and unreferenced artifacts go away
  when you run a retention or garbage-collection pass, never on a schedule you
  did not set.

Lifecycle reads use the run store's metadata-only lineage projection, so
historical executable states and journal payloads are not loaded to enumerate
rounds or decide cancellation. The creating child's exit policy is read from
that child's state when needed. Membership and ownership rules are unchanged.

`DurableEngineState.runChildrenOf?(parentIds)` lists child edges for a set of
parents, ordered by parent ID and sequence within each parent. SQL and memory
implement it; adapters may retain per-parent `runChildren` reads.

Every durable write is one transaction. During ordinary engine execution, a
lifecycle event is written inside the same transaction that carries the state
transition it describes: the attempt
row with its start and finish records, the run-row compare-and-set with its
decision, the deferred or clock row with its record, the cache entry with its
provenance. Either both halves are durable or neither is, so audit, sync, and
time travel never read a hole. No local transaction makes a remote effect
atomic, so external effects still need idempotency keys, fencing, or
compensation.

Restore fencing is an exception to lifecycle journaling.
`DisasterRecovery.fence` clears claims and consensus leases, suspends running
rows with `waiting_reason = 'released'`, and rotates the change-feed source in
one transaction. It does not append a run decision, ownership event, or
execution fact, so the restored journal has no release cause and may still show
the pre-backup owner running. A mismatching lifecycle view remains an
`unverified-observation` until a later native fact matches the row. Read the
restored rows and rebuild change-feed projections against the new source; see
[Back up and restore the store](docs/guides/back-up-and-restore.md).

Closing an engine's Effect scope releases its run ownership across the full
claim, execution, and settlement lifetime. An interrupted partial claim is
abandoned; an activated run returns to `suspended`, preserving any declared
approval, timer, or event wait. This lets a replacement engine in the same
process resume with a new owner nonce without weakening the PID liveness
check. Only a persisted operator cancellation closes the run as `cancelled`.

A scoped flow registration owns every drive that selected its handler, including
work still waiting to claim a run. Closing that registration first removes it
from dispatch, interrupts those drives, and waits for their ownership and scope
cleanup before releasing the implementation. Other live registrations and their
runs keep running. A drive closing its own registration is interrupted without
waiting on itself. The debug event `flow.registration.released` records the flow
name and the number of drives stopped, without payloads.

## Browser imports and native durable execution

The entry point bundles for a browser. The two host reads it once made
directly, `process.pid` and `randomUUID` from `node:crypto`, enter through the
injectable `OwnerIdentity` service, and the SQL contracts it imports are
driver-neutral.

Bundling is not running. The durable backing is SQLite or PostgreSQL, composed by the
aggregate [`@smthrs/flows` runtime](../README.md) over these driver-neutral
stores by a host package:

- Node.js or Bun: `@smthrs/platform-node` or `@smthrs/platform-bun`.
- A browser: `@smthrs/platform-browser`'s `BrowserRuntime`, in a dedicated
  worker over wa-sqlite in OPFS.
- A Cloudflare Durable Object: `@smthrs/platform-cloudflare`'s
  `CloudflareRuntime`, over PostgreSQL.

Any other SQL client is not a supported runtime.

## Documentation

The full documentation is at <https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/engine-store/docs>:

- [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/docs/installation.md): runtime
  requirements, import forms, and the storage packages a runnable composition
  adds.
- [Quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/docs/quickstart.md): compose a durable
  engine over SQLite and watch a step replay after a restart.
- [Compose a durable engine](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/docs/guides/compose-a-durable-engine.md):
  the required and optional services, and what each one changes.
- [API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/docs/api.md): every public
  export, with signatures and error codes.
- [Observe executions and page runs](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/docs/guides/observe-executions.md):
  coherent snapshots, filtered keyset pages, durable children and revisioned catch-up.
- [Troubleshooting](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/docs/troubleshooting.md): each
  typed failure, its cause, and its fix.

See also [durable execution](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine/docs/README.md)
and [content addressing](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/docs/concepts/step-keys.md)
on smithers.sh.

List reads of durable wait state skip corrupt rows and log storage-integrity warnings; point reads still fail for an invalid row.

Clock completions wake an execution once on activation, even when its action waits on a separate external event. Their persisted results remain readable by later durable awaits. This supports an engine-owned fallback deadline beside a webhook wait without repeated immediate drives.

Hosted deferred and clock wakes coalesce only an active, non-stopping drive.
An idle host must call `EngineStore.drive` after applying its admission and
cancellation policy; registration recovery and signal delivery never start
unbudgeted work. A replacement drive waits for a stopping owner's cleanup
without inheriting its interruption.
