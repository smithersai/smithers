---
title: "Implement the Encoded seam for a store"
description: "Write a FlowEngine.Encoded implementation and adapt it with makeUnsafe: which members carry encoded values, which ones you decode yourself, what each optional member buys, and how to expose the result as a layer."
---

A store implements `FlowEngine.Encoded`. It never implements the typed
`FlowRuntime` port directly, because `makeUnsafe` owns step identity, the retry
decision, trampoline rounds, and the suspended-resume loop, and a store that
reimplemented them would diverge from every other store.

Two implementations already exist, and both are worth reading beside this
guide: `FlowEngine.layerMemory` in this package, and `EngineStore` in
[`@smthrs/engine-store`](/api/engine-store).

## The shape

Build the encoded implementation, adapt it, and publish the adapter as a layer:

```ts
import { FlowEngine } from "@smthrs/engine"
import { FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

declare const encoded: FlowEngine.Encoded

export const layerStore: Layer.Layer<FlowRuntime.FlowRuntime> = Layer.effect(
  FlowRuntime.FlowRuntime
)(Effect.sync(() => FlowEngine.makeUnsafe(encoded)))
```

`makeUnsafe` is unsafe in the sense that it trusts you: it assumes the
implementation persists, resumes, and encodes flow state correctly, and it
cannot check that for you.

## Decode `execute` and `poll` yourself

The seam's name applies to only some of its members. `execute` and `poll`
return DECODED `Flow.Result` values, and `makeUnsafe` passes them straight
through. Returning an encoded value from either one produces a silently wrong
system, because the seam types those returns as `Flow.Result<unknown, unknown>`
and nothing decodes them on the way out.

Decode through the flow's own schemas:

```ts
import { Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"

declare const flow: Flow.Any
declare const stored: unknown

const decoded = Schema.decodeUnknownEffect(
  Schema.toCodecJson(
    Flow.Result({ success: flow.successSchema, error: flow.errorSchema })
  )
)(stored)
```

The other direction is handled for you: `actionExecute` and `deferredResult`
return encoded values that `makeUnsafe` decodes, and `deferredDone` and
`deferredDoneIfWaiting` receive exits that `makeUnsafe` has already encoded.
[The port and the seam](../concepts/port-and-seam.md) has the full member
table.

## Match the required behaviors

Four behaviors are contract, not convention. A store that gets one of them
wrong still compiles, so treat them as the acceptance criteria for your
implementation:

- A repeated `executionId` joins the run that already owns it. A reuse that
  names a different flow declaration, or that arrives with a different payload,
  is refused with `ExecutionIdentityConflict`.
- `poll` answers `Option.none()` for a known unsettled execution AND for an
  execution belonging to a different flow declaration. Only an execution id no
  engine knows fails, with `FlowRuntime.FlowExecutionNotFound`.
- `interrupt`, `interruptUnsafe`, and `resume` treat an unknown execution id as
  a silent no-op.
- Registrations of one flow tag stack. The last still-open registration serves,
  and closing an inner one restores the outer one, which is what
  `makeUnsafe`'s own declaration table does for handoff targets.

`register` receives the execute function the interpreter built. Call it to
drive a round, and provide the `FlowRuntime.FlowInstance` the run needs;
`FlowEngine.makeInstance(flow, executionId)` builds one.

## Implement the optional members deliberately

Each optional member adds a guarantee; volatile implementations can also supply
the wake and conditional-completion hooks:

| Member                  | Implement it when                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `actionRetryOrigin`     | You persist attempt rows with start times. Returning the earliest surviving attempt's start makes `RetryPolicy.expirationMs` a real schedule-to-close bound across restarts. Return `Option.none()` when every row for the key is gone; the engine restarts the budget and logs a warning. |
| `actionLatestAttempt`   | You persist attempt numbers. Returning the highest one keeps a resumed run from re-sleeping the backoff ladder from attempt 1.                                                                                                                                                             |
| `resumeSignal`          | You can observe an in-process wake. The engine races it against the suspension backoff sleep, so a completed deferred continues a waiting caller at once.                                                                                                                                  |
| `deferredDoneIfWaiting` | You track what a parked run is waiting for. Complete the deferred only when the run's waiting reason and token match, and answer `Existing`, `Completed`, or `NotWaiting`.                                                                                                                 |
| `actionSnapshot`        | You persist the earliest snapshot handle for each compensable key. Evaluate and persist `ActionExecuteOptions.snapshot` only for actual execution, after journal lookup and before the action runs. See [compensable actions](./compensable-actions.md).                                   |
| `recordNode`            | You retain interpreter topology and settlements. Address records by the supplied `sourceId` so replay does not duplicate them.                                                                                                                                                             |
| `nodeRecordBytes`       | You measure the complete encoded journal envelope for deterministic topology pagination.                                                                                                                                                                                                   |

Omitting any of them is a supported composition. The engine falls back and logs
where the fallback is observable.

## Verify against the contract

Run your store through [`@smthrs/testing`](/api/testing). Its engine subject
drives identity, replay, race, and interruption against a real engine rather
than a model. The in-memory engine and a durable driver are held to the same
scenarios that way, an engine restart included.

## Related

- [The port and the seam](../concepts/port-and-seam.md) for the design behind
  the split.
- [The API reference](../api.md) for the full `Encoded` signature.
