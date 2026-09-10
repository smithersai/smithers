---
title: "Drive the cell loop"
description: "How to run the cell-first controller: build CellTurn state, teach the context window, implement the EngineLike port, and consume the AgentEvent stream."
sidebar:
  order: 3
---

`CellTurn` is the deterministic outer loop of the agent. It seals a model
step, recovers the cell from the settlement, runs it in the sandbox, resolves
each of its flow calls as its own keyed durable boundary, then applies the
transition the cell settled. It decides continue, park, or finish from durable
evidence, never from the presence of a provider tool call.

The production composition of everything on this page lives in
[`@smthrs/agent`](/api/agent). Follow this guide when you are composing a
custom host or implementing the engine port yourself.

## Build the initial state

`CellTurn.make` constructs the serializable controller state:

```ts
import * as CellTurn from "@smthrs/harness/CellTurn"
import { Option } from "effect"

const state = CellTurn.make({
  session: "session-1",
  seat: "anthropic:claude-sonnet-4-5",
  modelParams,
  layers: ["layer-a"],
  capabilityEnvelope,
  placement: Option.none(),
  contextWindow: window
})
```

The required declarations are:

- `session`: the durable session the frames belong to. It is folded into every
  call identity, so a resumed run replays under the same name.
- `seat`: the model this run speaks to, as `provider:model`. The controller
  takes the model id from the part after the colon, and a steer may move the
  seat between frames.
- `modelParams`: the `ModelRequest.GenerationParams` of
  [`@smthrs/model`](/api/model), carried by every sealed model step.
- `layers`: the registry layer set in effect. It is key material on both the
  sealed model step and each call's identity, so a run under a different layer
  set never replays another run's records.
- `capabilityEnvelope`: the `Capability.CapabilityPattern` list of
  [`@smthrs/capability`](/api/capability) that bounds this run. A flow
  declaring a capability the envelope does not allow settles as a resolved
  `capability_refused` failure instead of dispatching.
- `placement`: where this run is placed, as `client`, `local`, `sandbox`, or
  `remote` from [`@smthrs/registry`](/api/registry), folded into the model
  step's key material. `Option.none()` declares none.
- `contextWindow`: the window the first frame renders, usually the result of
  `CellTurn.teach` below.

Everything else is a budget with a default; every budget's zero disarms it:

| Option            | Default                                 | What it bounds                                                                                                                            |
| ----------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `maxFrames`       | 100 (`CellTurn.defaultMaxFrames`)       | Frames one admitted task may spend.                                                                                                       |
| `readOnlyCap`     | 0                                       | Consecutive read-only frames before the controller intervenes; at twice the cap the run stops. A run that is only meant to read omits it. |
| `modelCallMs`     | 300,000 (`CellTurn.defaultModelCallMs`) | Wall-clock one model call may spend.                                                                                                      |
| `repeatCap`       | 4 (`CellTurn.defaultRepeatFrames`)      | Consecutive repeat-observation frames.                                                                                                    |
| `narrowingCap`    | 1 (`CellTurn.defaultNarrowingDemands`)  | Completions bounced for narrowed evidence.                                                                                                |
| `unmovedCap`      | 1 (`CellTurn.defaultUnmovedDemands`)    | Completions bounced for an unmoved tree.                                                                                                  |
| `unresolvedCap`   | 1 (`CellTurn.defaultUnresolvedDemands`) | Completions bounced for a displaced failing check.                                                                                        |
| `revalidations`   | 1 (`CellTurn.defaultRevalidations`)     | In-frame answers to an unparseable cell.                                                                                                  |
| `checkpointCap`   | 8 (`CellTurn.defaultMaxCheckpoints`)    | Trees one run may pin with `ctx.checkpoint()`.                                                                                            |
| `approvalChannel` | `false`                                 | Whether a human can answer this run; `false` refuses a `park` and answers it in-frame.                                                    |

The state is a schema class: it serializes into the journal, and a resumed run
rebuilds from it.

## Teach the context window

`CellTurn.teach(contextWindow, flows)` prepends the cell contract and the
callable-flow catalog to the window as prefix segments, so the teaching is
stable for the run and a provider's prefix cache covers it:

```ts
const taught = CellTurn.teach(window, flows)
```

`flows` is the frame's `FlowDescriptor` list, already narrowed by seat
visibility. The same list goes to `CellTurn.run`, which projects it into the
realm's `ctx.flows` catalog.

## Run the loop

`CellTurn.run` takes the state and the flows, and returns a stream of
`AgentEvent`s:

```ts
import { Stream } from "effect"

const program = CellTurn.run({ state, flows }).pipe(
  Stream.runForEach((event) => Effect.sync(() => record(event))),
  Effect.provide(engineLayer),
  Effect.provide(QuickJSSandbox.layer),
  Effect.provide(Steering.layerNoop())
)
```

The stream requires three services:

- `EngineLike.EngineLike`: the durable engine port, covered next.
- `Sandbox.Sandbox`: the script realm; provide `QuickJSSandbox.layer` or
  another binding. A binding with no `openRealm` fails the run at its open.
- `Steering.Source`: the turn-boundary notification source.
  `Steering.layerNoop()` provides an empty one; `Notifications.layer`
  adapts the durable notification queue of
  [`@smthrs/notifications`](/api/notifications) for one run lineage.

The controller also reads `CellHistory.CellHistory` optionally: provide the
service when the host offers a way to save a flow, and the controller appends
each cell as it executes it. With nothing bound, it records nothing.

Interrupting the stream is the cancellation story: fiber interruption tears
the sandbox down through scope closure and reports one abort. A durable park
arrives as an interruption carrying the suspension, not as a clean end.

## Implement EngineLike

`EngineLike` is the port a durable engine answers. `EngineLike.make` builds
the service from an implementation; `EngineLike.makeNoop(overrides)` builds a
stub whose operations fail as unavailable, with `observe` and `capture`
answering `Option.none()` instead, for tests and partial hosts. The members:

| Member     | Signature                                                                     | Contract                                                                                                                                                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sealStep` | `(step: SealedModelStep) => Stream<ModelEvent, ModelFailure \| HarnessError>` | Runs one sealed model step. The implementation resolves the route, prepares the request, and digests the credential-free prepared request with the declared key material before executing; credentials sign on after the digest and never enter it.                                                                    |
| `call`     | `(call: Cell.Call) => Effect<Cell.CallResult, HarnessError>`                  | Runs one flow call from inside a cell as a keyed, journaled activity at the tier the flow declares, keyed by `call.identity` so a settled boundary replays instead of re-running. A flow failure settles as a `failure` result; a permission requirement, an abort, or an engine failure travels in the error channel. |
| `record`   | `<A>(boundary: RecordBoundary<A>) => Effect<A, HarnessError>`                 | Journals one nondeterministic controller read under the key `(name, identity)` together, and serves the recorded value to any re-execution of the same frame. Keying on `identity` alone serves one frame's opening measurement as its closing one.                                                                    |
| `observe`  | `Effect<Option<Observation>, HarnessError>`                                   | Measures the workspace as it stands. `Option.none()` is the honest answer for a host with nothing to measure, and the controller falls back to declared writes.                                                                                                                                                        |
| `capture`  | `(request: CaptureRequest) => Effect<Option<Snapshot>, HarnessError>`         | Pins the workspace under the caller's id. `Option.none()` answers a host with no store, and the cell gets a resolved `checkpoint_unavailable`.                                                                                                                                                                         |
| `suspend`  | `(reason: SuspendReason) => Effect<never, HarnessError>`                      | Parks the current engine frame durably.                                                                                                                                                                                                                                                                                |
| `splice`   | `(batch: Plan.Batch) => Stream<Plan.SpliceEvent, HarnessError>`               | Turns a batch of child plans into running children and streams their progress back. The harness translates and never schedules.                                                                                                                                                                                        |

Two members carry the loop's determinism, so their contracts bear repeating:

- **`call` owns durability.** `Cell.CallIdentity` folds the session, frame,
  cell digest, ordinal, declaration digest, and layer set into one key.
  Re-executing a cell after a crash or a park reaches the same ordinal with
  the same declaration, so a settled boundary replays and an unsettled one
  executes. One case is bounded rather than free: a call the `callMs` ceiling
  interrupted settled nowhere, so a re-executed frame issues it to the host
  again and is then handed the recorded timeout. See
  [durability](../api.md#durability) in the API reference.
- **`record` is the controller's only read of the world.** The controller's
  state is rebuilt by re-execution, so a read that bypasses a record is a
  replay divergence and, downstream of one, a duplicate irreversible effect.

## Consume the event stream

Every decision the controller makes is an `AgentEvent`, journaled in order:
`DisciplineArmed` once at the start, then per frame `TurnOpened`,
`ModelDelta`/`ModelSettled`, `CellProduced`, `CellCallStarted` and
`CellCallSettled` per call, `CellPrinted`, `CellSettled`, and
`TransitionApplied`. Interventions journal as `ReadOnlyDemandIssued`,
`RepeatDemanded`, `NarrowedDemanded`, `UnmovedDemanded`, `UnresolvedDemanded`,
`NarrowOnlyDemanded`, `SufficiencyObserved`, and `MutationObserved`. A run
ends on `TurnClosed` with its outcome, beside `Resolved`, `Suspended`, or
`Aborted`. `AgentEvent.eventType` maps every tag to its journal event type.
The full list is in the [`AgentEvent` reference](../api.md#agentevent).

`SufficiencyObserved` pairs a remembered failure with a later passing check of
the same flow, with identical or broader inputs, after a workspace mutation.
Passing readings must be stable. A live check in a frame that also edits is
ambiguous even when the cell checks after editing; run the passing check in a
later frame to establish the ordering.

## Next steps

- For the engine port's full contract, see
  [`EngineLike`](../api.md#enginelike) in the API reference.
- For the steering queue's drain semantics, see
  [`Steering`](../api.md#steering).
- For the assembled production host, see [`@smthrs/agent`](/api/agent).

## Refresh the catalog between frames

Pass `refreshFlows` to `CellTurn.run` as an Effect returning the visible,
model-invocable descriptors. The controller records its result through
`EngineLike.record` at every frame boundary, including the first. It replaces
its previous teaching and passes the same snapshot to call admission and the
realm's `ctx.flows`. Replay uses the recorded descriptors without reading the
live registry. Omit `refreshFlows` to keep the supplied `flows` array fixed.
