---
title: "Durable waits"
description: "How a parked run survives a restart: durable deferreds and clocks, the waiting taxonomy, the sweeps that re-drive stranded runs, and the wake bus that makes the common case fast."
sidebar:
  order: 5
---

A flow that waits is the hard case for durability. The process holding the
timer can die, the completion can arrive while nothing is listening, and the run
can be left parked with no one scheduled to wake it. `DurableEngineState` is the
state that makes waiting survive all three.

## Two durable primitives

A **deferred** is addressed by flow name, execution id, and deferred name. It is
completed once, first writer wins, and its `exit` is the value the resumed run
receives.

A **clock** is addressed the same way and carries an absolute `dueAtMs`.
Scheduling is first writer wins and fenced against the active run owner, so a
process that no longer owns a run cannot arm a timer against it.

Both report outcome unions rather than booleans, so a caller can tell a fresh
write from an idempotent repeat:

| Call               | Outcomes                                       |
| ------------------ | ---------------------------------------------- |
| `completeDeferred` | `Completed` or `Existing`                      |
| `scheduleClock`    | `Scheduled` or `Existing`                      |
| `completeClock`    | `Completed`, `AlreadyCompleted`, or `NotFound` |
| `park`             | `Parked` or `NotFound`                         |
| `wake`             | `Woken`, `NotWaiting`, or `NotFound`           |

A successful mutation means the row is durable. Callers may therefore journal
and schedule a wake only after the mutation returns.

The additive [state event schemas](../../../journal/docs/concepts/state-event-authority.md)
describe execution, deferred and clock history with explicit lineage. Existing
writers retain their bytes and these stores remain authoritative. A retained
attempt-history projection cannot replace deferred, clock or ownership state.

## The waiting taxonomy

A run that suspends parks first. The driver writes a `Waiting` payload with a
`reason`, an optional `wakeAt`, and an optional `token`:

- reason `timer`, with the earliest pending clock deadline as `wakeAt`, when a
  durable clock is outstanding.
- reason `event` otherwise.
- reason `released` for a run interrupt-released by shutdown, a lapsed lease
  or a hosted drive that spent its budget; its `interrupt-released` decision
  records which as `cause`.
- reason `quarantine` for a run parked on corrupt attempt evidence.

Every resume clears the payload when the run re-enters `running`. Because the
driver populates the taxonomy on the execution path rather than only through the
store API, `waitingRuns` and the waiting-row partial index match real
suspensions.

`WaitingRunsFilter` narrows a sweep to actionable rows by `reason`,
`dueBeforeMs`, and a `cancelRequested` predicate over the run row, so a sweeper
fetches only what it can act on instead of scanning every parked run.

## Three sweeps, on the heartbeat cadence

The driver re-drives three durable shapes periodically, and each one re-enters
the ordinary claim, steal, and activate path:

1. Parked runs whose cancellation was durably requested.
2. Runs parked with reason `released`, left by a shutdown that interrupted them.
3. Stale `running` rows left by a hard-killed owner.
   `staleRunningRuns(staleBeforeMs, limit?)` lists runs whose heartbeat froze
   before the horizon, with that heartbeat, oldest first, so a capped sweep drains a mass
   owner death across ticks rather than waking every stale run in every driver
   on every tick.

Registration does its own recovery: `pendingClocks(scope)` re-arms outstanding
timers and `completedDeferreds(flowName)` recovers unconsumed completions. Both exclude rows
whose run has settled, so a restart arms timers for runs that can still make
progress and for no others. Before serving a persisted deferred result, the
engine marks it consumed. Later registration sweeps leave that completion out,
so a run parked on a subsequent approval, timer, or deferred stays parked. The
original result remains available for replay. Migration 0008 starts existing
completions as unconsumed, allowing recovery after an upgrade.

One corrupt row costs its own row and nothing else. Every list read
(`dueClocks`, `pendingClocks`, `completedDeferreds`, `waitingRuns`,
`runParents`, and `runChildren`) skips a row that will not decode and logs a
storage-integrity warning naming its primary key, so a single unreadable row
cannot stop a registration, a timer sweep, or a cancellation cascade. The point
reads `deferred`, `clock`, and `waiting` still fail on such a row: they answer a
question about one row, and reporting "no row" for a completion or deadline that
is durably recorded but unreadable would re-run work whose side effects already
ran.

A wake for a flow the sweeping process has not registered is not dropped
silently. The driver logs a once-per-run structured warning naming the run id
and the flow, and leaves the durable waiting row parked, so any process that
does register the flow still reclaims the run.

## Cancellation is observed, not just recorded

While a run executes, the driver polls `cancel_requested_at_ms` on the heartbeat
cadence and cancels the run, interrupting the flow fiber, when another process
called `RunStore.requestCancel`. A terminal transition additionally asserts
`{ cancelRequested: "absent" }` inside the ownership compare-and-swap, so a
request that races past the last poll turns finalize into a cancellation rather
than a `completed` or `failed` write.

`completeRunClocks(executionId, completedAtMs)` closes every uncompleted clock
row of one run in a single statement, inside the terminal transaction. A run
that settled has no future, so a timer firing against it could only schedule a
resume nothing will drive.

## Retrying a clock that failed to fire

A durable clock whose fire fails transiently is redispatched with capped
exponential backoff rather than being lost until process restart. The policy is
`EngineStore.Options.clockFireRetryPolicy`, defaulting to exponential from 100ms
capped at 30s, forever. It is the same option shape as the engine's
`suspendedRetryPolicy`: the built-in behavior is the default, and a deployment
that wants a different backoff supplies one rather than patching the store.

## The wake bus makes the common case fast

Polling is correct and slow. `WakeBus` is an in-process, edge-triggered bus:
`wake(executionId)` resumes every waiter parked on that execution, `awaitWake`
parks until the next one, and `waiters` reports the current count for tests and
diagnostics.

Nothing about it is durable, and that is the design. A wake with no waiters is
dropped, and the polling fallback covers the run. Registration is removed when
a waiting fiber is interrupted, including scope closure and losing a race
against the polling sleep, so an abandoned wait leaks nothing. Cross-process
delivery stays store-driven.

An engine composition resolves the bus optionally. Provide `WakeBus.layer` to
share one bus between the engine and your own wake sources; provide nothing and
the composition builds a private one. `WakeBus.layerNoop()` drops every wake,
which is what a test asserting the polling fallback provides.

## The run DAG

`DurableEngineState` also owns the parent edges between runs, because a run
row's `state_json` carries only the first creating parent and a diamond gives a
run a second one.

`recordRunParent(childId, parentId)` is first writer wins per pair. An edge
already recorded is answered `Existing` from a read, with no write: a parent
records its edge again every time it executes its child, and every resume of a
run parked on a child does. An edge never changes once written, so the read
answers as the insert's conflict would.

A new edge whose child has no children writes in its child's and its parent's
partitions, with no walk and no schema-wide lock. A cycle runs through every one
of its edges' children, so such an edge can close none, and this is the common
edge: a parent spawning a child, or following a round of a child's lineage. A
job that handed off three times brings its parent three, all in the resume after
it settles, across every lane at once.

Any other edge is checked in a write that names no partition: the edge is
inserted, the child's ancestor chain is walked over the durable edges, and on a
hit the transaction rolls back and the call fails with `RunParentCycleError`. A
rejected edge therefore leaves no durable trace, and of two concurrent writers
whose edges jointly close a cycle exactly one fails: every edge's writer holds
both its runs' partitions or the whole schema, so of a cycle's edges, the one
that commits last sees the edge into its child, takes this path, and sees the
rest. The driver maps that error to `FlowCycleDetected`, and opens the admission
on the whole schema when it can tell beforehand: a lock a transaction takes
after it opens gives up at `lock_timeout`, while the one it opens with waits.

`transaction(effect)` runs several store operations atomically. The driver wraps
the parent-edge record and the run-row creation it guards in one, so a crash
between them cannot leave a durable orphan edge for a run that was never
created. Serialized write transactions are a documented requirement of the
`DurableWriter.write` contract, not a SQLite artifact: a Postgres-backed
implementation must use `SERIALIZABLE`.

`runParents(childId)` and `runChildren(parentId)` list the edges oldest first.
The child direction is the only instance-independent way to find the runs a
cancelled parent linked to itself, so cancellation cascade reads it rather than
an in-process map. `removeRunParentsForRun(runId)` deletes every edge naming a
run as child or parent; an `AFTER DELETE` trigger on `flows_runs` prunes the
same edges in the same transaction, so a lane that never calls the hook still
cannot leave ghost edges.

## Related

- [Coordinate two processes](../guides/coordinate-two-processes.md): sharing a
  wake bus and following a workspace's runs.
- [Ownership and fencing](./ownership-and-fencing.md): why parking and clock
  scheduling take an owner.

### Clock wakes beside external waits

Activation consumes a completed `DurableClock/` wake marker once, even if the action is parked on a separate external deferred. Its persisted completion remains readable for replay. Other event completions remain unconsumed until their waits observe them. This lets a host use an engine clock as a fallback for a missed webhook without repeatedly driving the same due marker.

A hosted recovery can schedule a completed deferred before the host requests
cancellation. If that request stops the recovering drain, the next explicit
drive waits for its cleanup and starts a replacement; it does not inherit the
old drain's interruption. The replacement observes the durable cancellation
before starting a step, including under an exhausted drive budget. Duplicate
deferred completions cannot revive the terminal run. Hosted callers pass the
persisted flow tag for both alarm and signal runtime registration.

Hosted wake publication records readiness and notifies the host, but never
starts an idle or stopping drain. Only an active, non-stopping drive coalesces
a wake. Registration recovery and signal delivery therefore cannot execute
steps before the host applies admission, cancellation and its drive budget.
