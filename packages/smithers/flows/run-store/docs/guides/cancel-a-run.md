---
title: "Cancel a run"
description: "Record cancellation intent from any observer, read it from the owner, and settle the run under a transition guard so a completion and a cancellation can never both win."
sidebar:
  order: 4
---

Cancellation is two halves that never share a fence. Any observer records the
intent with `requestCancel`. Only the owner acts on it, with a guarded
`transitionOwned`. Nothing interrupts the owner for you: the request is durable
intent, and the owner decides where its flow can stop cleanly.

## Record the request

For a logical run that can hand off, use `requestCancelLineage`: a completed
round is not necessarily a completed job. It resolves every round and records
intent atomically, including a successor that exists when the transaction wins.
The engine's handoff transaction refuses to admit a successor if cancellation
won first. `requestCancel` remains the lower-level, single-round operation used
by owners coordinating lifecycle transitions and child cleanup.

```ts
import { RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"

const ask = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const nowMs = yield* Clock.currentTimeMillis
    return yield* runs.requestCancelLineage(runId, nowMs)
  })
```

Neither request operation takes an owner, on purpose. An operator, a parent run, or a
control plane asks for a cancellation without holding the run, and the write is
first-writer-wins, so asking twice is harmless.

| Outcome            | What it means                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `CancelRequested`  | This call wrote `cancel_requested_at_ms`, and `requestedAtMs` is the value it wrote.          |
| `AlreadyRequested` | A request was already recorded. `requestedAtMs` is the original time, not the one you passed. |
| `Terminal`         | The run had already settled, so nothing was recorded. `status` says which ending it lost to.  |
| `NotFound`         | No such run row.                                                                              |

For each round, the status predicate is part of the same statement that writes the column, so a
run that settles between your read and your request loses the write instead of
racing it. A settled run records nothing because it has no owner left to observe
the intent, and a reader that took the column as live intent would go on
cancelling children the finished parent had already dealt with.

For `requestCancelLineage`, the outcome summarizes the transaction: any newly
recorded request yields `CancelRequested`; otherwise an existing request yields
`AlreadyRequested`. `Terminal` means every round is settled and reports the
latest round's status. Terminal predecessor rows are never rewritten.

`nowMs` is taken literally and is not bounded by `heartbeatSkewAllowance`: this
timestamp is request data rather than a lease predicate, so the only rule is
that it must be a non-negative safe integer. See
[The heartbeat lease](../concepts/leases.md).

## Read the request as the owner

The request is a column on the run row, so the owner reads it with `get`:

```ts
const cancelRequested = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const row = yield* runs.get(runId)
    return row.cancelRequestedAtMs !== null
  })
```

Poll it at a point where the flow can stop without leaving work half done.
[`packages/smithers/flows/examples/19-cancel-and-child-cleanup.ts`](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/examples/19-cancel-and-child-cleanup.ts)
polls exactly this column and cleans up its children before it settles.

## Settle under a guard

A `TransitionGuard` is an extra predicate compiled into the same `UPDATE` as the
ownership fence, so a request that arrives while you are deciding cannot slip
between a check and a terminal write.

```ts
import type { OwnerId } from "@smthrs/run-store/Ownership"

const settleCancelled = (runId: string, owner: OwnerId, state: unknown) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    return yield* runs.transitionOwned(runId, owner, "cancelled", JSON.stringify(state), {
      cancelRequested: "present"
    })
  })
```

`{ cancelRequested: "present" }` admits the write only while a request is on the
row, so a run is never recorded as cancelled without one. Put the mirror image
on the completion:

```ts
const settleCompleted = (runId: string, owner: OwnerId, state: unknown) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    return yield* runs.transitionOwned(runId, owner, "completed", JSON.stringify(state), {
      cancelRequested: "absent"
    })
  })
```

Together the two guards make the pair exclusive in SQL rather than in your
control flow.

`GuardFailed` means you still own the run and the predicate refused the write.
That is a different situation from `FenceLost`, which means another owner holds
the run: the store checks ownership first and only reports `GuardFailed` for a
row you genuinely own.

## Let the guard tell you

A guard on the mid-flight progress write turns the next checkpoint into the
notification:

```ts
const recordProgress = (runId: string, owner: OwnerId, state: unknown) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    return yield* runs.transitionOwned(runId, owner, "running", JSON.stringify(state), {
      cancelRequested: "absent"
    })
  })
```

While no request exists the write reports `Transitioned`. The moment one lands,
the same call reports `GuardFailed` and the owner learns about the request
without a separate read.

## What a cancellation does not do

- It does not interrupt the owner. A request is a row, not a signal, and an
  owner that never reads it runs to completion.
- It does not clear the column. `transitionOwned` clears the owner, the
  heartbeat, and the claim, and never touches `cancel_requested_at_ms`, so a
  settled run keeps the record of what was asked.
- It does not decide the ending. A run whose owner honored a request settles as
  `cancelled`; one that finished first settles as `completed`, and the next
  request reports `Terminal`.

## Next steps

- [Claim a run and finish it](./claim-and-finish-a-run.md): the transition this
  guard rides on.
- [Fencing and ownership](../concepts/fencing.md): why every refused write is a
  named outcome.
- [Troubleshooting](../troubleshooting.md): what to change when a guard or a
  request keeps refusing.

`acknowledgeCancel` checks the running run row's owner triple, not the
`Consensus` strategy lease. Its span records `acknowledged: boolean` and an
`acknowledged` or `not_acknowledged` outcome. Cancellation requests and
acknowledgements increment `flows_run_cancellations` by operation and
outcome, including failures and interruptions. See
[Observe store outcomes](./observe-outcomes.md).
