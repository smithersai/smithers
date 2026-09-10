---
title: "List a workspace's runs"
description: "Choose the run catalog a workspace subscription reconciles against: a fixed set, an in-process registry, or a poll of the durable run set another engine writes."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sync/docs/guides/list-workspace-runs.md"
---

A workspace subscription serves the runs a `RunCatalog` lists. The catalog is
supplied by the host rather than derived from the journal, because
[`@smthrs/journal`](https://journal.smithers.sh/reference/api/) has no workspace-wide list or watch contract.
This guide picks the right implementation.

## The contract

```ts
import type * as RunCatalog from "@smthrs/sync/RunCatalog"
```

`list` is the authoritative run set. `changes` is a low-latency wake and
nothing more: a subscriber that misses an announcement re-lists rather than
losing state. A workspace subscription reconciles its covered set against
`list` on every round, so a dropped notification costs latency and never state.

`list` must name each run at most once. Every implementation here deduplicates,
and `SyncServer` deduplicates again at the seam rather than trusting a host's
catalog, because both fan-out paths key a run's served position by run id: a
run named twice is read twice from the same position and its entries are served
twice.

Every implementation returns a fresh array from `list`, so a caller may retain
and sort what it receives without disturbing another reader.

## A fixed set

```ts
import type { JournalEvent } from "@smthrs/journal"
import * as RunCatalogNs from "@smthrs/sync/RunCatalog"

const fixed = RunCatalogNs.layerStatic(["build-42" as JournalEvent.RunId])
```

`changes` is empty, so nothing is ever announced. Use it when the covered set
is known at composition time, and for tests. `RunCatalog.layerNoop` is
`layerStatic([])`.

## Runs this process creates

`makeMemory` returns a catalog and the `register` function that grows it. A run
is published exactly once, when it is first registered:

```ts
import * as Effect from "effect/Effect"

const local = Effect.gen(function*() {
  const { catalog, register } = yield* RunCatalogNs.makeMemory()
  yield* register("build-43" as JournalEvent.RunId)
  return catalog
})
```

The announcement feed slides at `RunCatalog.defaultChangesCapacity`
announcements: registering never waits on a stalled subscriber and never grows
the process on its behalf. A subscriber that falls further behind loses the
oldest announcements and converges by re-listing.

This catalog only ever hears about runs the same process registered. A follower
composed against it never learns of a run another engine created.

## Runs any engine creates

`makePolling` re-reads a durable source on an interval.
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) supplies that read as
`RunCatalogRead`, over its own `flows_runs` table:

```ts
const durable = (read: Effect.Effect<ReadonlyArray<JournalEvent.RunId>>) =>
  RunCatalogNs.layerPolling({ read, intervalMs: 1000 })
```

Anything that answers the same question works; the catalog holds no assumption
about which. The interval defaults to `RunCatalog.defaultPollIntervalMs`, one
second, and the read costs one bounded query per interval per composition, not
per subscriber.

Four behaviors are worth knowing before you rely on it:

- **It primes itself before returning.** The first read a follower makes is
  already current, and a workspace that cannot be read at all fails the
  composition instead of serving an empty run set.
- **A failed read is a warning and nothing else.** The previous view stands,
  the interval holds, and no subscription attached to the catalog is torn down.
  The warning is logged once per outage with the first failure's cause, and one
  info line marks the read that ends it; the failed polls in between are silent.
- **A run is announced once**, when it first appears. A run the read stops
  naming, which is what retention collecting it looks like, leaves the view.
  `list` is the workspace's run set, not a log of every run it ever had.
- **The poll fiber belongs to the caller's scope.** Closing the scope stops it.

Polling rather than waking is deliberate at 1.0.0-rc.0: there is no
cross-process event delivery, so a follower learns of another engine's run by
asking the workspace again, and the interval is the whole of the policy.

## Choosing an interval

The interval is how long a run can exist before a follower sees it. One second
is short enough that a run appears in a dashboard while the operator is still
looking at the command that started it, and long enough that an idle workspace
is close to free. Lower it only when a real user is waiting on the difference,
and remember that the workspace subscription's own `tailIntervalMs` is a second
bound on the same latency.

## Related pages

- [Serve the read path](/guides/serve-the-read-path/): where the catalog is
  provided.
- [Coordinate two processes over one store](https://engine-store.smithers.sh/guides/coordinate-two-processes/):
  the durable read this catalog polls.
