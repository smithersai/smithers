---
title: "Scopes and cursors"
description: "What a sync request covers, what a cursor means, why journal sequences have holes, and the difference between an entry that was delivered and one that was applied."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sync/docs/concepts/scopes-and-cursors.md"
---

Every sync request answers two questions: which runs does it cover, and where
in each of them does it start. The first is a scope. The second is a cursor
set.

## A scope is one run or the whole workspace

```ts
import type { JournalEvent } from "@smthrs/journal"
import type * as SyncProtocol from "@smthrs/sync/SyncProtocol"

const workspace: SyncProtocol.Scope = { _tag: "Workspace" }
const oneRun: SyncProtocol.Scope = { _tag: "Run", runId: "build-42" as JournalEvent.RunId }
```

A run scope names exactly one run. A workspace scope covers every run the
`RunCatalog` lists and the caller is authorized to read, and it reconciles that
set on every round, so a run created after the subscription opened joins it.

`SyncProtocol.covers(scope, runId)` is the predicate both ends use, so a client
validating a server's page asks the same question the server asked when it
built it.

## A cursor is per run, and exclusive

`RunCursor` is `{ runId, afterSeq, generation }`. A `WorkspaceCursor` is an
array of them. `generation` names the run's current history: a rewind
increments it, and sequence order is meaningful only within one generation.
Server cursors always carry it; a persisted request cursor may omit it for
generation zero. Persist it with `afterSeq`, because a cursor whose generation
differs from the run's fails with `lineage_changed`. See
[Rewind generations](/reference/api/#rewind-generations).

`afterSeq` means "entries after this number". It never means "expect the next
number to be exactly one greater".

That distinction is not a detail. Journal sequences legitimately have holes: an
admission the journal dropped leaves a number nothing was ever written at. A
follower that treats a missing number as corruption stalls on ordinary traffic.
Gap detection therefore compares the server's declared covered interval against
the cursor, not the entry sequences against each other. See
[Replay then follow](/concepts/replay-then-follow/) for where that comparison lives.

## One cursor per run, or the request is refused

A cursor set that names one run twice is ambiguous about where the read starts,
so both `Sync.Read` and `Sync.Subscribe` refuse it with `invalid_request`
rather than picking one. `SyncProtocol.duplicateCursorRunId` is the check, and
the client applies it to the server's echoed cursors as well: a response that
names a run twice is a `protocol_violation`.

The schema cannot express uniqueness, so the rule is stated once and enforced
at every boundary that could break it.

## Delivered and applied are different claims

`RunCursor` is an exclusive transport bookmark. The server's response cursors
and `progress.delivered` describe delivery, and never acknowledge application.
`client.progress` reports `SyncProtocol.Progress`, two cursor sets:

- `delivered` records transport delivery.
- `applied` records successful `apply` or `onResync` callbacks.

Both are `WorkspaceCursor` values; the field name carries the distinction.
Delivery-only subscriptions leave applied progress empty. Use
`SubscribeOptions.apply` to acknowledge materialization:

```ts
import type { JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"

const apply = (entry: JournalEvent.Entry): Effect.Effect<void> =>
  Effect.logInfo(`applied ${entry.eventType} at ${entry.seq}`)
```

The callback runs to success before the cursor moves. It fails with the
consumer's own error type, which the subscription's error channel carries
unchanged. A failure fails the subscription with that entry unacknowledged, so
the next subscription from `client.progress`'s applied cursors delivers it
again. Redelivery is what a retry is here, so the callback must be idempotent.

Use it whenever the consumer writes somewhere durable. Leave it off when the
consumer is a view that is rebuilt on reconnect anyway.

## The client's effective cursor is the later of two

A `SyncClient` keeps separate delivered and applied maps. An applying
subscription uses the later of the caller's cursor and the shared applied
cursor. A delivery-only subscription uses shared delivered progress. Earlier
delivery cannot fast-forward an applying consumer past unapplied entries.
One client instance belongs to one materialization; independent projections
must use independent clients even when they read the same run.

Both halves matter. A caller that restored its own progress from durable
storage is never regressed and never re-receives entries it has already
materialized. A caller behind its matching shared progress map is fast-forwarded.
Failed application can redeliver the unapplied entry; consumers must be idempotent.

To rebuild a projection from an earlier position, construct a fresh client. Its
progress maps are empty, so the caller's cursor is the only one there is.

## Persisting a cursor

`client.progress` returns canonical sets with one entry per run, sorted by run
id. Its applied positions advance only after application succeeds. Fetching a
snapshot does not move either set:

```ts
import * as SyncClient from "@smthrs/sync/SyncClient"
import * as Effect from "effect/Effect"

const checkpoint = Effect.flatMap(
  SyncClient.SyncClient,
  (sync) => Effect.map(sync.progress, (progress) => progress.applied)
)
```

For durable recovery, the callback must commit state and its cursor in the
same application transaction. Reading progress later and writing a separate
cursor file is not that transaction. Seed a fresh client from the durable
transaction's cursor after restart. Supply cursors only for state already
restored; an input bookmark is the caller's assertion, not proof of application.

## Related pages

- [Replay then follow](/concepts/replay-then-follow/): how the two phases use these
  cursors, and what bounds a page.
- [Compaction and resync](/concepts/compaction/): what happens when a cursor names
  history the journal has deleted.
- [Follow a run](/guides/follow-a-run/): the task-shaped version of this
  page.
