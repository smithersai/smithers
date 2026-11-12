---
title: "Run the scheduler in a host"
description: "Compose the durable store, the Control-backed runner, the flow engine and the scheduler layer; choose the poll interval; and understand what happens to running flows when the host shuts down."
sidebar:
  order: 2
---

The scheduler ticks. Every tick it lists every trigger, recovers the
occurrences already running, skips the disabled ones, works out what each of
the rest owes, claims what is due, and launches through a `Runner`.
`Scheduler.layer` runs those ticks for a host on the flow engine's durable
timers: a flow lineage whose rounds each run one tick, sleep for the poll
interval, and hand off to the next round. This guide composes it into a host.

## Compose the layers

Four layers meet: a database, a store over it, a runner beside it, and the flow
engine the host already runs its flows on.

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import * as Layer from "effect/Layer"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "smithers.db" })
)

/**
 * Requires Control.Control, the FlowRuntime the host runs flows on, and the
 * Digest and SecureRandom services that engine keys executions with; provides
 * a running Scheduler.
 */
export const triggers = Scheduler.layer({ pollInterval: "30 seconds" }).pipe(
  Layer.provide(Scheduler.layerControlRunner),
  Layer.provide(SqlTriggerStore.layer),
  Layer.provide(database)
)
```

`SqlTriggerStore.layer` applies the package's migrations when it builds, so
there is nothing to run beforehand. `Scheduler.layerControlRunner` is the
production launcher: it requires `Control.Control` from
[`@smthrs/control`](/api/control) and reaches nothing else.

`Scheduler.layer` registers one step, the tick, over the runner and the store,
and starts the lineage keyed by `host`, or joins the one an earlier host under
that name left. The lineage is the engine's: its wait is a durable clock, its
watermark travels in the next round's payload, and nothing about it lives in
this process. The `FlowRuntime` is the engine the host runs its flows on, from
[`@smthrs/platform-node`](/api/platform-node) or [`@smthrs/engine`](/api/engine);
in a Node host the `Digest` and `SecureRandom` services are `NodeCrypto.layer`
from `@effect/platform-node`.

## Choose the poll interval

```ts
Scheduler.layer({ pollInterval: "30 seconds" })
```

| Option            | Default        | What it paces                                                                                                            |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pollInterval`    | `"1 minute"`   | The durable wait between the end of one tick and the start of the next.                                                  |
| `runPollInterval` | `"15 seconds"` | How often a scheduler from `Scheduler.make` asks the runner whether a launched run is still active; a tick does not ask. |
| `host`            | `"local"`      | The name every tick records its heartbeat under, and the key of the lineage, so a restarted host joins its own.          |
| `concurrency`     | `4`            | How many triggers one tick claims at the same time.                                                                      |
| `startTimeout`    | `"4 minutes"`  | How long one `Runner.start` may take before the launch is abandoned and left pending.                                    |
| `inspectTimeout`  | `"30 seconds"` | How long one `Runner.inspect` may take before it counts as a failed inspection.                                          |
| `cancelTimeout`   | `"30 seconds"` | How long one `Runner.cancel` may take before the supersede fails and is compensated.                                     |
| `staleAfter`      | `"5 minutes"`  | How old a boundary may be and still fire under `catchUp: "none"`. `Scheduler.layer` adds `pollInterval` to the default.  |

Both intervals must be finite, positive Effect durations. Zero would tick
without pause and an infinite interval never completes, and
`Duration.fromInput` accepts both, so the scheduler refuses them itself with
`invalid_options` and `TriggerError.path` naming the field. Every other option
is checked when the layer builds, so a bad `concurrency` refuses the layer
rather than failing every tick.

Set `pollInterval` below the tightest schedule you run. A one-minute cron under
a five-minute poll still fires, because catch-up replays the boundaries the poll
skipped, but only if the declaration asked for catch-up.

## Bound a slow runner

A tick processes up to `concurrency` triggers at once and never waits for one
launch before it claims the next: once the claim is durable, the launch runs on
its own fiber, so a plan parked awaiting approval holds only its own trigger.
The tick returns once every launch it started is recorded, so it waits at most
`startTimeout` for one. Every runner call also carries a deadline. A call that
exceeds it is interrupted and fails with `runner_timeout`, and the durable state
a retry needs is kept:

- A start that timed out is ambiguous, because the runtime may hold the run.
  The occurrence stays pending and the next tick retries it under the same
  `idempotencyKey`, so a runtime that did start the run answers with the same
  run id instead of a second run.
- An inspection that timed out is a failed inspection. A scheduler from
  `Scheduler.make` retries it like any inspection failure and detaches its
  monitor after three retries with the owner retained; a tick asks again next
  time.
- A cancellation that timed out restores the prior run as active and queues the
  replacement.

Keep `startTimeout` above the two minutes `parkedAttempts` allows when
scheduled flows can park for approval.

## Let the control plane read the store

`Control.list` answers `{ _tag: "triggers" }` and `{ _tag: "fires" }` through
the `DispatchReader` port declared in `@smthrs/control`. This package serves
that port from the store. Provide it beside the scheduler, over the same store:

```ts
import * as DispatchReader from "@smthrs/triggers/DispatchReader"

export const dispatchReader = DispatchReader.layer.pipe(
  Layer.provide(SqlTriggerStore.layer),
  Layer.provide(database)
)
```

Each trigger summary carries its last fire, its buffered occurrence, the run it
holds, the next five occurrences, and `schedulerLastTickMs` from the newest
heartbeat. A summary with no `schedulerLastTickMs` means no scheduler has ever
polled this store, so an enabled trigger is not going to fire. Without the
layer, `Control.list` refuses both variants with `InvalidInput` naming the
missing store; it never answers an empty page it cannot stand behind.

## Tick from a loop you own

`Scheduler.make` returns the same service without registering anything on an
engine, so the caller decides when a tick happens. Use it in tests or under a
loop you already own, and keep its scope open across ticks: the service holds
each trigger's watermark and its launch fibers in memory.

```ts
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as Effect from "effect/Effect"

const oneTick = Effect.scoped(Effect.gen(function*() {
  const scheduler = yield* Scheduler.make()
  yield* scheduler.runOnce
}))
```

`runOnce` holds a semaphore permit, so two concurrent calls on one scheduler
serialize rather than interleave.

## Tick from a host with no process

A durable flow step, a queue consumer and a scheduled function keep nothing in
memory between ticks. A scheduler built for each tick would see every trigger
for the first time, which owes a trigger that never fired nothing, and closing
its scope would cut its launches off. `Scheduler.tick` is one whole tick for
such a host. It takes the watermark the previous tick answered and returns
only once its launches are recorded:

```ts
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as Effect from "effect/Effect"

/** One round of a durable loop: tick, then keep `watermark` for the next round. */
export const round = (since: number | undefined) =>
  Effect.map(Scheduler.tick({ since, host: "edge" }), (ticked) => ticked.watermark)
```

Store the watermark durably, for example in the payload of the flow's next
round, and pass it back as `since`. A first tick passes none. The next tick
settles the runs this one launched, so run a tick at least as often as the
tightest schedule, and keep `startTimeout` below the time one step may take.
`Scheduler.layer` is this loop written as a flow, `Scheduler.Tick`, for a host
that has an engine of its own.

`Scheduler.makeNoop` and `Scheduler.layerNoop` provide an inert scheduler that
registers nothing and ticks nothing, for a composition that needs the service
in scope but no scheduling.

## What a parked plan does

`layerControlRunner` calls `control.plan`, then runs the returned plan. When
Control answers `Parked`, the plan is waiting for a human approval. The runner
re-offers the same idempotent request with a delay that doubles from one
second, up to `Scheduler.parkedAttempts`, which is 8. The eighth attempt lands a
little over two minutes in, and the launch then fails with `runner`.

The runner never approves the plan and never reconstructs an execution
envelope. A schedule that keeps parking is a schedule whose flow needs an
approval nobody is giving.

## Shutdown does not cancel runs

Closing the scheduler's scope drops the tick step's registration and detaches
from the lineage. The round parked on its timer is the engine's, and the next
host to build the layer under the same `host` name joins it; on a durable
engine that is also what a restart does. It stops there on purpose: the runs
themselves are durable and outlive the process, so a deploy must leave them
alone. The next tick re-attaches to them by reading the store.

Cancellation is a deliberate act, and the only thing that performs it is a
`supersede` claim replacing a run in flight.

## Failure isolation

A tick walks the due triggers in id order. One trigger's failure is logged with
its id annotated and does not stop the triggers after it, and a failed
occurrence stays available to a later poll rather than being marked handled.
A tick that fails as a whole, by its typed error or by a defect raised anywhere
under it, is logged with its cause, and the lineage sleeps and ticks again with
the watermark it had. Interruption is the exception: it is the scope closing,
not a trigger failing, so it propagates.

## Next

- [The claim protocol](../concepts/claim-protocol.md): what happens when two
  hosts run this same loop.
- [Troubleshooting](../troubleshooting.md): the failures a tick reports.
