---
title: "Wait for a deadline"
description: "Park a round on a durable timer with Sleep.action, sleep inside an implementation with DurableClock, and read the refusals an unarmable deadline earns."
sidebar:
  order: 4
---

There are two ways to wait for time to pass, and which one you reach for depends
on where you are standing.

- In a **body**, call `Sleep.action`. The wait becomes a keyed plan node: visible
  in the graph, skippable by a branch, and replayed like any other step.
- In an **implementation**, call `DurableClock.sleep`. A body cannot see it, but
  a handler can reach it.

Both park the execution rather than holding a fiber, so the wait outlives the
process.

## Wait inside a body

```ts
import { Action, Flow, Interpreter, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Notify = Action.make("release/Notify", {
  payload: { build: Schema.String },
  success: Schema.String
})

export const Cooldown = Flow.make("release/Cooldown", {
  payload: { build: Schema.String },
  success: Schema.String,
  error: Sleep.SleepRequestInvalid,
  body: ({ build }) =>
    Sleep.action.call({ millis: 60_000 }).pipe(
      Node.andThen(Notify.call({ build }))
    )
})

export const layer = Layer.mergeAll(
  Sleep.layer,
  Notify.toLayer(({ build }) => notifyRelease(build)),
  Interpreter.layer(Cooldown)
).pipe(Layer.provideMerge(Action.layerImplementations))
```

`Sleep.layer` is not optional. `Sleep.action` is declared with
`Action.makeSystem`, so it pushes no compile-time obligation onto callers, but a
composition without the layer has a plan node no implementation answers.

The implementation arms a durable clock, declares its park as `timer` with the
deadline as `wakeAt`, and awaits the clock's deferred. Once the clock has fired,
its result is persisted, so a re-driven round reads it and runs straight through
instead of parking a second time.

## Name exactly one deadline

A payload carries a relative `millis` or an absolute `until` in epoch
milliseconds, and exactly one of them. `Sleep.SleepRequestInvalid` is the typed
refusal, so a body can recover from it with `Node.catch` like any other declared
failure:

| Code                 | What was wrong                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_deadline`   | The payload named neither `millis` nor `until`.                                                                                                                                                       |
| `ambiguous_deadline` | It named both, which are the same fact stated twice.                                                                                                                                                  |
| `invalid_deadline`   | It named a number that is not a length of time: a non-finite or negative `millis`, a non-finite `until`, an addition that overflows, or a deadline after epoch millisecond `Number.MAX_SAFE_INTEGER`. |

A literal `NaN` or infinity has no canonical JSON representation. A runtime
that records plans refuses it before dispatch with `InterpreterError` code
`uncanonical_payload` and the offending node's id. `Node.catch` does not catch
interpreter refusals. Without plan recording, the sleep action reports the
declared `SleepRequestInvalid` instead.

Two behaviors are worth knowing before you write the body:

- **Two waits of the same length are two waits.** Each call is its own node with
  its own identity, so a sleep followed by a sleep waits twice.
- **A deadline that has already passed settles the node instead of parking it.**
  A run that resumes after its own deadline has to make progress.

## Wait inside an implementation

`DurableClock.sleep` is the handler-side wait:

```ts
import { DurableClock } from "@smthrs/flow"

const wait = DurableClock.sleep({
  name: "cooldown",
  duration: "2 days",
  inMemoryThreshold: "30 seconds"
})
```

The threshold decides the mechanism. A duration at or below
`inMemoryThreshold`, 60 seconds by default, runs as an in-memory sealed action.
A longer one schedules a durable clock and suspends the execution. A zero
duration returns immediately. Both the duration and the threshold must be finite
and not negative.

`DurableClock.make({ name, duration })` builds the clock value on its own, which
is what you want when you need the clock's deferred rather than the wait, for
example to race it against real work.

## Bound work with a clock

Racing a durable clock against the work is how you put a durable time limit on
something that can hang. The race records its winner, so a re-driven round reads
the recorded outcome instead of racing again:

```ts
import { DurableDeferred } from "@smthrs/flow"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"

const bounded = DurableDeferred.raceAll({
  name: "deploy/status",
  success: Schema.String,
  error: Schema.Never,
  effects: [
    readDeployment("web"),
    Effect.as(
      DurableClock.sleep({
        name: "deploy/status",
        duration: Duration.seconds(30),
        inMemoryThreshold: Duration.zero
      }),
      "unknown"
    )
  ]
})
```

`inMemoryThreshold: Duration.zero` forces the durable path, so the bound outlives
the process waiting on it rather than living in a fiber.

## Related pages

- [Wait for an external signal](./wait-for-an-external-signal.md): the other
  system wait, and the tokens that resolve it.
- [Poll until something is ready](./poll-until-ready.md): a timer and a check,
  packaged as a lineage of rounds.
- [Suspension and replay](../concepts/suspension-and-replay.md): what parking
  does to the run.
