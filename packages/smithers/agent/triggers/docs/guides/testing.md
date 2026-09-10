---
title: "Test trigger code"
description: "Test schedules and triggers deterministically: the in-memory store, the recording runner, a test clock instead of wall time, and the noop store that proves a composition reaches nothing."
sidebar:
  order: 5
---

Nothing in this package reads wall time or reaches a network directly. Time is
the Effect `Clock`, launching is the `Runner` port, and persistence is the
`TriggerStore` contract. A test replaces those three and runs the production
logic.

## Swap the store for the in-memory one

`TestTriggers.layer` is a `TriggerStore` with real claim and overlap semantics
and no database:

```ts
import * as TestTriggers from "@smthrs/triggers/test/TestTriggers"
import * as Layer from "effect/Layer"

const store = TestTriggers.layer
```

It is not a kinder set of rules. Both stores apply one shared claim decision, so
they return the same refusal codes in the same order, hold the same 5-minute
reservation lease from `TriggerStore.reservationLeaseMs`, reclaim an expired
reservation the same way, and follow the same watermark rules. Registration
validates the declaration and serializes its input at the call boundary in both,
`list` and `listEnabled` order by id in both, and every reading is an
independent value that cannot be mutated back into stored state.

Two things it cannot stand in for. It holds one process's state behind a `Ref`,
so it never reports a `store` failure from a write and never shows contention
between connections. It applies no migrations and keeps no rows, so a test about
a schema or a column shape has nothing to read.

Use `SqlTriggerStore.layer` over an in-memory SQLite database when the thing
under test is a SQL behavior, such as migration application or a row shape.

## Record launches instead of performing them

`Scheduler.layerNoopRunner` answers `isActive` with `false` and `cancel` with
nothing, so launched work settles immediately. Override only what the test
needs to observe:

```ts
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as Effect from "effect/Effect"

const launched: Array<Scheduler.StartInput> = []

const runner = Scheduler.layerNoopRunner({
  start: (input) =>
    Effect.sync(() => {
      launched.push(input)
      return input.idempotencyKey
    })
})
```

Assert on `idempotencyKey`. It is `<triggerId>:<occurrence ISO instant>`, so it
pins which boundary fired, not merely that something fired.

To exercise a run that stays alive, keep a set of active run ids and answer
`isActive` from it. To exercise supersede, record what `cancel` was called with.

## Move the clock instead of waiting

```ts
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as Effect from "effect/Effect"
import { TestClock } from "effect/testing"

const program = Effect.scoped(Effect.gen(function*() {
  const scheduler = yield* Scheduler.make()
  yield* TestClock.setTime(Date.parse("2026-03-01T03:00:00.000Z"))
  yield* scheduler.runOnce
  yield* TestClock.setTime(Date.parse("2026-03-02T03:00:00.000Z"))
  yield* scheduler.runOnce
  yield* Effect.yieldNow
}))
```

Build the scheduler with `Scheduler.make` rather than `Scheduler.layer`, so no
supervisor fiber competes with the test for ticks, and the test decides when
each tick happens.

Two habits keep such a test honest:

- Yield after a tick that launches. The launch monitor runs in a forked fiber,
  so the terminal result is recorded after `runOnce` returns.
- Remember that the first tick a process performs on a trigger establishes a
  watermark and fires nothing. A test that expects a launch needs a second tick,
  or a trigger seeded with a `lastFiredAt` through a recorded result.

## Observe what the store recorded

Wrap the store layer to capture `recordResult` calls, which is where every
scheduler decision lands:

```ts
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const recording = (results: Array<TriggerStore.Result>) =>
  Layer.effect(
    TriggerStore.TriggerStore,
    Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      return TriggerStore.TriggerStore.of({
        ...store,
        recordResult: (result) =>
          Effect.sync(() => {
            results.push(result)
          }).pipe(Effect.andThen(store.recordResult(result)))
      })
    })
  ).pipe(Layer.provide(TestTriggers.layer))
```

The outcomes tell the policies apart: `skipped`, `buffered`, and `superseded`
are the three overlap decisions, and `launched` followed by `completed` is a run
that went all the way.

## Prove a composition reaches nothing

`TriggerStore.layerNoop` fails every method with `store` and a message naming
the method. Use it when a composition needs the service in its type but must
never touch it, and override the one method a test expects to be reached:

```ts
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import * as Effect from "effect/Effect"

const absent = TriggerStore.layerNoop({ listEnabled: () => Effect.succeed([]) })
```

`Scheduler.layerNoop` is the matching inert scheduler, and
`Scheduler.makeNoopRunner` the matching inert launcher.

## Test the pure parts directly

`Overlap.decide`, `Overlap.pendingAfter`, and `CatchUp.occurrences` are pure
functions over explicit state. A policy question is answerable without a store,
a clock, or a scheduler at all, and that is the cheapest place to pin a policy
expectation:

```ts
import * as Overlap from "@smthrs/triggers/Overlap"

Overlap.decide("supersede", { running: true, due: 7_200_000 }) // "supersede"
```
