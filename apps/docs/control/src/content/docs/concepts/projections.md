---
title: "Journal projections"
description: "How watch turns committed journal entries into ControlEvent values, why a cursor scopes to one run, how the snapshot hands off to the live tail, and which deltas the plane derives rather than records."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/concepts/projections.md"
---

`watch` is a projection, not a bus. It reads committed journal entries and maps
each one onto a `ControlEvent`:

```ts
interface ControlEvent {
  readonly sequence: number
  readonly kind: string
  readonly runId?: string | undefined
  readonly occurredAt: number
  readonly payload: Json
}
```

A consumer that subscribes after the fact still receives what it missed,
because the cursor is durable and the source is a table rather than a live
fan-out that forgets.

## Partitions, and why a cursor needs a run

The journal is partitioned. Every run is a partition, and each plan gets one of
its own under the id `plan:<planId>`. Sequences are partition-local: the plan
partition and every run partition each start at 0.

One scalar cursor applied to all of them would therefore skip every lower
unseen sequence in every partition but the one the cursor came from. So
`watch` refuses either `afterSequence` or `afterCursor` without a `runId`:

```text
InvalidInput: afterSequence: a watch cursor resumes one run, so it requires runId
```

Exactly-once resumption is a promise about a scoped watch, and only about a
scoped one.

## Snapshot, follow, and the handoff between them

`WatchFilter.follow` selects the delivery mode.

- `follow: false` asks for a finite snapshot of what is durable when the
  request is handled. The stream ends. This is the mode a test and a one-shot
  reader want.
- Omitting `follow` opens the live stream a UI subscribes to. It does not end.

The live stream is a handoff, not a deduplicated overlap. The projection
subscribes to journal changes first, then pins a high-water sequence for each
partition it can see. A row committed at or below its partition's mark is read
from the finite snapshot; a row above it is read from the buffered tail. An
entry from a partition the snapshot never read has no mark and passes straight
through.

The unscoped watch reads eight partition snapshots at a time and keeps one
reserved slot so the live tail is never starved behind snapshot work. An
unbounded merge would read every partition of an unbounded database at once,
which is an allocation a remote watcher could force.

## What the plane writes

These entries are the control plane's own records. With the SQL runtime and
journal on the same database, each commits inside the same transaction as the
state change it describes.

| Kind                                                                   | Written by                                          | Partition           |
| ---------------------------------------------------------------------- | --------------------------------------------------- | ------------------- |
| `control.plan.created`                                                 | `plan`, on creation or repair of a missing entry    | `plan:<planId>`     |
| `control.approval.approved`, `control.approval.denied`                 | `approve`, `deny`                                   | the plan or the run |
| `control.run.accepted`                                                 | `run`, once the row exists                          | the run             |
| `control.run.running`                                                  | `run`, when the executor took the launch            | the run             |
| `control.run.pending`                                                  | `run`, when it did not                              | the run             |
| `control.run.resumed`                                                  | an approval on a node target, naming the delegation | the run             |
| `control.run.resume`                                                   | `resume`, carrying the principal and the reason     | the run             |
| `control.run.cancel-requested`                                         | `cancel`, carrying the principal and the reason     | the run             |
| `control.run.cancelled`, `control.run.completed`, `control.run.failed` | `cancel` and launch settlement                      | the run             |
| `control.signal.delivered`                                             | `signal`                                            | the run             |
| `control.steer.enqueued`                                               | `steer`                                             | the run             |
| `control.steer.woke`                                                   | `steer`, when it ended a park                       | the run             |
| `control.monitor.beat`, `control.monitor.healed`                       | `Monitor.run`                                       | the run             |

`plan` commits the card, idempotency key, approval token and creation entry in
one journal transaction. A keyed retry returns the stored card and checks its
partition for the creation entry. If an older write left that entry missing,
the retry appends it once before returning.

The memory runtime publishes one card per key, including concurrent requests.
It cannot roll back its maps with a journal transaction. A keyed retry repairs
a failed creation entry while retaining the original card.

## What the plane derives

Two kinds are computed from entries other packages wrote, and are emitted
beside their source entry rather than recorded:

| Derived kind              | Derived from                                                  | Module     |
| ------------------------- | ------------------------------------------------------------- | ---------- |
| `control.run.lineage`     | `flows.engine.run-decision`, `flows.time-travel.fork-created` | `Lineage`  |
| `control.steer.delivered` | `flows/notifications/Promoted`                                | `Steering` |

Deriving rather than re-recording is what keeps the halves honest. The boundary
that delivers a steer runs in the agent process, not this one, so a control
plane that wrote its own delivery record would be asserting a fact it did not
observe.

Each derived event carries its source sequence. `watch` also assigns a
composite `cursor` that distinguishes members of an expansion. Checkpoint
`event.cursor` and resume with `afterCursor` to retain unconsumed deltas.
`afterSequence` skips the whole source entry, including its deltas. Expansion
runs after the snapshot-to-tail handoff.

`Lineage.derive`, `Lineage.expand`, `Steering.derive`, and `Steering.expand`
are exported, so a client reading the journal directly reaches the same
conclusions the server does.

The two foreign event types are named as strings rather than imported. A
control plane reads journals, not engines, and one that depended on the engine
could not project a journal a different engine wrote.

## Where to go next

- [Watch a run's events](/guides/watch-a-run/): the projection as a task.
- [Run lineage](/concepts/lineage/): what a `control.run.lineage` delta says.
- [Steer a running agent](/guides/steer-a-run/): the two moments a steer
  has, and their two writers.
