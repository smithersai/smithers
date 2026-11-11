---
title: "Quickstart"
description: "Follow a run end to end: write two entries, open one subscription over a real server and client, and watch a third entry arrive live."
sidebar:
  order: 2
---

This quickstart runs a real `SyncServer` over a real journal, connected to a
real `SyncClient`, and needs no database of your own and no network. The only
piece that is not production is the transport: an in-memory socket pair stands
in for a WebSocket. By the end you will have one subscription that delivers two
entries of history and then a third entry that commits while you are watching.
Each step below is TypeScript; the
[VibeLang tab](#the-same-walkthrough-in-vibelang) runs the same follower as
`effect` functions.

A runnable copy lives in the Smithers repository, as
[`packages/smithers/flows/sync/examples/07-sync-follower.ts`](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/examples/07-sync-follower.ts).

## Prerequisites

- Node.js 22.19.0 or later.
- A project with the packages installed: `npm install @smthrs/sync@next @smthrs/journal@next effect`.

## Name the run

Create `quickstart.ts`. `RunId`, `SourceId`, and `SourceSeq` are branded, so a
plain string needs a cast at the boundary where you introduce it:

```ts
import { JournalEvent } from "@smthrs/journal"

const runId = "sync-demo-1" as JournalEvent.RunId
const sourceId = "quickstart" as JournalEvent.SourceId

const entry = (sourceSeq: number, eventType: string) =>
  new JournalEvent.Input({
    runId,
    sourceId,
    sourceSeq: sourceSeq as JournalEvent.SourceSeq,
    eventType,
    payload: { sourceSeq },
    meta: null
  })
```

`sourceId` and `sourceSeq` are the journal's producer identity. They are what
makes a re-emitted entry a duplicate rather than a second row, and the sync
read path never sees them as anything but fields on the entry it replicates.

## Write history the follower has never seen

`emitDurableUnfenced` commits before it returns, so these two entries are on
disk before anything subscribes:

```ts
import { Journal } from "@smthrs/journal"
import * as Effect from "effect/Effect"

const writeHistory = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  yield* journal.emitDurableUnfenced(entry(0, "run.started"))
  yield* journal.emitDurableUnfenced(entry(1, "step.recorded"))
})
```

## Connect a follower

`TestSocket.makePair` is a scoped, bidirectional in-memory socket.
`TestSync.connect` starts an RPC server over its server end and returns a
`SyncClient.Service` over its client end:

```ts
import * as TestSocket from "@smthrs/sync/test/TestSocket"
import * as TestSync from "@smthrs/sync/test/TestSync"

const connect = Effect.gen(function*() {
  const pair = yield* TestSocket.makePair()
  return yield* TestSync.connect(pair)
})
```

Swap the socket pair for a network transport and the follower code below does
not change. That is the point of the seam: the client talks to an RPC protocol,
not to a socket.

## Subscribe, then commit one more entry

The subscription replays the durable history first and then stays open for live
entries, so a `take(3)` collects both halves through one stream:

```ts
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"

export interface Summary {
  readonly caughtUp: ReadonlyArray<string>
  readonly followed: ReadonlyArray<string>
}

export const main: Effect.Effect<Summary> = Effect.gen(function*() {
  yield* writeHistory
  const follower = yield* connect

  const collected = yield* Stream.runCollect(
    follower.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(Stream.take(3))
  ).pipe(Effect.forkChild({ startImmediately: true }))

  const journal = yield* Journal.Journal
  yield* journal.emitDurableUnfenced(entry(2, "run.completed"))

  const entries = Array.from(yield* Fiber.join(collected))
  return {
    caughtUp: entries.slice(0, 2).map((committed) => committed.eventType),
    followed: entries.slice(2).map((committed) => committed.eventType)
  }
}).pipe(Effect.provide(TestSync.layerTest), Effect.scoped, Effect.orDie)
```

The subscription is forked with `startImmediately: true` so it is really
attached before the third entry commits. Without that the third entry could
land while nothing was listening, and the follower would read it out of the
durable history instead of following it, which proves less than the test
intends.

## Run it

```ts
console.log(await Effect.runPromise(main))
```

The output separates what was replayed from what was followed:

```text
{
  caughtUp: [ 'run.started', 'step.recorded' ],
  followed: [ 'run.completed' ]
}
```

## What just happened

`TestSync.layerTest` provided three things: the in-memory SQLite journal, an
empty mutable run catalog, and an authentication middleware that trusts the
connection as the workspace owner. The server and the client are the production
ones.

One `subscribe` call ran both phases of the protocol. The client issued
`Sync.Read` pages until the server reported it had reached the durable tail,
then opened `Sync.Subscribe` from its delivered bookmarks. The third
entry arrived on the second phase. Nothing was delivered twice, because the
cursor the follow resumed from was exactly the last sequence the replay handed
over.

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) each stage is an `effect`
function and `try` runs each journal and client call. `join` waits for the
forked subscription, and one `provide` block supplies `TestSync.layerTest` to
the follower, with `scoped` closing the socket pair when it returns.

This is `examples/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

```vibe
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestSocket from "@smthrs/sync/test/TestSocket"
import * as TestSync from "@smthrs/sync/test/TestSync"

const runId = "sync-demo-1" as JournalEvent.RunId
const sourceId = "quickstart" as JournalEvent.SourceId

/** One journal entry from this producer, identified by its source sequence. */
const entry = (sourceSeq: number, eventType: string) =>
  new JournalEvent.Input({
    runId,
    sourceId,
    sourceSeq: sourceSeq as JournalEvent.SourceSeq,
    eventType,
    payload: { sourceSeq },
    meta: null
  })

/** Commits two entries before anything subscribes. */
export effect function writeHistory() {
  const journal = try Journal.Journal
  try journal.emitDurableUnfenced(entry(0, "run.started"))
  try journal.emitDurableUnfenced(entry(1, "step.recorded"))
}

/** A production client over an in-memory socket pair served by a production server. */
export effect function connect() {
  const pair = try TestSocket.makePair()
  return try TestSync.connect(pair)
}

/** Replays the history, then follows one entry that commits while the subscription is open. */
export effect function follow() {
  try writeHistory()
  const follower = try connect()
  const subscription = follower.subscribe({ scope: { _tag: "Run", runId }, cursors: [] })
  // Attached before the third entry commits, so that entry is followed, not replayed.
  const collected = try Effect.forkChild(Stream.runCollect(Stream.take(subscription, 3)), { startImmediately: true })

  try (try Journal.Journal).emitDurableUnfenced(entry(2, "run.completed"))

  const entries = Array.from(join collected)
  return {
    caughtUp: entries.slice(0, 2).map((committed) => committed.eventType),
    followed: entries.slice(2).map((committed) => committed.eventType)
  }
}

/** The follower against the in-memory journal, catalog, and owner authentication. */
export effect function quickstart() {
  provide TestSync.layerTest {
    return try scoped(follow())
  }
}
```

## Next steps

- [Follow a run](./guides/follow-a-run.md): cursors you persist, applying an
  entry before its cursor moves, and the failures a follower must handle.
- [Serve the read path](./guides/serve-the-read-path.md): the same server over
  a real journal and a real transport.
- [Test a follower](./guides/test-a-follower.md): the fault injection this
  socket pair adds, for reconnects, stalls, and dropped frames.
