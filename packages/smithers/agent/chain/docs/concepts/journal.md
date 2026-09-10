---
title: "The journal"
description: "The journal is the only state a chain has. Everything else is a pure fold over its events."
sidebar:
  order: 1
---

The journal is the only state. Every other structure a host shows (the call
cache used for replay, transcripts, timelines, a UI) is a pure fold over the
event array. There is no agent-loop object and no second store.

## The port

`Journal.Service` has two operations:

```ts
interface Service {
  readonly append: (event: Event.Event, expectedPosition: number) => Effect.Effect<void, JournalError>
  readonly read: Effect.Effect<ReadonlyArray<Event.Event>, JournalError>
}
```

`append` takes an `expectedPosition`, so an append is a compare-and-swap: the
journal refuses the write when another writer has advanced past the position
the caller believes is next. `Journal.layerMemory()` is the in-process
stand-in over one array, optionally seeded with prior events; the seed is how
tests replay and resume a chain.

## The events

Six tags make up the whole vocabulary, all in the `Event` namespace:

| Event             | What it records                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `ChainStarted`    | The chain's first event: the goal it was started with and the caller's envelope.                   |
| `LinkAuthored`    | The script a link will execute, recorded before it runs so a resumed link replays the same source. |
| `CallSettled`     | One call that reached an entry and produced a result: the unit the replay cache is keyed by.       |
| `GateRejected`    | One call a gate refused, recorded as the observation the next authoring reads.                     |
| `LinkEnded`       | The outcome a link ended with: the event that advances the link counter.                           |
| `SteeringDrained` | One non-empty steering drain, tied to the live author call it fed.                                 |

Every event carries an optional `chain` field. The root chain omits it, so
existing journals stay byte-identical; a sub-chain sets it to the
deterministic child id (`parent-chain/link.ordinal`), which is how a parent
and its children share one journal without sharing one scope.

## The folds

Because the journal is the only state, every question a host asks is a pure
function of the event array. The `Event` namespace ships the folds the chain
itself uses: `started`, `linkCount`, `authored`, `settled` (the replay
cache), `rejected`, `observations`, `steeringLines`, `steeredOrdinals`, and
`terminal`. Each takes the event array and a chain scope (default `""`, the
root) and returns a projection. A UI that renders a transcript and the
trampoline that resumes a link read the same events through the same kind of
fold; neither writes anything down.

## Concurrency

`Chain.run` reads the journal once, at start, and then tracks the position
it last observed. It cannot simply trust that position, because a sub-chain
legitimately appends to the same journal under its own id while the parent
frame is suspended inside the spawning handler. An append at a stale position
conflicts, and one fresh read decides what moved: when only foreign scopes
grew, the run retries at the new position; when its own scope grew, a second
writer holds it and the run fails with `journal_conflict`. Each `(link,
ordinal)` slot settles exactly once, and each link ends exactly once.

For the full concurrency argument and the compare-and-swap protocol, see
[The chain contract](../contract.md). For the failure codes, see
[Troubleshooting](../troubleshooting.md).
