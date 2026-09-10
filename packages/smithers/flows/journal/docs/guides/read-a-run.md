---
title: "Read and follow a run"
description: "Choose between entries, stream, and changes; page a long history; and know which reader reports a loss and which one drops entries silently."
sidebar:
  order: 3
---

The journal has three reads, and they differ in exactly one dimension: what
happens when the reader cannot keep up. Pick by that.

| Read      | Shape                                     | Behind a fast writer          |
| --------- | ----------------------------------------- | ----------------------------- |
| `entries` | one page, in sequence order               | nothing is lost; you page     |
| `stream`  | replay then follow, per run               | lossless; reports a sink loss |
| `changes` | live tail, every run this process commits | silently drops entries        |

## Page a history with entries

`entries` reads one page in sequence order and reports whether another follows.
Use it for a poller, an export, or any bounded read:

```ts
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"

const readAll = (runId: JournalEvent.RunId) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    let after: JournalEvent.Seq | undefined = undefined

    for (;;) {
      const page: Journal.EntriesPage = after === undefined
        ? yield* journal.entries({ runId, limit: 500 })
        : yield* journal.entries({ runId, after, limit: 500 })

      for (const entry of page.entries) console.log(entry.seq, entry.eventType)

      const last = page.entries.at(-1)
      if (!page.hasMore || last === undefined) break
      after = last.seq
    }
  })
```

`limit` is capped at `Journal.maxEntriesLimit` (10,000). A page is decoded into
memory in full before the caller sees its first entry, so an unbounded limit
would let one call materialize a whole run.

For a nonempty list of at most 64 exact event types, use the optional `eventTypes` field on `entries`:

```ts
const finished = yield * journal.entries({ runId, eventTypes: ["build.finished", "build.failed"], limit: 100 })
```

This is a new public query option. Filtering happens in SQL before the page
limit, using the journal's `(run_id, event_type, seq)` index. `SqlJournal` is the
existing SQLite-specific adapter and explicitly selects that index: SQLite can
otherwise choose the run/sequence index for an `IN` query and scan unrelated
history. Multiple types may sort matching rows by sequence. The dialect-specific
hint stays inside `SqlJournal`; `Journal.Service` remains platform-independent. `after` remains the
canonical run sequence, and `hasMore` counts only matching events. Gaps between
matching sequences are expected. Duplicate types do not duplicate entries. No match returns an empty final page. Omitting
the option preserves the existing full-run read. The event type uses the same
bounded identifier schema as journal emission.

Filtering does not restore compacted evidence: a cursor below the run's
compaction floor still fails with `compacted`, even when no matching row remains.
Apply journal migration `0005_run_event_type` before using the updated service.
Custom `Journal.Service` adapters must implement the filter before a caller
relies on it; an older adapter may silently ignore an unknown option.

## Follow a run with stream

`stream` replays the run's durable history from `afterSequence`, then follows
its committed tail. It is the lossless reader, and the one to use wherever a
missing entry would be a correctness bug:

```ts
import * as Stream from "effect/Stream"

const follow = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  yield* journal.stream({ runId }).pipe(
    Stream.runForEach((entry) => Effect.log(`${entry.seq} ${entry.eventType}`))
  )
})
```

Three properties are worth knowing before you use it:

- It pages the history rather than materializing it, so the first entry arrives
  after one page rather than after the whole run.
- It reports a sink loss that happens while it is following, to every consumer
  that was following at the time.
- **It never completes.** Following is the point, so bound the stream yourself:
  `Stream.take`, `Stream.takeUntil`, or a forked fiber you interrupt.

A cursor below the run's compaction floor fails with `compacted` and the
sequence to resync from, never a silently shortened history. See
[Checkpoints and compaction](../concepts/compaction.md).

## Tail this process with changes

`changes` is a scoped subscription to the entries this process commits, across
every run:

```ts
import * as PubSub from "effect/PubSub"

const tail = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const subscription = yield* journal.changes
  const entry = yield* PubSub.take(subscription)
  console.log(entry.runId, entry.seq)
}).pipe(Effect.scoped)
```

Two limits make it a local convenience rather than a reader of record:

- It is a bounded sliding buffer sized by the layer's `capacity`. A slow
  subscriber loses entries with no error and no gap signal.
- Only this process's commits arrive. Another writer on the same database
  publishes into its own buffer, which is the second reason `stream` exists: it
  rechecks the durable tail.

Entries published to `changes` are deeply frozen, so one subscriber cannot
mutate the value another subscriber is about to read.

## Make a lossy write readable first

A `flush` before a read makes queued lossy entries visible. A durable entry
needs no flush; it was committed when its receipt arrived.

## Next steps

- [Fold a run into a projection](./fold-a-projection.md) to turn entries into a
  served view.
- [Compact a long-running run](./compact-a-run.md) for what a reader below the
  floor should do.
