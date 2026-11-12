---
title: "Suspension and cancellation"
description: "What a suspended execution is, how a caller waits for one and when it gives up, and how interrupt and interruptUnsafe differ from each other and from a park."
sidebar:
  order: 5
---

An execution settles in one of three shapes, and only one of them is an answer:

| Result      | Meaning                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `Complete`  | The run finished. The exit carries the value or the failure.                                |
| `Suspended` | The run parked. It is waiting on something outside itself and will continue when re-driven. |
| `Handoff`   | The round finished by naming the next one. See [Trampoline rounds](./trampoline-rounds.md). |

A run parks when it awaits a `DurableDeferred`, sleeps on a `DurableClock`, or
waits for a human. Parking is not failure and it is not blocking: the fiber is
gone, and what remains is a durable record that something is owed.

## How a caller waits

Who is waiting decides what happens next.

A nested execution, a flow running inside another flow, does not poll. Its
suspension propagates: the parent suspends too, and the whole tree parks
together on one record.

In the in-memory engine, a completion that lands after a live child has read
its wait is delivered when that child parks. A root keeps the same wake for
its follower's next elapsed poll. It does not start an extra round merely
because its live body completed a deferred, such as a race result, before
parking on a later step.

A top-level caller runs a re-drive loop. It sleeps a delay derived from the
attempt count, calls `resume`, and re-drives. Deriving the delay from a count
rather than holding a schedule object is what lets the backoff survive a
restart.

When the store implements `resumeSignal`, the engine races that signal against
the sleep, so an in-process wake, a completed deferred, a fired clock, or an
operator resume, continues the caller at once and the polling schedule becomes
the bounded fallback rather than the mechanism.

## The caller's budget, and what it does not bound

`suspendedRetryPolicy` is declared on the flow, and it bounds ONE CALLER's
wall-clock patience. When the schedule is spent the caller dies with
`SuspendedResumeGaveUp`, and `reason` says which bound closed:

- `"expired"`: the elapsed-time bound closed the window while attempts
  remained.
- `"exhausted"`: the attempt count ran out.

What the budget does not do is end the run. The execution stays parked, nothing
is cancelled, and the next caller, a second process, a sweep, or a resume,
starts a budget of its own. Bounding the WORK is a different tool: an action's
own `RetryPolicy`, whose `maxAttempts` and `expirationMs` the engine restores
from persisted state. See [Retries and attempts](./retries.md).

The default policy never gives up: a 200 ms initial delay growing by 1.5 up to
30 seconds, with no `maxAttempts` and no `expirationMs`. Declare
`suspendedRetryPolicy` on the flow when a caller must stop waiting.

## Cancellation

Two operations cancel, and the difference is what they promise:

| Operation         | Promise                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `interrupt`       | Cancel with normal cleanup and compensation. Finalizers run, and the run settles as a completion carrying an interrupt cause. |
| `interruptUnsafe` | Cancel without guaranteeing cleanup or compensation.                                                                          |

Neither is a pause. Both are requests, and both are idempotent: an unknown
execution id is a silent no-op, because a reaped run has nothing left to
cancel. A durable store may report `FlowRuntime.CancelRequestFailed` when it
could not record the request; the in-memory engine never does.

The in-memory engine shows the shape a store should match. A normal
`interrupt` is delivered to the fiber the flow body runs in, not to the round
fiber, so the round fiber survives to convert the interruption into the
recorded cancellation. Delivery is a send rather than a wait: a body pinned in
an uninterruptible region settles on its own time with the request already
recorded. A body that has not started yet observes the flag on its first
instruction and self-interrupts, so a cancellation that arrives before the work
does still counts.

A child execution is cancelled with its parent. The engine records the linked
cancellation when the parent is torn down interrupted; a store that cannot
record it has the failure logged rather than swallowed, and a durable store
cascades cancellation over its own persisted parent edges independently, so the
in-process link is the prompt delivery and not the guarantee.

## Related

- [Execution identity](./execution-identity.md): why `resume` and `interrupt`
  are silent about ids they do not know.
- [Test flows on the in-memory engine](../guides/test-in-memory.md): driving a
  park and a wake deterministically in a test.
