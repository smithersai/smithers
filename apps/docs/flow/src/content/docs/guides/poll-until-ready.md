---
title: "Poll until something is ready"
description: "Declare a durable poller whose attempts are rounds and whose waits are durable timers, choose its backoff and bound, and put a time limit on a check that can hang."
sidebar:
  order: 7
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/guides/poll-until-ready.md"
---

`Poll.make` declares an ordinary flow whose body is **one attempt**: run the
check, and either settle the lineage with the check's own output or sleep for
this attempt's delay and hand off to the next round with the attempt counter
raised.

That shape is what makes a poll durable. Each attempt is a round with its own
keyed plan nodes, a check that already ran replays from its recorded outcome, and
the wait between attempts is a durable timer that survives a process restart.

## Declare the poll

```ts
import { Action, Interpreter, Poll, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Status = Action.make("deploy/Status", {
  payload: { id: Schema.String, attempt: Schema.Number },
  success: Poll.CheckResult(Schema.String)
})

export const Deployment = Poll.make("deploy/Wait", {
  input: { id: Schema.String },
  result: Schema.String,
  intervalMs: 5_000,
  backoff: "exponential",
  maxAttempts: 8,
  onTimeout: "fail",
  check: Node.capture(
    { action: Status.name, implementationVersion: "deploy/status-check/v1" },
    ({ attempt, id }) => Status.call({ attempt, id })
  )
})

export const layer = Interpreter.layerWithImplementations(
  Deployment,
  Layer.mergeAll(
    Status.toLayer(({ attempt, id }) =>
      Effect.map(readDeployment(id), (live) => ({
        satisfied: live,
        output: `attempt-${attempt}`
      }))
    ),
    Poll.layer,
    Sleep.layer
  )
)
```

`check` must be capture-stable under the default policy of
`Interpreter.layerWithImplementations`. Use `Node.capture` with every semantic
capture and a version for imported behavior. Capture any mappers, predicates,
or planned continuations inside the check as well. JavaScript cannot verify
closure completeness. `Poll.make` captures its generated body and predicate
using the schedule and `Node.functionIdentity(check)`. An uncaptured check keeps
the poll process-local and stable admission refuses it. Explicit
`callbackIdentity: "process-local"` allows experimentation without a
cross-process callback identity guarantee.

`Sleep.layer` is not optional. The wait between attempts is an ordinary
`system/sleep` node, so a composition without it has a plan node no
implementation answers. `Poll.layer` implements the `system/poll-exhausted` step
the last unsatisfied attempt takes.

## The options

| Option        | Meaning                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`       | Your payload fields. `attempt` is added to them and defaults to one.                                                                              |
| `result`      | The schema the poll settles with.                                                                                                                 |
| `check`       | A body fragment returning `{ satisfied, output }`. It may not fail: state what a failure means with `Node.catch` inside the fragment.             |
| `intervalMs`  | The base wait before the next attempt.                                                                                                            |
| `backoff`     | `fixed`, `linear` (interval multiplied by attempt), or `exponential` (interval multiplied by 2 raised to attempt minus one). Defaults to `fixed`. |
| `maxAttempts` | The attempt bound. It is also the flow's `maxRounds`, so a lineage that opened another round is refused by the engine.                            |
| `onTimeout`   | `fail` fails `PollExhausted` at the bound; `return-last` answers with the last check output. Defaults to `fail`.                                  |

`Poll.CheckResult(schema)` is the success schema a check action declares, and
`Poll.delayMillis` is the exported schedule function if you want to compute the
same delays yourself.

## What a bad schedule earns

`Poll.make` refuses a schedule no clock can keep, at declaration time, naming the
option that is wrong:

- A `TypeError` when `input` declares the reserved `attempt` field. `Poll` owns
  that counter across rounds.
- A `RangeError` when `intervalMs` is not a finite number of milliseconds that is
  not negative, because that interval becomes a `system/sleep` node whose timer
  never fires.
- A `RangeError` when `maxAttempts` is not a whole number of attempts of at least
  one. A poll checks at least once.
- A `RangeError` when the interval under the declared backoff reaches a wait no
  clock can be armed with before the budget is spent.

That last check is on the whole schedule rather than on the interval alone,
because the backoff multiplies the interval:
`{ intervalMs: 1000, maxAttempts: 2000, backoff: "exponential" }` states three
finite options and still asks for a wait of `Infinity`. The check looks at the
last wait a poll can arm, the one before the final attempt, since the attempt at
the budget gives up rather than sleeps.

## Handle exhaustion

Under `onTimeout: "fail"` a spent budget fails `Poll.PollExhausted`, carrying the
poll name and the attempt count under the stable code `poll_exhausted`. A body
catches it like any other declared failure.

`Poll.Failure` is the union a poll's rounds can fail with, and it includes
`Sleep.SleepRequestInvalid` as well: the wait between attempts is an ordinary
sleep node, and a round payload can carry an attempt that derives an invalid
wait.

## Bound a check that can hang

There is deliberately no per-attempt time limit option. A plan node's duration is
not something the body around it can bound, so the bound goes in the check's own
implementation, where a durable race puts it on the recorded step:

```ts
import { DurableClock, DurableDeferred } from "@smthrs/flow"
import * as Duration from "effect/Duration"

const statusLayer = Status.toLayer(({ attempt, id }) =>
  DurableDeferred.raceAll({
    name: `deploy/status#${attempt}`,
    success: Poll.CheckResult(Schema.String),
    error: Schema.Never,
    effects: [
      readDeploymentStatus(id),
      Effect.as(
        DurableClock.sleep({
          name: `deploy/status#${attempt}`,
          duration: Duration.seconds(30),
          inMemoryThreshold: Duration.zero
        }),
        { satisfied: false, output: "unknown" }
      )
    ]
  })
)
```

Three things make that the durable bound rather than a wall-clock one:

1. The race records its winner under a name carrying the attempt, so a re-driven
   round reads the recorded outcome instead of racing again.
2. The clock parks the execution rather than holding a fiber, so the bound
   outlives the process waiting on it.
3. The clock's branch answers `satisfied: false`, so a check that ran out of time
   costs the poll one attempt and nothing else. The round takes its declared
   interval and hands off exactly as an unsatisfied check does.

## Related pages

- [Trampoline rounds](/concepts/trampoline-rounds/): the lineage machinery a
  poll is built out of.
- [Wait for a deadline](/guides/wait-for-a-deadline/): the timer the interval arms.
