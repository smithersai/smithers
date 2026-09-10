---
title: "Test flows on the in-memory engine"
description: "Use FlowEngine.layerMemory as the engine under test: the layer stack, the crypto and clock services a test provides, how to prove a replay by counting, and what the memory engine does not simulate."
---

`FlowEngine.layerMemory` is not a mock. It is a real implementation of the same
seam the durable engine implements, so a test that runs against it exercises
the production identity, retry, and suspension decisions. Test with it, and
what you are testing is the engine.

## The layer stack under test

The composition is the production one with the store swapped:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Send = Action.make("mail/Send", {
  payload: { to: Schema.String },
  success: Schema.String
})

const Notify = Flow.make("mail/Notify", {
  payload: { to: Schema.String },
  success: Schema.String,
  body: (payload) => Send.call(payload)
})

const testLayer = (send: (to: string) => Effect.Effect<string>) =>
  Layer.mergeAll(
    Send.toLayer(({ to }) => send(to)),
    Interpreter.layer(Notify)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
```

Two services are easy to forget:

- `Crypto.Crypto`. Every action dispatch is recorded under a derived step
  identity, and deriving it is a SHA-256, so the memory engine needs crypto
  too. In Node, provide `NodeCrypto.layer`.
- The clock, when the flow retries or parks. Retry delays and the suspended
  resume loop sleep on the injected clock, so a test that provides Effect's
  `TestClock` sees the schedule it declared instead of a wall-clock wait.

## Prove a replay by counting

The engine's guarantees are about what does NOT run a second time, so the
assertion is a counter, not a value:

```ts
const proveReplay = Effect.gen(function*() {
  let calls = 0
  const layer = testLayer((to) =>
    Effect.sync(() => {
      calls = calls + 1
      return `sent:${to}`
    })
  )
  const run = Effect.gen(function*() {
    yield* Notify.execute({ to: "ada" }, { executionId: "notify-ada" })
    yield* Notify.execute({ to: "ada" }, { executionId: "notify-ada" })
    return calls
  })
  return yield* run.pipe(Effect.orDie, Effect.provide(layer))
})
```

`proveReplay` answers 1. A value assertion would have answered `"sent:ada"`
twice and proved nothing.

The same shape covers the other guarantees: count dispatches across a park and
a resume to show a settled action is not re-run, and count them across two
`Action.retry` attempts to show the ordinal was pinned rather than
reallocated.

Only settled action results are cached. An interrupted dispatch leaves no
cached result, so a later dispatch executes the action again, including after
a deferred wake or in another run sharing the same cache key. In-flight
joiners receive the interrupted dispatch's exit.

## Drive a park deterministically

A flow parks when it awaits a `DurableDeferred`. In a test, that gives you a
run you control: execute the flow in a forked fiber, assert it parked, complete
the deferred, and assert it finished. The memory engine's `deferredDone`
re-drives the parked execution as part of completing it, so nothing has to be
polled.

## What the memory engine does not give you

Its limits are the honest boundary of what an in-memory test can prove:

- Nothing survives the layer scope. State is dropped when the scope closes, so
  a test cannot restart a process with it.
- There is no eviction. Completed executions, action settlements, deferred
  results, and clocks are retained for the life of the layer, which is fine for
  a test and wrong for a long-lived process.
- Two optional seam members are absent: `actionRetryOrigin` and
  `actionLatestAttempt`. There is no durable retry origin and no persisted
  attempt counter, so the schedule-to-close budget and the attempt number are
  in-process. A test that must prove those survive a restart needs the
  durable engine from [`@smthrs/engine-store`](/api/engine-store). The other
  two optional members are implemented in memory: `deferredDoneIfWaiting`
  completes a deferred only while the round that annotated the wait is
  parked, so conditional completion on a reason and token can be tested
  here, and `resumeSignal` wakes a caller parked on the suspension backoff
  within a scheduler turn of a completion, a clock firing, a resume, or an
  interrupt, so a test never waits out a backoff rung.

Everything else, identity, admission conflicts, the retry decision, the
keyless-dispatch guard, and trampoline rounds, behaves as it does in
production.

## Related

- [Suspension and cancellation](../concepts/suspension.md) for what a parked
  run is waiting on.
- [Step identity](../concepts/step-identity.md) for why a counter that reads 1
  is the right assertion.
