---
title: "Test a model-backed step"
description: "Test flows that contain agent steps deterministically: a scripted model behind SeatResolver, the in-memory engine, and the noop seams the package ships."
sidebar:
  order: 10
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/guides/testing.md"
---

A model-backed step is deterministic to test because every nondeterministic
input is a service: the model behind `SeatResolver`, the clock inside the
retry schedules, the journal a composition may or may not keep. The test swaps
the services, not the step. The [Quickstart](/quickstart/) builds the
pattern once; this guide is the habit as a checklist.

## Script the model behind SeatResolver

`SeatResolver` is the credentialed seam, so it is the one place a test
replaces. A scripted `Model` emits one fenced `cell` block whose `ctx.done(...)`
carries the answer the declared schema decodes:

```ts
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Effect from "effect/Effect"

const seats = SeatResolver.layer({
  resolve: (id) =>
    Effect.succeed(
      Seat.make({ id, modelId: "test-model", model: scripted, route: recordedRoute, contextWindowTokens: 200_000 })
    )
})
```

Point the resolver at a provider route and nothing above it changes: that is
the whole design of the seat seam. The full scripted model, including the
`ModelEvent` constructors, is in the [Quickstart](/quickstart/#script-the-model-and-the-seat).

## Run a real engine in memory

`FlowEngine.layerMemory` from [`@smthrs/engine`](https://engine.smithers.sh/reference/api/) is the reference
in-memory engine: the same durable semantics, no file. The composition is the
production one with the scripted seam substituted: `Agent.layer`,
`Agent.layerDefaults`, the action's own `.layer`, `Interpreter.layer(flow)`,
`Action.layerImplementations`, and a crypto service. The complete layer stack
is in [Add a model-backed step to a flow](/guides/model-backed-steps/#compose-the-host-and-the-policies).

Two time details matter in a test:

- The transport retry ladder sleeps on the injected clock and draws its jitter
  from the injected `Random`, so a test that supplies both sees the schedule it
  declared and never a wall-clock wait.
- The quota classifier is pure: `classify(error, nowMillis)` takes the instant
  as an argument, so a test states it outright.

## Assert on the durable evidence

The policies leave a trail a test can read:

- A settled correction ladder replays whole and pays the provider nothing:
  count the scripted model's calls to prove the refusal was never re-issued.
- Each rejection writes a `flows.agent.structured-output-rejected.v1` record on
  the journal's lossy channel, when the composition has a journal. A
  composition without one writes nothing and behaves the same otherwise, so a
  test may omit the journal entirely.
- `Budget.usageOf(runId)` reads one run's `{ tokens, calls, largestCall }` from
  its live accumulator or its durable records.

[`examples/src/39-agent-policies.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/39-agent-policies.ts)
pins exactly these counters across an engine restart: three provider calls in
all, one park decision, one structured-output rejection.

## The noop seams

Every optional service ships an explicit absence, so a test provides the
smallest composition that type-checks:

| Service                         | Explicit absence                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `Agent`                         | `Agent.makeNoop()`, `Agent.layerNoop()`                                           |
| `SeatResolver`                  | `SeatResolver.layerNoop()`: fails every resolve with `SeatUnresolved`.            |
| `QuotaPolicy`                   | `QuotaPolicy.layerUnclassified()`: every refusal stays a failure.                 |
| `Budget`                        | `Budget.layerUnbounded()`: accounts nothing, refuses nothing.                     |
| `EventSink`                     | `EventSink.layerNoop()`: drops every event.                                       |
| `ChildFlows.Children`           | `ChildFlows.makeNoop()`: refuses every operation catchably.                       |
| `FlowStore`                     | `FlowStore.layerNoop()` or `FlowStore.layerMemory()`.                             |
| `WorkspaceObservation.Observer` | provide none (unobserved) or `WorkspaceObservation.layerNoop` (fails on purpose). |
| `EngineLike`                    | `EngineLike.layerNoop()` from [`@smthrs/harness`](https://harness.smithers.sh/reference/api/).                  |

## What not to stub

Do not stub `AgentAction` itself: its layer is the production implementation,
and the policies only exist underneath it. Stub the model, and the correction
ladder, the quota parks, and the budget accounting all run for real, which is
what the test is for.
