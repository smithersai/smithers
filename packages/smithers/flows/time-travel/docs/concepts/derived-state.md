---
title: "Derived state"
description: "Why time travel folds the journal instead of storing snapshots, what a projection may read, and the two facts a fold cannot derive."
sidebar:
  order: 2
---

Nothing in this package stores "the state at sequence 17". Every answer about a
run's past is folded, on demand, from the records the run committed. This page
is why that choice was made and what it costs you.

## The fold is the whole mechanism

A replay walks the journal prefix at or below a frame and hands each entry to a
projection you write:

```ts
export interface Projection<S> {
  readonly initial: S
  readonly reduce: (state: S, entry: Entry, sealed: unknown | undefined) => S
}
```

`initial` is the state before any record, and `reduce` folds one entry into it.
The third argument is the sealed result recorded for that entry, when it has
one, so a projection can see what a step returned rather than only that it ran.

Because the fold is a pure function of durable evidence, two consequences
follow, and they are the point:

- **The past cannot drift.** Re-running the same fold over the same history
  produces the same answer forever. There is no derived table to fall out of
  step with the journal, and no migration that could rewrite an old answer.
- **A replay cannot execute anything.** The fold has no dispatcher. A model
  call or a child flow can only be a cache read, so replaying a run is never a
  second run of it, however many times you do it.

`stateAt` and `attemptsAt` on the store work the same way. Run state at a frame
is derived by replaying the run's decision records, not read off the run row,
whose stored state is the run's _latest_ state rather than the state at any
earlier point. Attempts at a frame come from the attempt lifecycle records the
same way, which is what lets a fork inherit only the attempts its frame can
explain.

## What the fold reads, and in what order

Entries come from [`@smthrs/journal`](/api/journal) a page at a time, in
sequence order. Three rules govern the walk, and each one exists because
breaking it produced a wrong answer:

- **Lineage first.** An entry whose `meta.lineageId` names another lineage is
  skipped. A run whose journal interleaves several lineages replays exactly the
  one the frame names.
- **One record per coordinate.** A page may repeat a record or list two out of
  order, so each page is normalized before it is folded. Across pages the
  journal contract is sequence order, so a coordinate the fold has already
  passed is a duplicate when it was folded and corrupt evidence when it was
  not. The second case fails `invalid` rather than being silently slotted in.
- **Stop at the frame.** The fold streams. It reads until the first record past
  the frame and retains nothing below it, so a frame near the head of a long
  run does not pay for the run's whole history.

Sealed results are read under a provenance fence. The cache is asked for the
version that this exact record landed, identified by the run and the entry's
sequence; only an entry recorded elsewhere falls back to the shared
content-addressed head. Without the fence a projection could fold a newer
result into an older frame.

Entries reach `reduce` by reference. Treat them as read-only: mutating one
rewrites the evidence the fold is reading.

## Versioned engine admission

When replay encounters versioned `flows.engine.v2.*` history, pass `engineEvents` in the replay
options. This is an `EngineEvent.Consumer` from `@smthrs/journal/EngineEvent`:
the expected run, lineage id, root run, round, parent and allowed journal
sources, plus an explicit unknown-namespace policy. It must match the replay's
run and frame. Missing scope, malformed known payloads and foreign identity
fail `invalid` before that record reaches the projection, retaining the typed
decoder error as the cause. Semantic lineage comes from the versioned payload;
diagnostic metadata cannot override it.

Unsupported engine versions, such as `flows.engine.v3.*`, fail before folding.

Unversioned history keeps its metadata lineage convention. Attempt
enumeration over it refuses a malformed started marker in both the SQL and
memory stores rather than returning an incomplete list.

The versioned constructors are additive. Engine recovery, fork copying and
anchor projection still use the current authoritative stores and current
writer families. The v2 replay decoder does not claim a whole-engine recovery
cutover or manufacture missing lineage roots and completion values in old
records. See the journal's [authority contract](/pkg/journal/concepts/state-event-authority).

## Every read is bounded

A fold with no bound lets a long or hostile run decide how much memory a verb
takes. `maxHistoryEntries` caps the entries any one operation reads, and an
operation that would cross the cap stops with `limit_exceeded` before it
materializes anything past it. The anchor refresh a fork or rewind runs first
counts against the same cap.

The default is 100,000 entries, published as `defaultMaxHistoryEntries` from
`@smthrs/time-travel/TimeTravel`. The
service default is set once on the layer, and each call may lower or raise it
for itself:

```ts
import { TimeTravel } from "@smthrs/time-travel"

const layer = TimeTravel.layerWith({ maxHistoryEntries: 500_000 })
```

A value that is not a positive integer is refused `invalid` at build.

## The two facts a fold cannot derive

Two things about a frame are not in the records a fold reads, and they are
exactly the two a fork or a rewind needs to put the world back:

- **The Jujutsu pointer** that was current when the sequence was journaled.
- **The plan digest** in force at that point.

They are recorded as an anchor, one row per frame:

```ts
import type { TimeTravelStore } from "@smthrs/time-travel"

const anchor: TimeTravelStore.Snapshot = { runId, frame, changeId, planDigest }
```

`planDigest` is optional because a run driven without a persisted plan has
none. An absent digest means "no plan was in force", never "the digest was
lost".

The engine emits both facts as ordinary journal records, because it is the only
thing that knows them, but it must not write this package's tables: time travel
already depends on the engine's store, so an engine writing these rows would
close a dependency cycle. A projector is the seam that keeps the arrow one way.
It reads the journal, which both packages may depend on, and folds the engine's
snapshot records into anchors. It holds no durable state of its own beyond the
anchors it writes, so replaying the same entries reproduces the same anchors.
The anchor table is also its cursor: a refresh reads the last anchor per
lineage, folds only the entries above the highest one and at or below the
frame, and writes each page's anchors in one store write, so running it twice
over an unchanged run is a no-op in the store, not merely in the result.

Anchors are keyed by lineage, not by run. A record that carries a pointer
forward means "the same pointer as my lineage's previous anchor", never "the
pointer whoever wrote last named".

The refresh a fork or rewind runs before it reads anchors is best effort. The
anchor table is a cache of facts the journal already holds, so a journal that
cannot project must not turn a fork into a failure. What happens instead is
stated in each verb's answer: a fork with no anchor at the frame reports a
warning naming the workspace it could not restore, and a rewind restores no
pointer rather than a wrong one.

## Where to go next

- [Replay a run into a view](../guides/replay-a-run.md): writing the projection.
- [Effect tiers](./effect-tiers.md): the evidence that decides whether history
  can be undone at all.
