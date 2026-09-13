---
title: "Overlap and catch-up"
description: "The two policies on every trigger declaration: what happens when a boundary arrives while the previous run is still going, and what a trigger owes after the process was down."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/triggers/docs/concepts/policies.md"
---

Two questions have no default answer that is right for every schedule, so every
declaration answers them itself.

- **Overlap.** A boundary arrived and the previous run has not finished. Skip
  it, remember it, or replace the run in flight?
- **Catch-up.** The process was down across three boundaries. Owe nothing, owe
  the most recent, or owe all three?

Both answers are pure functions over state the store holds, in `Overlap` and
`CatchUp`. The scheduler and the stores call them; nothing about either
decision lives in a database query or in the poll loop.

## Overlap

`overlap` takes one of three values, and `Overlap.decide` applies it:

| Value        | When a run is in flight                                          | Recorded outcome                    |
| ------------ | ---------------------------------------------------------------- | ----------------------------------- |
| `skip`       | The occurrence is dropped.                                       | `skipped`                           |
| `buffer-one` | The occurrence is remembered as the pending one.                 | `buffered`                          |
| `supersede`  | The run in flight is cancelled, and the new occurrence launches. | `superseded` for the old occurrence |

With no run in flight, all three fire. That case is the first line of
`Overlap.decide`, before the policy is consulted at all:

```ts
import * as Overlap from "@smthrs/triggers/Overlap"

Overlap.decide("buffer-one", { running: false, due: 3_600_000 }) // "fire"
Overlap.decide("buffer-one", { running: true, due: 3_600_000 }) // "buffer"
```

`buffer-one` buffers exactly one occurrence, and the buffer is a coalescing
slot rather than a queue. `Overlap.pendingAfter` keeps the later of the two, so
a run that overruns four boundaries leaves one pending occurrence, the newest:

```ts
import * as Overlap from "@smthrs/triggers/Overlap"

Overlap.pendingAfter({ running: true, pending: 3_600_000, due: 7_200_000 })
// 7200000
```

That is a deliberate choice about what a schedule means. A nightly report that
ran long does not owe you four reports; it owes you the latest one. A schedule
that must not lose work belongs in a queue, not in a trigger.

The scheduler drains the buffer through `TriggerStore.claimPending`, which
applies the same claim rules and clears the buffer only when the decision
consumes it.

## Catch-up

`catchUp` decides how much history a trigger replays, and `maxCatchUp` bounds
it:

| Value  | What the trigger owes after downtime             |
| ------ | ------------------------------------------------ |
| `none` | Nothing. The default.                            |
| `one`  | The most recent missed occurrence only.          |
| `all`  | Every missed occurrence, in order, oldest first. |

```ts
import * as CatchUp from "@smthrs/triggers/CatchUp"
import * as Cron from "@smthrs/triggers/Cron"
import * as Effect from "effect/Effect"

const owed = Effect.gen(function*() {
  const cron = yield* Cron.parse("0 * * * *", "UTC")
  return yield* CatchUp.occurrences(
    "all",
    3,
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-01T03:00:00.000Z"),
    cron
  )
  // [ 01:00, 02:00, 03:00 ]
})
```

These are occurrences to dispatch subject to overlap, not a guarantee that
every run completes. Dispatch waits for launch acknowledgement, not completion.
With a run active, `skip` drops subsequent occurrences and `buffer-one` keeps
only the newest pending occurrence. For every-boundary work, use a durable
queue or a flow that processes its own interval backlog.

Three rules are worth knowing before you pick a value.

**A trigger that has never fired owes nothing.** `CatchUp.occurrences` answers
with an empty list when `lastFiredAt` is `undefined`, whatever the policy says.
Registering a weekly trigger on a Sunday evening does not fire it for the Monday
six days gone.

**`maxCatchUp` binds every policy, `one` included.** It defaults to 0, which
pairs with the `none` default: a declaration that states no catch-up intent
owes nothing. But a declaration that says `catchUp: "one"` and leaves
`maxCatchUp` at 0 has said two contradictory things, and the contradiction is
reported rather than resolved. Owing one occurrence under a bound of zero fails
with `catch_up_bound_exceeded`, exactly as owing three under a bound of two
does.

**The bound is checked before any policy branch.** An unusable bound, such as
`-1` or `1.5`, is refused even under `none`, where the policy owes nothing.
The bound is a statement about the declaration, so it is validated where it was
written.

## What a breached bound does to a tick

The scheduler logs a warning annotated with the trigger id and abandons the
backlog when catch-up exceeds its bound. On the first poll of a trigger in a
process, including after restart, it drops the entire owed list, including the
current occurrence, records the current in-process watermark, and waits for a
later boundary. On subsequent polls, it drops the missed backlog but still
dispatches the current occurrence subject to overlap.

## Choosing

The task-shaped version of this page, with the question to ask for each policy,
is [Choose an overlap and catch-up policy](/guides/choose-a-policy/).
