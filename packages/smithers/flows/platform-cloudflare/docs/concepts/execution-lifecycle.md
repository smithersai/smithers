---
title: "The execution lifecycle"
description: "What start, wake and alarm do, how a child or the next round reaches its own object, how an object's next incarnation replaces a dead one, how a settled object forgets its execution, and which test proves each guarantee."
---

One Durable Object drives one flow execution, and it is named by that
execution's id, so every request about the execution reaches the same object.
The object keeps three things in its own storage: the intent (which flow, which
execution, which payload), a count of alarms that made no progress and, once
the execution settles, when it did. Everything else about the run (its journal,
owner, lease, attempts, timers and result) lives in the engine's Postgres
store. A settled object forgets all three after a retention window; a cancellation tombstone remains; see
[Retention](#retention).

## start

`ExecutionObject.start(storage, intent, effect)`:

1. Stores the intent and arms the alarm at now plus `startGraceMs` (5 seconds).
   The Durable Object's output gate commits both before the caller hears an
   answer.
2. Runs `effect`, the caller's own write, such as the row that shows an answer
   is under way.
3. Moves the alarm to now.

If the isolate dies during step 2, the alarm from step 1 still fires and runs
the flow. The flow's first step must therefore perform the same write, and the
write must be idempotent. If `effect` fails, `start` returns its failure
unchanged and leaves the alarm armed.

The same intent again stores nothing, runs `effect` again and moves the alarm to
now, so a retried request is safe. Another payload for the same execution fails
with `IntentConflict` before anything is stored or run. Both hold while the
object holds the intent, which a settled object does for its retention window.

## Cancellation

Compose handlers with `ExecutionObject.make(storage, options)` once per object incarnation. Its `cancel()` durably stores a cancellation tombstone, arms the alarm immediately and interrupts an active execution through `FlowRuntime.interrupt`. A parked execution finishes cancellation on its next alarm. The engine settles the run as cancelled, releases ownership and interrupts its actions. Cancellation acknowledgment records intent; settlement is observed from the engine.

Admission and cancellation share a short gate: the driver persists admission without starting actions before exposing its active cancellation callback. A cancellation before admission creates no engine row. The tombstone survives intent retention, so a late replay cannot resurrect the run. An optional `canStart(intent)` domain guard runs only before first admission, never while resuming a run with outstanding durable work.

`test/Cancellation.test.ts` proves cancellation before delivery, a dropped domain guard, retention, reincarnation, parked runs and interruption of an unresolved action against real Postgres.

## wake

`ExecutionObject.wake(storage)` moves the alarm to now when the object holds an
intent, and answers `true`. An object that holds none answers `false` and arms
nothing. Another object's alarm calls it, through its router, when its drive
made this execution due. Waking an object with nothing due costs one alarm
that parks it again.

## alarm

`ExecutionObject.alarm(storage, { flows, runtime, router, driveBudgetMs })`:

1. **Counts the attempt and arms the watchdog.** The count of alarms without
   progress goes up by one, and the alarm is armed one backoff away
   (`retryPolicy`: one second, doubling, at most five seconds, never giving
   up). An alarm that dies from here on leaves both behind.
2. **Builds the runtime in the alarm's scope.** `runtime(intent)` is usually a
   `CloudflareRuntime.layer` over a `PostgresDatabase.layer`. Its connections
   close when the alarm ends.
3. **Drives the execution once.** `EngineStore.drive` admits the intent's
   execution, or, when the store holds it, drives it only if it has work due.
   The engine claims the run, or takes it over from a dead incarnation, replays
   what the journal recorded and drives the rest. It does not poll a parked run
   in the isolate: the drive stops at the first park, and a run parked on a
   timer that has not come due is left as it is, without a replay. It also
   stops starting steps once it spends its budget; see
   [The drive budget](#the-drive-budget).
4. **Routes.** It reads from the store which executions the drive left for
   other objects and hands each to `router`. See [Routing](#routing).
5. **Arms the next wake.** The outcome decides it:

| Outcome     | When                                                                                                                                                           | Count   | Alarm                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------- |
| `Idle`      | No intent is stored.                                                                                                                                           | kept    | deleted                                     |
| `Settled`   | The run completed, failed or was cancelled. A flow's own failure is a settlement, not a retry. The object records when.                                        | cleared | armed at `forgetAtMs`                       |
| `Parked`    | The run waits. `wakeAtMs` is `EngineStore.nextWake`: its earliest pending timer, or `null` for an event wait.                                                  | cleared | armed at `wakeAtMs`, or deleted when `null` |
| `Yielded`   | The drive spent its budget and released the run at a step boundary, with work still due.                                                                       | cleared | armed at now                                |
| `Retrying`  | Building the runtime, driving the run or routing failed.                                                                                                       | kept    | armed one backoff away                      |
| `Forgotten` | The run settled and its retention window has passed. The object deleted its intent, its count and its settlement, and retains only any cancellation tombstone. | deleted | deleted                                     |

`alarm` never fails. A failure becomes `Retrying` with the failure's tag, so
Cloudflare's own alarm retries, which stop after six, never decide whether an
execution is driven again.

A parked run's alarm is armed first and `EngineStore.nextWake` read again
after it. Objects interleave events while a handler waits on I/O, so another
object's `wake` can land while this alarm routes, and arming the drive's own
answer would overwrite it. Every waker records its work in the store before it
wakes, so a wake that was overwritten shows in the second read as work due,
and the alarm moves up to it; a wake that lands after the second read arms the
alarm itself. `Parked.wakeAtMs` is what the alarm was left armed for.

A drive that leaves work due now (`EngineStore.drive` reports `Unfinished`:
the runtime refused the execution, or the store became unavailable during the
drive) is `Retrying` with `Undriven` rather than `Parked`, so an object that
cannot make progress backs off instead of waking itself in a loop. A run that
parks on its own wake due within five seconds (a probe's short sleep, a clock
that came due as the park committed) is not that: the drive waits for the wake
and drives the run again in the same alarm (`EngineStore.drive`'s `holdMs`),
where a new alarm would build the runtime and replay the run first.

Each alarm's line says where its time went: building the runtime
(`smithers.execution.build_ms`, also on `cloudflare.execution.ready`), the
drive (`drive_ms`) and routing (`route_ms`), each once the alarm got that far.
Routing reads what the drive left as one read transaction.

## The drive budget

Cloudflare ends an alarm invocation after 15 minutes of wall time, and a run
with enough work, such as an agent's model and tool calls, never parks by
itself. Killed mid-drive, the next alarm would take the run from the dead
incarnation and run its unfinished step again. So the alarm drives with
`EngineStore.drive`'s `budgetMs`, `driveBudgetMs`:

```
alarm: drive ─ step ─ step ─ step ─┬─ budget spent: the next step is held
                                   ├─ the running step finishes and records its result
                                   └─ release the run ─► Yielded, alarm at now
next alarm: drive ─ replay ─ step ─ ...
```

- **Steps that start within the budget run to the end**, however long they
  take; a step whose turn comes after it waits for the next alarm, with no
  attempt written. The run is left unowned, so the next alarm claims it as
  any due run and runs every step exactly once.
- **The budget bounds when steps start, not how long one runs.** Set it below
  900 seconds less the longest step a drive may start, building the runtime
  and routing. `defaultDriveBudgetMs` is 600 seconds.
- **`driveBudget` is the setting**, `EXECUTION_DRIVE_BUDGET_SECONDS`: whole
  seconds from 1 to 899, 600 when unset, read once by the Durable Object class
  and passed to every alarm. Any other value fails with a `ConfigError`.
- **Each drive is timed.** `driveDuration`
  (`smithers_cloudflare_execution_drive_duration`) records how long it ran by
  `outcome` (`settled`, `parked`, `yielded`, `unfinished`, `failed`), in
  buckets up to 900 seconds, and the alarm's span and log line carry it as
  `smithers.execution.drive_ms`. A drive near the top bucket is a step longer
  than the slack the budget leaves.

## Retention

A settled object holds its intent for a retention window, then forgets it.
`settledRetentionMs` is the window: one day unless `alarm` is given
`settledRetentionMs`. With a `settled` handler the window starts only once
the handler took the settlement.

```
alarm: drive ─ settles ─► store when (smithers/settled), alarm at settled + window
alarm before the window ends (a duplicate start, a wake) ─► no runtime, alarm at settled + window
alarm at the window's end ─► delete intent, count and settlement; delete the alarm (Forgotten)

with settled:
alarm: drive ─ settles ─► store when, settled(executionId) ─ fails ─► count, alarm one backoff away (Retrying)
                                                          └ succeeds ─► store when (smithers/reported), alarm at reported + window
```

- **The caller's record is never forgotten.** `settled` takes the
  settlement, such as an application row that leaves `working` when the run
  ends. Every alarm hands it the execution id until it succeeds, retrying with
  the backoff, past the window too; it builds no runtime and never drives the
  run again. The handler must be idempotent: an alarm that dies after it ran
  hands it over again.

- **No drive after settlement.** An object that recorded its settlement never
  builds a runtime again. A duplicate `start` or a `wake` inside the window
  costs one alarm and no database connection, and answers `Settled`.
- **One final alarm, no sweep.** Each settled object arms one alarm for the end
  of its own window. Nothing scans for old objects.
- **A late read is still answered.** After the window `wake` answers `false`,
  and an alarm is `Idle`. A late `start` of the same intent stores it again;
  its alarm finds the run settled in the engine's store, runs no step, records
  the settlement again and forgets it a window later.
- **The id guards its payload only within the window.** Inside it, another
  payload under the same execution id fails with `IntentConflict`. After it,
  `start` stores the other payload, and the engine answers it with the run it
  already holds: an admitted run is never driven with a new payload. Execution
  ids that name one attempt, as a clone's or an answer's does, never meet this.
- **The run's history stays in the engine.** The object deletes only its own
  storage. The run, its journal and its result stay in the engine's Postgres
  store until the operator's own retention pass (`@smthrs/engine-store`'s
  `Retention`, run by `smithers gc`) deletes them. Deleting them from the object
  would let a late `start` of the same intent run the flow again.

## Routing

The runtime drives only its own execution. A drive can still create executions
and make others due, and each of those runs on an object of its own, named by
its execution id:

| What the drive did                                                              | Store holds                                                                                            | Route                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| A `.child()` call admitted a child.                                             | A `pending` child row, linked to this run.                                                             | `router.start` with the child's intent, from its row.          |
| A `.to()` handoff ended this round.                                             | This round settled, and the next round of its lineage `pending`.                                       | `router.start` with the next round's intent, from its row.     |
| The last round of a lineage settled with a parent waiting.                      | The parent's wake, recorded by the settlement (`EngineStore.drive` records it again if it is missing). | `router.wake` for each parent now due.                         |
| The lineage's last round ended or was cancelled with linked children unsettled. | A cancellation request on each child lineage's current round, linked to any round of this lineage.     | `router.wake` for each such round already started and now due. |

```
parent object                 child object
  alarm: drive ─ admits the child ─ start(child) ──► start: store intent, alarm at now
         drive ─ parks on the child                  alarm: drive ─ claims the child
         route ─ start(child) ──► start: duplicate, alarm at now
                                  alarm: drive ─ settles, records the parent's wake
                                         route ─ wake(parent)
  alarm ◄──────────────────────────────────────────┘
         drive ─ reads the child's result, settles
```

A child also starts the moment its admission commits, during the parent's
drive (`WakeBus.Admitted`), so its object claims it beside the rest of that
drive instead of after the parent parks. That start is a shortcut: it waits at
most `admittedStartTimeoutMs` (2 seconds), a failure is logged as
`cloudflare.execution.admitted` and fails nothing, and the routing below starts
the child again either way.

The routes are read from the store after every drive, never taken from what
the drive reported, so they survive the alarm: one that dies after its drive
and before its routing leaves the watchdog armed, and the next alarm finds the
run settled or parked with nothing due, drives nothing, and routes the same
executions again. `start` with the same intent and `wake` change nothing the
second time. A router call that fails is `Retrying`, and the next alarm routes
again.

A child is routed by its lineage's current round, not by the id it was
created under: a child that handed off is running its next round on another
object. While a lineage runs, only children linked to the round just driven
are read; once its last round settles, children linked to every round are,
because that settlement ends them all.

"Now due" is `EngineStore.nextWake` at or before now. A parent that already
read this settlement, a child that settled, and a child parked with nothing
due are left alone, so a duplicate alarm wakes nobody.

Every object routes to objects of its own class, so every object's `flows`
lists every flow an execution may start as a child or hand off to. An object
whose intent names a flow it was not given retries with `UnknownFlow`.

## When an incarnation dies

An isolate reset, an eviction, `ctx.abort()` or a crash in a step ends an alarm
in the middle of its drive. The run is left `running`, owned by that
incarnation, with a fresh lease. The watchdog armed in step 1 fires one backoff
later, in a new incarnation, and that incarnation takes the run over at once:

- `CloudflareHost.layer` gives each runtime build an owner with a drawn
  incarnation number (`OwnerIdentity.layerWithoutPid`). A process id cannot
  tell incarnations apart, because two isolates of one object can report the
  same one.
- `CloudflareRuntime.layer` judges liveness with `@smthrs/run-store`'s
  `Ownership.singleIncarnationLiveness`, which declares an owner dead when it
  carries the claimant's host id and another incarnation. The host id is the object's own
  id, so such an owner is an earlier incarnation of this object.
- The engine asks that question while the owner's lease is still fresh, so the
  takeover does not wait out the lease. The run's interrupted step runs again;
  steps that settled before replay from the journal.

That rule is sound because only one incarnation of an object drives at a time:

- a Durable Object runs one instance at a time;
- the runtime is built only inside `alarm`;
- Cloudflare runs one alarm handler at a time per object. An alarm armed while
  a handler runs, the watchdog included, fires only after that handler ends.
- `CloudflareRuntime.layer` refuses every run but its own execution
  (`canExecute`) and runs no background sweep (`sweep: { host: executionId }`),
  so one object never drives another object's run.

Every owner the rule does not cover, another host's included, is judged by its
lease alone.

## Guarantees and their evidence

| Guarantee                                                                                  | Proven by                                                   |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| A started execution runs to completion from its alarm.                                     | `test/ExecutionObject.test.ts`, over Postgres and PgBouncer |
| A duplicate `start` or a duplicate alarm runs no step twice.                               | `test/ExecutionObject.test.ts`                              |
| A `start` whose caller dies before its write still leads to a run.                         | `test/ExecutionObject.test.ts`                              |
| A parked timer arms the alarm for its due time, and a later alarm resumes the run.         | `test/ExecutionObject.test.ts`                              |
| An incarnation killed inside a step is replaced at once, without repeating settled steps.  | `test/Crash.test.ts`: a `SIGKILL`ed Node process            |
| An alarm that dies mid-drive leaves its attempt counted and a successor armed.             | `test/ExecutionObject.test.ts`                              |
| A real object finishes a run after `ctx.abort()` inside a step, one backoff later.         | `test/WorkerdSmoke.test.ts` (`FLOWS_WORKERD_SMOKE=1`)       |
| workerd starts no alarm handler beside a running one.                                      | `test/WorkerdSmoke.test.ts`, the `Probe` object             |
| No payload or failure text reaches a log line, span attribute, failed span or metric.      | `test/Observability.test.ts`                                |
| A settled object answers duplicates without a drive and empties itself after its window.   | `test/ExecutionObject.test.ts`; `test/WorkerdSmoke.test.ts` |
| A late `start` after the window runs no step again and the object forgets it again.        | `test/ExecutionObject.test.ts`; `test/WorkerdSmoke.test.ts` |
| A parent's child runs on its own object, and its settlement wakes the parent.              | `test/Routing.test.ts`; `test/WorkerdSmoke.test.ts`         |
| A child's object starts as soon as its admission commits, before the parent's drive parks. | `test/Routing.test.ts`                                      |
| A child start that fails during the drive is left to the routing after it.                 | `test/Routing.test.ts`                                      |
| A child's failure fails its parent.                                                        | `test/Routing.test.ts`; `test/WorkerdSmoke.test.ts`         |
| Each round of a handoff lineage runs on its own object, a reset round included.            | `test/Routing.test.ts`; `test/WorkerdSmoke.test.ts`         |
| A wake that lands while the woken object's alarm runs is kept.                             | `test/Routing.test.ts`                                      |
| A failed router call retries, and the next alarm routes what the drive left.               | `test/Routing.test.ts`                                      |
| A cancelled parent's routing wakes the current round of the child lineage it cancelled.    | `test/Routing.test.ts`                                      |

## Limits

- **At least once.** A step interrupted by a reset runs again in the next
  incarnation, and so does a model call made by it. Make each step's effects
  idempotent.
- **Event waits need a wake.** A run parked on a `DurableDeferred` with no timer
  is `Parked` with `wakeAtMs: null`, and the alarm is deleted. Whoever
  completes the deferred must also call the object's `wake`, and so must
  whoever cancels an execution from outside.
- **Alarm time.** Cloudflare stops an alarm handler after 15 minutes of wall
  time. A drive that long is resumed by the next incarnation; a single step
  that long never finishes on this host.
- **No filesystem.** A step that declares a file boundary fails; see [the Cloudflare Host surface](./host-surface.md).

### Admission timing

Join start-path records on `smithers.execution.id`. The intent retains the
caller's `requestedAtMs` (older intents remain readable);
`cloudflare.execution.request` records it when the object receives the call.
`cloudflare.execution.ready` records `readyAtMs` after runtime construction.
The engine emits `flow.run.created` with `createdAtMs` after admission commits,
and `flow.run.claimed` with `claimedAtMs` after activation. The claim also names
the incarnation that took the run (`ownerHostId`, `ownerPid`) and, for a steal,
the one it took the run from (`stolenFromHostId`, `stolenFromPid`) and the
liveness `evidence`. Alarm failures
include their cause tag, attempt, `delayMs`, and `retryAtMs`. These fields
contain no payload or provider message. Outcome counters retain bounded labels;
execution ids belong only to logs and spans.

Repeated starts arm the alarm immediately, even if the caller write fails.
A repeated failed caller can no longer keep moving admission five seconds
into the future. Host recovery waits at most five seconds after a failure;
flow actions retain their own durable retry policies.
