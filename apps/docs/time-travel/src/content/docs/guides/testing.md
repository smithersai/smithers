---
title: "Test against history"
description: "Seed a run's past with the in-memory store, assert on what an operation did rather than what it returned, inject a failure at a named step, and stub only the methods a test exercises."
sidebar:
  order: 7
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/time-travel/docs/guides/testing.md"
---

Testing time travel means describing a past and then checking what an operation
made of it. `MemoryTimeTravelStore` exists for exactly that: it is
deterministic, needs no database, runs in the browser, and exposes its whole
world so a test can assert on what a rewind _did_ rather than on what it
returned.

## Seed a past

`MemoryTimeTravelStore.make` takes the history the store starts life holding:

```ts
import { MemoryTimeTravelStore } from "@smthrs/time-travel"

const lineageId = "run/root"

const record = (seq: number, amount: number): MemoryTimeTravelStore.JournalRecord => ({
  runId: "run",
  seq,
  eventId: `event-${seq}`,
  lineageId,
  payload: { eventType: "test.credited", payload: { amount }, meta: { lineageId } }
})

const store = MemoryTimeTravelStore.make({ records: [record(0, 10), record(1, 20), record(2, 30)] })
```

The other seeds describe the rest of the world the operation reads:

| Option        | What it describes                                                                             |
| ------------- | --------------------------------------------------------------------------------------------- |
| `records`     | Journal records the run has already written, oldest first.                                    |
| `edges`       | Pre-existing lineage edges, for a run that already has descendants.                           |
| `snapshots`   | Anchors the snapshot projector would have recorded.                                           |
| `liveRuns`    | Runs to treat as still executing, so a frame in one is refused `live_parent` or `live_child`. |
| `runOwners`   | The owner each run records, which is what `archiveAndTruncate` fences on.                     |
| `runStatuses` | The status each seeded run row records. An absent run id models a missing row.                |
| `failAt`      | An internal step to fail at, so a crash path is reachable without crashing.                   |

`make` returns the store widened with a `state()` inspector. That widening is
the reason to call it rather than `MemoryTimeTravelStore.layer`: the inspector
is not part of the `TimeTravelStore` contract, so a test that wants to assert
on archived records or surviving edges has to hold the concrete store.

## Assert on the world, not the return value

`state()` copies every collection on read, so a test can capture the world
before an operation and compare it with the world after, including the parts no
operation returns:

```ts
import { TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const rewound = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  const before = store.state()

  yield* timeTravel.rewind(position)

  const after = store.state()
  // Records moved aside rather than disappearing.
  expect(after.archived.length).toBe(before.records.length - after.records.length)
  // The audit row the rewind opened is closed.
  expect(after.audits.map((audit) => audit.status)).toEqual(["completed"])
})
```

The collections are `records`, `archived`, `edges`, `audits`, `receipts`,
`snapshots`, `liveRuns`, `runOwners`, `runStatuses`, and `forkIntents`.

## Reach a crash path without crashing

`failAt` throws an `unknown`-coded `TimeTravelError` at a named internal step,
so a test can interrupt a rewind mid-flight and then assert that the next layer
build finishes or rolls it back:

```ts
const store = MemoryTimeTravelStore.make({ records, failAt: "archiveAndTruncate:commit" })
```

The steps are `writeAudit`, `updateAudit`, `recordSnapshot`, `recordReceipt`,
`nextForkId`, `abandonForkIntents`, `createFork:start`, `createFork:copy`,
`createFork:commit`, `archiveAndTruncate:start`,
`archiveAndTruncate:before-archive`, `archiveAndTruncate:before-truncate`, and
`archiveAndTruncate:commit`.

Where the failure lands decides what the audit row looks like afterwards. A
failure at `writeAudit` leaves no row at all; one at `updateAudit` leaves it
`in_progress` for recovery to finish; one at `archiveAndTruncate:commit` closes
it `failed`.

## Stub only what the test exercises

`TimeTravelStore.makeNoop` fails every operation with an `unknown`-coded error
except the ones you override:

```ts
import { TimeTravelStore } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const store = TimeTravelStore.makeNoop({
  snapshotAt: () => Effect.succeed(undefined)
})
```

The failing default is deliberate. A test that stubs the two methods it
exercises gets a named failure the moment the code under test reaches a third,
instead of a silent success built on a value nobody wrote.
`TimeTravelStore.layerNoop(overrides)` provides the same thing as a layer.

Reach for `makeNoop` when the point of the test is that a specific method was
or was not called. Reach for `MemoryTimeTravelStore` when the test needs a
working store.

## Build the service over doubles

`TimeTravel.layer` needs four more services. For a replay test, the journal is
the only one that has to answer:

```ts
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { TimeTravel, TimeTravelStore } from "@smthrs/time-travel"
import * as Layer from "effect/Layer"
import { journalOf } from "./MemoryHarness.ts"

const journal = journalOf(store)

const layer = TimeTravel.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(
    Layer.succeed(TimeTravelStore.TimeTravelStore)(store),
    Layer.succeed(Journal.Journal)(journal),
    Layer.succeed(RunStore.RunStore)(RunStore.makeNoop()),
    Layer.succeed(CacheStore.CacheStore)(CacheStore.makeNoop()),
    Jj.layerNoop({})
  ))
)
```

`journalOf` lives in `test/MemoryHarness.ts`, next to `row` (a `RunStore.RunRow`
fixture whose every field is an override) and `makeRuns` (the claim, activate,
abandon, and fenced-transition double). It reads the store on every call rather
than once, so a suite that truncates history mid-test sees the shortened
journal on the next page. `test/RealTimeTravelHarness.ts` is the other half of
the pair, for the SQL and jj composition.

`meta.lineageId` is what a fold filters on, so a seeded record has to carry it.
A record without it is kept in every lineage, which is a different test than
the one you probably meant to write.

## Where to go next

- [Provide a store](/guides/provide-a-store/): the durable store this one is a peer
  of.
- [Replay a run into a view](/guides/replay-a-run/): what the fold does with the
  records you seeded.
