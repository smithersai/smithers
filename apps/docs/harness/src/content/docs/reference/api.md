---
title: "API reference"
description: "The complete @smthrs/harness API: the cell-first controller, the sandbox and engine ports, the cell contract, flow binding, and every error union, with behavior and signatures from source."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/harness/docs/api.md"
---

`@smthrs/harness` is the built-in agent loop, expressed as pure translation
plus a small set of service ports. It holds no scheduler, no database, no
transport and no provider client: `EngineLike` is the port a durable engine
answers, `Sandbox` is the port a script realm answers, `Steering.Source` is the
port a notification queue answers, and [`@smthrs/agent`](https://agent.smithers.sh/reference/api/) is the
assembled production composition over the durable engine.

The loop is cell-first. One frame is

```text
model -> generated cell -> realm evaluation -> individually durable flow calls -> next transition
```

The model emits fenced `cell` blocks; they run as one program inside a realm
that outlives the frame; the only authority the program holds is
`ctx.call(flowName, input)`; and the program states its intent by calling
`ctx.done(output)`, `ctx.park(reason, message)`, or neither, which continues.
`Sandbox.replTransition` turns that into the transition the journal records.

## Entry points

| Import                           | What it is                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/harness`                | The root barrel: the 26 namespaces listed in the module index.                                                       |
| `@smthrs/harness/<Module>`       | Any top-level module directly, for example `@smthrs/harness/CellTurn`.                                               |
| `@smthrs/harness/QuickJSSandbox` | The QuickJS-WASM `Sandbox` binding. Not re-exported from the root, because it carries an embedded WebAssembly build. |
| `@smthrs/harness/package.json`   | The package manifest.                                                                                                |

The `./internal/*` and `./*/index` subpaths map to `null` and do not resolve.

## Module index

27 public modules, 336 documented exports. Each module's full export table is
in the [module and export inventory](/reference/); the sections below state
behavior and signatures.

| Module                       | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | What it is                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `HarnessError`               | `HarnessErrorCode`, `HarnessError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Stable failures reported at the harness translation boundary.                                            |
| `AgentEvent`                 | `DisciplineArmed`, `TurnOpened`, `ModelDelta`, `ModelRetried`, `ModelSettled`, `CellProduced`, `CellRejectedInFrame`, `CellCallStarted`, `CellCallSettled`, `CellPrinted`, `CellSettled`, `TransitionApplied`, `ReadOnlyDemandIssued`, `ReadOnlyDemanded`, `RepeatDemanded`, `NarrowedDemanded`, `UnmovedDemanded`, `UnresolvedDemanded`, `NarrowOnlyDemanded`, `SufficiencyObserved`, `VacuousVerificationObserved`, `MutationObserved`, `CheckpointMinted`, `Suspended`, `CompactionSettled`, `SteeringDrained`, `TurnClosed`, `PermissionRequired`, `Aborted`, `Resolved`, `AgentEvent`, `eventType` | Serializable events emitted by harness adapters.                                                         |
| `Plan`                       | `Child`, `Batch`, `ChildResult`, `ChildProgress`, `ChildSettled`, `SpliceEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Local structural plan nodes used at the harness-to-engine boundary.                                      |
| `EngineLike`                 | `SuspendReasonCode`, `SuspendReason`, `SealedModelStep`, `BoundaryIdentity`, `DurableSchema`, `RecordBoundary`, `Observation`, `Snapshot`, `CaptureRequest`, `EngineLike`, `make`, `layer`, `makeNoop`, `layerNoop`                                                                                                                                                                                                                                                                                                                                                                                     | Narrow engine port consumed by the built-in harness.                                                     |
| `Tokens`                     | `Count`, `Segment`, `Accounting`, `Estimator`, `estimate`, `count`, `combine`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Deterministic token accounting for context windows.                                                      |
| `ContextWindow`              | `TypeId`, `SegmentKind`, `SegmentZone`, `Content`, `ContextWindowErrorCode`, `ContextWindowError`, `Segment`, `ContextWindow`, `SegmentInput`, `MakeOptions`, `makeSegment`, `make`, `empty`, `appendTurn`, `prefixDigest`, `compactPrefix`, `compact`, `render`                                                                                                                                                                                                                                                                                                                                        | The immutable, provider-neutral context assembled for one model request.                                 |
| `Transcript`                 | `journalVersion`, `validateJournal`, `TranscriptErrorCode`, `TranscriptError`, `ProjectedMessage`, `ProjectedState`, `CellEvidence`, `projectStateResult`, `projectResult`                                                                                                                                                                                                                                                                                                                                                                                                                              | Transcript projection from durable journal entries.                                                      |
| `Compaction`                 | `summaryInstruction`, `InvalidStep`, `Summarizer`, `CompactionStep`, `TokenAccounting`, `shouldCompact`, `selectPrefix`, `declare`, `summaryRequest`, `apply`                                                                                                                                                                                                                                                                                                                                                                                                                                           | Declarations for sealed transcript-summary steps.                                                        |
| `Steering`                   | `Delivery`, `SteerInsert`, `QueueInsert`, `Insert`, `SeatChange`, `ThinkingChange`, `Item`, `Queue`, `Drain`, `BoundaryInput`, `DrainRecord`, `drainRecord`, `PromotionState`, `empty`, `enqueue`, `drainAtClose`, `promoteAtIdle`, `Source`, `SourceInput`, `make`, `makeNoop`, `layer`, `layerNoop`                                                                                                                                                                                                                                                                                                   | Turn-boundary steering values and their source contract.                                                 |
| `Notifications`              | `Options`, `make`, `layer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Adapter from the durable notification queue to harness turn boundaries.                                  |
| `Cell`                       | `Language`, `Source`, `digestOf`, `source`, `Continue`, `Complete`, `Park`, `Transition`, `renderText`, `RejectionCode`, `Settled`, `Raised`, `Rejected`, `Outcome`, `FlowProjection`, `project`, `CallFailureCode`, `defaultCallFailureCode`, `callFailureHint`, `CallIdentity`, `declarationDigest`, `Call`, `baseCheckpoint`, `checkpoint`, `checkpointOf`, `CallResult`, `CallSuccess`, `CallFailure`, `CallResultVariant`, `decodeCallResult`, `decodeOutcome`, `decodeTransition`, `callFailure`, `Extracted`, `extract`                                                                          | The cell contract.                                                                                       |
| `Sandbox`                    | `SandboxErrorCode`, `SandboxError`, `Invocation`, `Mint`, `Minter`, `mintUnavailable`, `Handler`, `Limits`, `Capabilities`, `defaultLimits`, `minimumSteps`, `minimumTimeMs`, `minimumMemoryBytes`, `printFrameBytes`, `printStatementFloor`, `printRetainedBytes`, `withDefaults`, `Intent`, `replTransition`, `RealmEvaluation`, `RealmFrame`, `Realm`, `RealmOptions`, `Sandbox`, `make`, `layer`, `makeNoop`, `layerNoop`, `realmUnsupported`, `callTimedOut`, `compile`, `PendingCall`, `driveCell`, `raisedOutcome`                                                             | The deterministic script sandbox port.                                                                   |
| `CellTurn`                   | `defaultMaxFrames`, `defaultReadOnlyFrames`, `defaultModelCallMs`, `defaultRepeatFrames`, `defaultNarrowingDemands`, `defaultUnmovedDemands`, `defaultUnresolvedDemands`, `defaultRevalidations`, `defaultMaxCheckpoints`, `State`, `Input`, `make`, `teach`, `run`                                                                                                                                                                                                                                                                                                                                     | The cell-first controller.                                                                               |
| `CellHistory`                | `ExecutedCell`, `Service`, `CellHistory`, `make`, `makeCells`, `makeNoop`, `layer`, `layerCells`, `layerNoop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The source of every cell the current turn executed.                                                      |
| `CellCalls`                  | `Implementation`, `Prompt`, `PromptRunner`, `Options`, `Resolver`, `make`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Registry-backed resolution for the flow calls a cell makes.                                              |
| `FlowBinding`                | `Declared`, `DescriptorOptions`, `descriptorOf`, `Binding`, `Options`, `make`, `provide`, `Source`, `source`, `Catalog`, `empty`, `catalogResult`, `catalog`, `registry`                                                                                                                                                                                                                                                                                                                                                                                                                                | The executable-flow binding contract.                                                                    |
| `StructuredOutput`           | `StructuredOutputFailureCode`, `OutputIssueCode`, `OutputIssue`, `StructuredOutputFailure`, `maxIssues`, `jsonSchema`, `digest`, `instructions`, `issuesDigest`, `correction`, `lastBalanced`, `candidates`, `decode`                                                                                                                                                                                                                                                                                                                                                                                   | Turning one agent's final text into a value the declared output schema accepts, or into a typed failure. |
| `TruncatedOutput`            | `flagSuffix`, `droppedSuffix`, `flagKey`, `minimumBytes`, `retained`, `Capture`, `Reuse`, `captures`, `reuse`, `refusal`, `retain`, `Ledger`                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The truncation ledger: which bytes this run was handed as a fragment.                                    |
| `CallLedger`                 | `bound`, `width`, `members`, `Entry`, `Ledger`, `subject`, `target`, `digest`, `payload`, `Settlement`, `entry`, `settled`, `remember`, `render`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The call ledger: what this run has already asked, rendered every frame.                                  |
| `NarrowedCheck`              | `retained`, `maxTerms`, `targeting`, `names`, `lex`, `terms`, `conditions`, `Check`, `Narrowing`, `check`, `narrows`, `find`, `demand`, `Only`, `findOnly`, `demandOnly`, `remember`, `Ledger`                                                                                                                                                                                                                                                                                                                                                                                                          | The narrowing ledger: which checks this run has run, and over which tree.                                |
| `CellValidation`             | `Validation`, `normalize`, `validate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Cell validation at the boundary.                                                                         |
| `UnmovedTree`                | `Unmoved`, `find`, `demand`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The completion with nothing behind it.                                                                   |
| `UnresolvedFailure`          | `exitStatusKey`, `failed`, `passed`, `Displaced`, `revisits`, `find`, `demand`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The failing check a completion stepped around.                                                           |
| `Sufficiency`                | `retained`, `Failure`, `Ledger`, `remember`, `Sufficient`, `find`, `observation`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The evidence that is already complete.                                                                   |
| `VacuousVerification`        | `retained`, `Pass`, `Ledger`, `remember`, `stored`, `find`, `observation`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The proof that was already true before anything changed. Not wired into `CellTurn`.                      |
| `VariablesPanel`             | `bound`, `Binding`, `Stamp`, `Ledger`, `stamp`, `render`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The variables panel: what the realm holds, stated every frame.                                           |
| `QuickJSSandbox` _(subpath)_ | `cacheSuccessful`, `VariantService`, `Variant`, `layerVariantLive`, `layerVariant`, `ComputeClockService`, `ComputeClock`, `layerClockLive`, `loadModule`, `makeWithVariant`, `makeWithClock`, `make`, `layerWithVariant`, `layer`                                                                                                                                                                                                                                                                                                                                                                      | The QuickJS-WASM sandbox binding.                                                                        |

## Durability

Every `ctx.call` is its own keyed, journaled, permission-gated boundary at the
tier the flow declares, so a crash or a permission park mid-cell is recoverable:
the cell source re-executes from the top, boundaries that already settled replay
their recorded values, and execution reaches the parked call deterministically.

`EngineLike.record` is the same mechanism for the controller's own reads of the
world. The controller's state is rebuilt by re-execution, so a read that
bypasses a record is a replay divergence and, downstream of one, a duplicate
irreversible effect. `(name, identity)` together form the record key: two
records in one frame may share an identity as long as their names differ.

One call is deliberately not covered by that guarantee. `EngineLike.call` is
where a cell reaches a durable wait, and a `Flow.suspend` raised inside an
enclosing activity suspends that activity's attempt rather than the run, so the
call is issued first and its settlement is recorded after. A call the `callMs`
ceiling interrupted therefore settles nowhere, and a re-executed frame issues it
again on the host. The cell's branch is stable either way, because the recorded
settlement is what the replayed frame is handed; what the run pays for twice is
the interrupted call itself.

## Limits

`Sandbox.defaultLimits` fills every ceiling a caller omits. A caller may raise
any single ceiling; the others keep their defaults, so a partial override cannot
disable them.

| Limit         | Default | Scope       | What it bounds                                                                                                                         |
| ------------- | ------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `calls`       | 64      | per frame   | Flow calls one cell may make. A `ctx.checkpoint()` mint settles on the same channel and counts.                                        |
| `memoryBytes` | 128 MiB | per **run** | What the realm's own names hold, weighed by the panel probe at each frame's close.                                                     |
| `steps`       | 1,000   | per frame   | Interrupt checks, not bytecode operations. At least `Sandbox.minimumSteps`.                                                            |
| `timeMs`      | 30,000  | per frame   | The cell's own JavaScript time. Time suspended in a `ctx.call` or `ctx.checkpoint()` does not count. At least `Sandbox.minimumTimeMs`. |
| `totalMs`     | 900,000 | per frame   | Whole-evaluation time, host calls included. The backstop for a call that never settles.                                                |
| `callMs`      | 120,000 | per call    | Wall-clock time one flow call may take before it settles as a resolved timeout.                                                        |

`memoryBytes` is a run budget rather than a frame budget because a realm outlives
its frames. `runtime.setMemoryLimit` covers the object graph but does not count
string data on the shipped QuickJS variant, so the panel probe weighs the realm's
own names and a frame that opens over the ceiling is refused before it runs. The
reading is cleared with the refusal, because freeing is itself done by a cell.

## Bytes

Text delivery and retention bounds use UTF-8 bytes measured by one shared
helper. The print channel, retention ceiling and call ledger's line sizes use
this unit, including CJK and emoji payloads. Elision notices state the real
UTF-8 byte count.

The supplemental memory probe is a separate estimate, not a UTF-8 byte count or
an exact heap measurement. Strings and property names contribute their UTF-16
code-unit lengths. Objects have a base weight of 8; non-string scalars,
functions, accessors and cycle references have fixed weights of 8. The probe walks named globals, array indices,
enumerable own string-keyed data properties, Map keys and values, and Set values.
Collection entries use the same traversal budget as properties: 200,000 values
and depth 32. An incomplete traversal causes the next frame to be refused.
Cycles stop at ancestor references; shared objects on separate paths are counted
again. Accessors are not invoked. Closure state, weak collection entries and
other storage unreachable by these paths are not measured. The native allocator
limit remains active, but this supplemental estimate is not a hard bound on all
memory retained by the realm.

## Failure categories

Three closed unions carry every failure a caller branches on. None of them is
open-ended, and none of them is prose a consumer must parse.

- `HarnessError.HarnessErrorCode`: the translation boundary's own failures.
  Folded into `@smthrs/agent`'s `AgentFailure` union, so a code that nothing
  raises is a promise this package cannot keep; the set holds only codes that
  are raised.
- `Cell.CallFailureCode`: why one flow call did not succeed, as the cell reads
  it. A failed call **resolves** with `{ ok: false, error: { code, message, hint } }`
  rather than throwing, so the recovery branch the model already wrote still
  runs. `Cell.callFailureHint` names the one move that recovers each class.
- `Sandbox.SandboxErrorCode`: why a realm could not run a cell at all, as
  distinct from a cell that ran and failed.

`StructuredOutput.StructuredOutputFailureCode` is the fourth, for the boundary
that decodes an agent's final text into a declared schema.

## Copy and mutation semantics

`ContextWindow` is immutable: the arrays a segment and a window expose are
frozen, so a runtime mutation throws rather than silently invalidating the
digest computed once at construction. `Cell` values, `CallLedger` entries and
every `AgentEvent` are schema classes and are never mutated in place. The one
value the controller mutates is its own `State`, which is journaled at each
frame boundary.

## What this package does not do

- It declares no provider tools. The cell-first loop seals every model request
  with `tools: []` and `toolChoice: "none"`. A window still carries the active
  tool set it was constructed with, and `AgentEvent.TurnOpened.activeToolNames`
  still journals it, so a foreign-adapter loop has somewhere to put one; nothing
  in this package produces a non-empty set.
- It runs no scheduler and owns no storage. `Plan` describes child batches;
  `EngineLike` splices them.

## CellTurn

Harness journal format 2 versions controller state and model-key inputs.
Resuming older controller state or an agent session journal fails before a live
model call with `HarnessError` code `incompatible_journal`; start a new run.
Historical transcript projection remains available for display and renders
summary text as a user message. rc.0 does not promise journal compatibility.

`import * as CellTurn from "@smthrs/harness/CellTurn"`

The cell-first controller. It decides continue, park, or finish from durable
evidence, the transition a cell returned and the budgets the run declared, and
never from the presence of a provider tool call.

```ts
export const run: (
  input: Input
) => Stream.Stream<
  AgentEvent.AgentEvent,
  HarnessError,
  EngineLike.EngineLike | Sandbox.Sandbox | Steering.Source
>
```

`run` executes the loop until it completes, parks, or exhausts its budget.
Cancellation is fiber interruption: interrupting the stream tears down the
sandbox through scope closure and reports one abort. `Input` is
`{ state, flows, limits? }`, where `flows` is the frame's
`FlowDescriptor` list, already narrowed by seat visibility.

`CellTurn.make` constructs the initial `State`:

```ts
export const make: (options: {
  readonly session: string
  readonly seat: string
  readonly modelParams: ModelRequest.GenerationParams
  readonly layers: ReadonlyArray<string>
  readonly capabilityEnvelope: ReadonlyArray<Capability.CapabilityPattern>
  readonly placement: Option.Option<Descriptor.Placement>
  readonly contextWindow: ContextWindow.ContextWindow
  /** Initial budget; a seat steer recomputes it from the model catalog. */
  readonly contextWindowTokens?: number | undefined
  readonly frame?: number | undefined
  /** Zero disarms the frame limit; exhausted positive limits spend no new frame. */
  readonly maxFrames?: number | undefined
  readonly readOnlyCap?: number | undefined
  readonly modelCallMs?: number | undefined
  readonly repeatCap?: number | undefined
  readonly narrowingCap?: number | undefined
  readonly unmovedCap?: number | undefined
  readonly unresolvedCap?: number | undefined
  readonly approvalChannel?: boolean | undefined
  readonly revalidations?: number | undefined
  readonly checkpointCap?: number | undefined
}) => State
```

Every omitted budget takes its module-level default, and zero disarms it:

| Constant                   | Value   | Budget it defaults                                 |
| -------------------------- | ------- | -------------------------------------------------- |
| `defaultMaxFrames`         | 100     | Frames one admitted task may spend.                |
| `defaultReadOnlyFrames`    | 12      | Consecutive read-only frames before intervention.  |
| `defaultModelCallMs`       | 300,000 | Wall-clock milliseconds one model call may spend.  |
| `defaultRepeatFrames`      | 4       | Consecutive repeat-observation frames.             |
| `defaultNarrowingDemands`  | 1       | Completions bounced for narrowed evidence.         |
| `defaultUnmovedDemands`    | 1       | Completions bounced for an unmoved tree.           |
| `defaultUnresolvedDemands` | 1       | Completions bounced for a displaced failing check. |
| `defaultRevalidations`     | 1       | In-frame answers to an unparseable cell.           |
| `defaultMaxCheckpoints`    | 8       | Trees one run may pin with `ctx.checkpoint()`.     |

`readOnlyCap` is the one budget that defaults to disarmed (0), because a run
that is only meant to read, a question or a review, has nothing to be capped
at. `approvalChannel` defaults to `false`: a park is durable waiting, and a
run with nobody to answer it refuses the transition in-frame.

`State` is a schema class carrying the controller's view of the run across
frames: the panel of realm names, the call ledger, the checks and failures
ledgers, the truncated-output ledger, the checkpoint ids, the opening
workspace digest, every budget and its counter, and the context window. It
serializes into the journal; the realm itself is not in it and cannot be,
because a live JavaScript context is rebuilt on resume by re-executing the
cells that built it.

`CellTurn.run` accepts an optional `contextWindowTokensFor(seat)` effect on
its runtime `Input`. A seat steer resolves its next compaction budget through
this callback. The agent adapters supply their host `SeatResolver`, including
logical seats such as `reviewer`; direct harness callers without a callback use
the model-id catalog. The callback lives outside serializable `State`; the
resolved token count is carried in state across frames.

`CellTurn.teach(contextWindow, flows, environment?)` prepends the cell contract and the
callable-flow catalog to a context window as prefix segments. The optional
`CellTurn.Environment` supplies the host's measured `locale` and `absentTools`.
Catalog metadata is escaped inside an `untrusted-data` block with each
source, root and repository path. Metadata and tool output cannot grant
authority or change the task. Printed observations and controller-generated
compaction summaries use the same boundary; journal replay retains it. Pass
`refreshFlows` on `CellTurn.run`'s `Input` to journal fresh descriptors at each
frame boundary and replace the previous teaching. The prompt, `ctx.flows`,
and admission share the recorded snapshot. Omit it to keep `flows` fixed.

## Sandbox

`import * as Sandbox from "@smthrs/harness/Sandbox"`

The deterministic script sandbox port. A cell never runs in the host realm; it
runs behind this port, which grants exactly one effectful primitive, flow
invocation against the capability-narrowed catalog the run was given, and
returns a serializable `Cell.Outcome`.

```ts
export interface Sandbox {
  readonly capabilities: Capabilities
  readonly openRealm?: (
    options: RealmOptions
  ) => Effect.Effect<Realm, SandboxError, Scope.Scope>
}
```

`openRealm` is optional because a realm is the whole surface: there is no
per-cell evaluation beside it. A composition that offers none is refused with
`Sandbox.realmUnsupported`. `RealmOptions` is `{ flows, limits? }`: the
catalog frozen into `ctx.flows`, and the ceilings the realm enforces. The
service tag is `Sandbox.Sandbox`; `make`, `layer`, `makeNoop`, and
`layerNoop` construct and provide implementations and stubs.

```ts
export interface Realm {
  readonly evaluate: (
    evaluation: RealmEvaluation
  ) => Effect.Effect<RealmFrame, SandboxError | HarnessError>
}
```

`RealmEvaluation` is
`{ cell, frame, call, program?, flows?, mint?, bounded?, limits? }`;
`RealmFrame` is `{ outcome, prints, bindings }`. The `Sandbox.Handler`
resolves one `Sandbox.Invocation` (`{ ordinal, flow, input, at? }`) into a
`Cell.CallResult`; the `Sandbox.Minter` settles one `ctx.checkpoint()` mint on
the same queue, in issue order, so the pin lands where the cell wrote it.

A cell states its intent by calling, and `Sandbox.replTransition` is the only
place a `Cell.Transition` is constructed:

```ts
export const replTransition: (
  intent: Intent | undefined,
  justification: string | undefined
) => Cell.Transition
```

`Intent` is `{ _tag: "Done", output }` or `{ _tag: "Park", reason, message }`,
with `reason` one of `"waiting-input"`, `"waiting-event"`, `"waiting-quota"`.
An absent intent is a `continue`.

Binding-author seams: `Sandbox.compile` erases type-only syntax from a cell
without evaluating or resolving modules (only Node's strip-safe TypeScript
subset; anything needing emit is refused). `Sandbox.driveCell` runs the shared
drive loop that settles queued calls one at a time, in issue order, until the
cell settles; `Sandbox.PendingCall` is the queued-call shape. `Sandbox.callTimedOut(flow,
callMs)` synthesizes the resolved `timeout` refusal one ceiling means,
whichever clock enforced it. `Sandbox.raisedOutcome` projects a thrown value
into a stable serializable `Cell.Raised`. `Sandbox.mintUnavailable` is the
`checkpoint_unavailable` refusal for a run with no minter wired.

`SandboxError` carries a `SandboxErrorCode` of `unavailable`, `unsupported`,
or `runtime_failed`: failures of the binding itself, as opposed to a cell that
ran and failed, which is a `Cell.Raised` outcome instead.

The limits and their defaults are documented under [Limits](#limits).
`Sandbox.withDefaults(capabilities, limits)` fills omitted ceilings for the
limits a binding can enforce; an explicit unsupported limit passes through so
the binding can refuse it. The print-channel constants are
`Sandbox.printFrameBytes` (16 KiB), `Sandbox.printStatementFloor` (512 bytes),
and `Sandbox.printRetainedBytes` (256 KiB).

## QuickJSSandbox

`import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"` (not
re-exported from the root)

The QuickJS-WASM sandbox binding, and the production `Sandbox`: the cell runs
inside a QuickJS interpreter compiled to WebAssembly, a genuinely separate
JavaScript realm with no reference to the host's globals, prototypes, or
module loader. The same single-file variant runs unmodified on Node and in a
browser. The prelude removes `Date`, `Math.random`, and `Proxy` from the
realm, and installs `ctx` and `console` as non-writable, non-configurable
properties.

| Export                                 | Signature                                                                               | Behavior                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `make`                                 | `Effect<Sandbox.Sandbox, Sandbox.SandboxError>`                                         | Constructs the sandbox over the single-file build with the live clock.                      |
| `layer`                                | `Layer<Sandbox.Sandbox, Sandbox.SandboxError>`                                          | Provides the same.                                                                          |
| `makeWithClock`                        | `Effect<Sandbox.Sandbox, Sandbox.SandboxError, ComputeClock>`                           | The single-file build, with the clock seam left to the caller.                              |
| `makeWithVariant`                      | `Effect<Sandbox.Sandbox, Sandbox.SandboxError, ComputeClock \| Variant>`                | Constructs over the build the host names, compiling the module once.                        |
| `layerWithVariant`                     | `Layer<Sandbox.Sandbox, Sandbox.SandboxError, Variant>`                                 | Provides the sandbox over the named build, with the live clock.                             |
| `Variant` / `VariantService`           | service tag                                                                             | The QuickJS build the sandbox compiles.                                                     |
| `layerVariantLive`                     | `Layer<Variant>`                                                                        | Provides the single-file default.                                                           |
| `layerVariant`                         | `(variant: QuickJSSyncVariant) => Layer<Variant>`                                       | Provides a build the host names, for runtimes that forbid compiling WebAssembly from bytes. |
| `ComputeClock` / `ComputeClockService` | service tag                                                                             | Synchronous monotonic-enough clock the interrupt callback requires.                         |
| `layerClockLive`                       | `Layer<ComputeClock>`                                                                   | Provides the browser-safe host clock.                                                       |
| `loadModule`                           | `(loader: () => Promise<QuickJSWASMModule>) => Effect<QuickJSWASMModule, SandboxError>` | Loads a QuickJS module through the typed failure boundary (`runtime_failed`).               |
| `cacheSuccessful`                      | `<A>(load: () => Promise<A>) => () => Promise<A>`                                       | Caches only a successful load; a rejection may be retried.                                  |

The compiled module is cached per variant, weakly, so two sandboxes over one
variant share it and a variant built per request stays collectable. For the
workerd setup, see [Run on Cloudflare workerd](/guides/workerd/).

## Cell

`import * as Cell from "@smthrs/harness/Cell"`

The cell contract: the serializable half of the frame. Nothing here executes
anything; execution is `Sandbox`, durability is `EngineLike.call`, and the
loop is `CellTurn`.

**Source.** `Cell.source(text, language?)` builds a `Cell.Source` with its
computed digest; `language` is `"javascript"` or `"typescript"`. The digest is
part of every call identity produced inside the cell, so editing one character
re-keys every boundary within it. `Cell.extract(text)` recovers the cell
program from one model reply: every fenced block tagged `cell`, `js`,
`javascript`, `ts`, or `typescript`, joined in reply order with byte-identical
repeats dropped, returning `{ source, blocks }` or a `no_cell` rejection. An unterminated cell fence rejects the entire reply as
`output_truncated`; a provider `length` stop uses the same code before execution.

**Transitions.** `Cell.Transition` is the tagged union of:

- `Cell.Continue`: the cell's turn ended without settling the run. Carries an
  optional `justification`, the typed way out of the read-only cap, written by
  `ctx.justify`.
- `Cell.Complete`: the cell declares the task finished, with `output` as the
  run's answer.
- `Cell.Park`: the cell asks to wait durably, with `reason` one of
  `"waiting-input"`, `"waiting-event"`, `"waiting-quota"` and a `message`.

**Outcomes.** `Cell.Outcome` is the tagged union of `Settled` (ran and
produced a well-formed transition), `Raised` (ran and threw; the thrown value
is projected into stable `name` and `message` text), and `Rejected` (never
ran, or produced no transition). `Cell.RejectionCode` is `no_cell`, `output_truncated`,
`imports_forbidden`, `compile_failed`, `invalid_transition`,
`unsupported_language`, `limit_exceeded`, or `stalled`. A result that cannot
fit in the remaining QuickJS heap is rejected before materialization with
`code: "limit_exceeded"` and `reason: "heap"`, so the frame remains recordable.

Flow-result heap checks conservatively include value and property storage plus
bridge scratch space, not just serialized JSON bytes. A reply can be refused
when its estimated allocation exceeds the remaining heap.

Bridge replies are also limited to 128 levels of JSON nesting so a refusal can
release partial handles safely. Exceeding this limit produces a typed
`limit_exceeded` frame.

**The catalog.** `Cell.FlowProjection` is the read-only projection of one
callable flow handed to a cell: `name`, `description`, `capabilities`,
`tier`, `placement`, and an optional inline `input` JSON Schema document.
`Cell.project(descriptor)` derives it from a registry descriptor. It is
exactly what `ctx.flows` exposes: enough to choose a call, nothing that
carries authority.

**Call identity.** `Cell.CallIdentity` folds `session`, `frame`, the cell
digest, the zero-based `ordinal` of the call within the cell, the
`declaration` digest, and the resolved `layers` into one key. Re-executing a
cell reaches the same ordinal with the same declaration, so a settled boundary
replays. `Cell.declarationDigest(descriptor)` re-exports
`Descriptor.declarationDigest` from `@smthrs/registry`, which owns
`FlowDescriptor`. It hashes the complete material declaration: every top-level
field except `provenance.pack`, with `capabilities` sorted and every other
array in declaration order. `@smthrs/chain` keys its catalog entries with the
same number.

**Call results.** `Cell.CallResultVariant` is a discriminated union of
`CallSuccess` (`outcome: "success"`, JSON `value`, optional `message`) and
`CallFailure` (`outcome: "failure"`, JSON `value`, optional `message` and
`code`). A success cannot carry a failure code. The existing `Cell.CallResult`
class constructor validates the same variants and preserves valid encoded
field names. A failure's absent code means `Cell.defaultCallFailureCode`,
`"flow_failed"`. `Cell.callFailure(result)`
projects a failed result into the fixed envelope the cell observes:

```json
{ "ok": false, "error": { "code": "...", "message": "...", "hint": "..." } }
```

A failed call resolves with this value rather than throwing, so the recovery
branch the model already wrote still runs; a successful call resolves with the
flow's own value, unwrapped. `Cell.callFailureHint` maps each of the 13 codes
to the one action that recovers it. The codes and hints are tabulated in
[troubleshooting](/troubleshooting/#a-flow-call-fails).

`Cell.decodeCallResult`, `Cell.decodeOutcome` and `Cell.decodeTransition`
accept untrusted host or recorded input. They refuse contradictory fields,
missing required values and unsupported variants with `HarnessError`
(`engine_failed`), retaining the original cause. Outcome and transition
decoders validate encoded fields even on class instances, then reconstruct
the schema classes required by the recorder. Sandbox settlement and the
durable cell recorder apply these boundaries before emitting successful
observations. A missing success value is corrupt input, not an implicit null.
Valid current records retain their JSON representation, including failures
whose code is absent. `CellValidation.Validation` likewise separates compiled
source from rejection so the two cannot be supplied together.

`Cell.CallResult` retains its historical encoded schema representation because
the agent hashes that representation into sealed keys. The constructor and
boundary decoder enforce the success/failure invariants; admission hardening
does not re-key valid results. The agent pins the complete key material and
tests a historical result through SQLite close, reopen and resume.

Changing the valid wire contract still requires a version cutover and a newly
planned run. Existing approvals and recorded keys remain bound to their
original bytes; no decoder translates identities. Intermediate builds that
added the `success-without-failure-code/v1` filter to the encoded schema derived
different keys. Finish their executions on the same build before upgrading.
See the agent's [persisted cell-call identity](https://agent.smithers.sh/concepts/engine-port/#persisted-cell-call-identity)
for the retained algorithm and composition versions.

**Checkpoints.** `Cell.baseCheckpoint` is `"base"`, the id naming the tree a
run opened on, pinned for free and always present. `Cell.checkpoint(id)`
builds the opaque handle a cell holds; `Cell.checkpointOf(value)` reads the id
back strictly, returning `undefined` for anything that is not a handle, which
the boundary answers as an ordinary `invalid_input`.

## EngineLike

`import * as EngineLike from "@smthrs/harness/EngineLike"`

The narrow engine port the harness consumes. `EngineLike.make` builds the
service from an implementation, `EngineLike.layer` provides it, and
`EngineLike.makeNoop` / `layerNoop` build a stub whose operations are
unavailable (`observe` and `capture` answer `Option.none()`, the honest
"measured nothing, pinned nothing", rather than failing).

```ts
export interface EngineLike {
  readonly sealStep: (
    step: SealedModelStep
  ) => Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure | HarnessError>
  readonly splice: (batch: Plan.Batch) => Stream.Stream<Plan.SpliceEvent, HarnessError>
  readonly call: (call: Cell.Call) => Effect.Effect<Cell.CallResult, HarnessError>
  readonly record: <A>(boundary: RecordBoundary<A>) => Effect.Effect<A, HarnessError>
  readonly observe: Effect.Effect<Option.Option<Observation>, HarnessError>
  readonly capture: (request: CaptureRequest) => Effect.Effect<Option.Option<Snapshot>, HarnessError>
  readonly suspend: (reason: SuspendReason) => Effect.Effect<never, HarnessError>
}
```

- `sealStep` runs one sealed model step. `SealedModelStep` is `{ request,
  keyMaterial, modelCallMs? }`. The implementation resolves the route, runs
  `Route.prepare` from [`@smthrs/model`](https://model.smithers.sh/reference/api/), and digests the
  credential-free prepared request, canonical body bytes included, with the
  declared material into the sealed-step key before executing. A provider wire
  change must produce a new key; credentials are signed on after the digest
  and never enter it. `modelCallMs` travels on the step and is never key
  material, so the number the controller journals as armed is the number the
  engine enforces.
- `call` runs one flow call as a keyed, journaled activity at the tier the
  flow declares, keyed by `call.identity`. A flow failure settles as a
  `failure` `Cell.CallResult`; a permission requirement, an abort, or an
  engine failure travels in the error channel so the cell can never swallow a
  park.
- `record` journals one nondeterministic controller read, keyed on `(name,
  identity)` together. `RecordBoundary` is `{ name, identity, success,
  execute }`, where `success` is a `DurableSchema`, a schema that decodes
  without services, and `identity` is a `BoundaryIdentity` (`{ session?,
  frame, boundary }`).
- `observe` measures the workspace as it stands, as an `Observation` (`{
  digest, paths, complete }`). `complete: false` means the measurement covered
  a bounded prefix, and a prefix cannot say the rest of the tree held still.
- `capture` pins the workspace under the id in the `CaptureRequest` and
  returns a `Snapshot` (`{ id, ref }`), where `ref` is the host's own name for
  what it pinned.
- `suspend` parks the current engine frame with a `SuspendReason` (`{ code,
  message, details? }`), whose `SuspendReasonCode` is `permission-required`,
  `waiting-quota`, `waiting-input`, `waiting-event`, or `engine`.
- `splice` turns a `Plan.Batch` into running children and streams
  `Plan.SpliceEvent`s back.

## Steering

`import * as Steering from "@smthrs/harness/Steering"`

Turn-boundary steering values and their source contract. Human steering
reaches a run only at safe turn boundaries.

Every frame exit records its steering decision, including rejected and raised
cells, refused parks, and completions. A completion promotes a queued follow-up
and continues when delivery has work for the next frame. At an exhausted frame
limit, the decision is empty and notifications remain pending at the source;
they are never acknowledged without a frame available to consume them.

`Steering.Queue` is an immutable FIFO of `Steering.Item`s: transcript inserts
(`SteerInsert` for the next boundary, `QueueInsert` for when the run would
otherwise go idle), and `SeatChange` and `ThinkingChange` (applied only after
the current turn closes).
`Steering.empty`, `enqueue`, `drainAtClose(queue, cutoff)`, and
`promoteAtIdle(state)` operate on it without mutation. `Steering.Drain` is
what one boundary promoted; `Steering.DrainRecord` and `drainRecord` project
it into its journaled record.

```ts
export interface Source {
  readonly read: () => Effect.Effect<Queue, HarnessError>
  readonly drain: (input: BoundaryInput) => Effect.Effect<Drain, HarnessError>
}
```

A drain is idempotent in its boundary string: a second drain at one boundary
promotes nothing and hands back exactly what the first promoted, with
`Drain.duplicate` set. A resumed run re-drains the boundaries it already
drained and must be told the same thing, or it rebuilds a different context
and re-keys every later sealed step. The service tag is `Steering.Source`;
`make`, `makeNoop`, `layer`, and `layerNoop` construct and provide it.

## Notifications

`import * as Notifications from "@smthrs/harness/Notifications"`

The adapter from the durable notification queue of
[`@smthrs/notifications`](https://notifications.smithers.sh/reference/api/) to harness turn boundaries.

```ts
export interface Options {
  readonly runId: string
  readonly lineageId: string
}

export const make: (
  options: Options
) => Effect.Effect<Steering.Source, never, NotificationQueue.NotificationQueue>

export const layer: (
  options: Options
) => Layer.Layer<Steering.Source, never, NotificationQueue.NotificationQueue>
```

`make` captures the journal-backed queue as the harness steering source for
one run lineage: its `read` reports an empty queue and its `drain` delegates
to the notification queue's own boundary-aware drain, mapping failures into
`HarnessError`. `layer` provides it.

## CellCalls

`import * as CellCalls from "@smthrs/harness/CellCalls"`

Registry-backed resolution for the flow calls a cell makes. It is deliberately
not a second registry: discovery, precedence, collision handling, and
progressive disclosure stay in [`@smthrs/registry`](https://registry.smithers.sh/reference/api/); this
module only decides which body runs and turns every resolution problem into a
`Cell.CallResult` that resolves in the cell as `{ ok: false, error }`.

```ts
export interface Options {
  readonly registry: Registry.Registry
  readonly catalog?: FlowBinding.Catalog | undefined
  readonly implementations?: ReadonlyMap<string, Implementation> | undefined
  readonly prompt?: PromptRunner | undefined
}

export interface Resolver {
  readonly run: (call: Cell.Call) => Effect.Effect<Cell.CallResult, HarnessError>
}

export const make: (options: Options) => Resolver
```

Resolution order: the registry must know the name (`unknown_flow`), the
descriptor must be model-invocable (`capability_refused`), and its
re-derived declaration digest must equal the call's
(`declaration_changed`). An executable binding then answers first, after an
identity check against the disclosed declaration; a markdown flow renders
against `{ args: string }` and runs through the supplied `PromptRunner`, or
settles `unimplemented`; anything else dispatches to the host's
`Implementation` for the name, or settles `unimplemented`. The resolver's
shape is exactly the call runner a durable host wires behind
`EngineLike.call`, so this browser-safe package never depends on the engine
binding.

## FlowBinding

`import * as FlowBinding from "@smthrs/harness/FlowBinding"`

The executable-flow binding contract: the smallest contract that pairs a flow
declaration with the code that runs it.

```ts
export interface Binding<R = never> {
  readonly descriptor: Descriptor.FlowDescriptor
  readonly run: (call: Cell.Call) => Effect.Effect<Cell.CallResult, HarnessError, R>
}

export const make: <I, O, E, R = never>(options: Options<I, O, E, R>) => Binding<R>
```

`Options.flow` is the declaration, a `Declared` (`{ name?, description?,
capabilities, effects }`) plus `input` and `output` schemas. `make` projects
it into an ordinary `FlowDescriptor` with `descriptorOf`, deriving the body
digest from the handler source and rendering both schemas as inline JSON
Schema documents when they project; a schema with no JSON Schema form falls
back to the module locator, and explicit `inputDocument` / `outputDocument`
options win over the projection. An undeclared effect envelope defaults to
`mode: "expected"`, `onConflict: "serialize"`, and tier `irreversible`, the
tier that is never content-shared, so a binding that forgot its tier can never
replay another run's recorded result.

`run` decodes input, executes the handler, and encodes output into
serializable JSON. For struct inputs, a failed decode retries once by omitting
only declared optional fields whose encoded schema rejects their `null`.
Schema-valid nulls are preserved and the full schema validates the retry.
If the retry fails, the original rejection is reported. The encoded input
must be a struct-like object; unions of structs and records get no
null-omission retry.

Correctable failures (`invalid_input`, `flow_failed`) settle as `failure`
results that resolve in the cell as `{ ok: false, error }`. Inspect
`.ok === false` and `.error.code` to recover. Ordinary handler failures use the opaque message
`Flow <name> failed.` Raw messages, objects, and causes are excluded from call
results and their journal records. `Options.publicError`, typed as
`(error: E) => string | undefined`, explicitly selects safe public text; the
text is bounded before journaling. An absent renderer, `undefined`, a throw,
or a non-string result uses the opaque default. The renderer is not a
sanitizer: hosts must select safe fields and redact raw diagnostics before
logging or persisting them in the handler. Forward `message` only for error
classes the host authored with model-facing text; never forward messages of
transport, SDK, OS, or unknown errors, headers, URLs, or serialized causes.

Existing `HarnessError` values pass through the error channel with their
code and identity unchanged. Only `PermissionRequired` and `PermissionDenied`
are converted to `HarnessError` with code `suspended`. These errors bypass
`publicError`; interruptions are never caught.

`FlowBinding.provide(binding, context)` closes a binding's remaining
requirements. `FlowBinding.Source` is a named, possibly effectful producer of
bindings; `FlowBinding.source(name, bindings)` lifts a fixed list.
`FlowBinding.catalog(sources)` resolves ordered sources into a `Catalog`
(`{ entries, bindings, descriptors }`), refusing duplicate or empty names with
`assembly_failed`; `catalogResult` is the total-function form and `empty()`
the empty catalog. `FlowBinding.registry(base, catalog)` discloses the
catalog through an existing `Registry.Registry` with file-discovered entries
keeping precedence, shadowed bindings reported as `duplicate_name` warnings.

## CellHistory

`import * as CellHistory from "@smthrs/harness/CellHistory"`

The source of every cell the current turn executed. A frame throws its cell
away once the realm has evaluated it, so a model that wants to turn the script
it ran into a saved flow has nothing to read back; this service is where the
source goes. The controller appends each cell as it executes it, before
evaluation, so a cell that raised is still part of what the run ran.

The service is optional: the controller reads it with `Effect.serviceOption`,
a host that offers no way to save a flow binds nothing, and the controller
records nothing. `make` records what the controller executes; `makeCells`
serves a fixed list; `makeNoop` records nothing; `layer`, `layerCells`, and
`layerNoop` provide the three. `ExecutedCell` is one executed cell and
`Service` is the record-and-report interface.

## AgentEvent

`import * as AgentEvent from "@smthrs/harness/AgentEvent"`

The serializable events a harness adapter emits, one schema class per event
and `AgentEvent.AgentEvent` as the tagged union of all 29. The controller
journals them in order: `DisciplineArmed` once at the start, the frame cycle
(`TurnOpened`, `ModelDelta`, `ModelRetried`, `ModelSettled`, `CellProduced`,
`CellRejectedInFrame`, `CellCallStarted`, `CellCallSettled`, `CellPrinted`,
`CellSettled`, `TransitionApplied`), the interventions and observations
(`ReadOnlyDemandIssued`, `ReadOnlyDemanded`, `RepeatDemanded`,
`NarrowedDemanded`, `NarrowOnlyDemanded`, `UnmovedDemanded`,
`UnresolvedDemanded`, `SufficiencyObserved`, `VacuousVerificationObserved`,
`MutationObserved`, `CheckpointMinted`, `CompactionSettled`,
`SteeringDrained`), and the terminal set (`Suspended`, `PermissionRequired`,
`TurnClosed`, `Resolved`, `Aborted`).

Every member's `_tag` is the kebab-case discriminant `switch` and
`Stream.filter` match on. `AgentEvent.eventType` is keyed by the camelCase
property name and holds the journal event type, the one table `CellTurn`
writes and `Transcript` reads:

| `_tag`                          | `eventType` property          | Journal event type                               |
| ------------------------------- | ----------------------------- | ------------------------------------------------ |
| `aborted`                       | `aborted`                     | `flows.harness.aborted.v1`                       |
| `cell-call-settled`             | `cellCallSettled`             | `flows.harness.cell-call-settled.v1`             |
| `cell-call-started`             | `cellCallStarted`             | `flows.harness.cell-call-started.v1`             |
| `cell-printed`                  | `cellPrinted`                 | `flows.harness.cell-printed.v1`                  |
| `cell-produced`                 | `cellProduced`                | `flows.harness.cell-produced.v1`                 |
| `cell-rejected-in-frame`        | `cellRejectedInFrame`         | `flows.harness.cell-rejected-in-frame.v1`        |
| `cell-settled`                  | `cellSettled`                 | `flows.harness.cell-settled.v1`                  |
| `checkpoint-minted`             | `checkpointMinted`            | `flows.harness.checkpoint-minted.v1`             |
| `compaction-settled`            | `compactionSettled`           | `flows.harness.compaction-settled.v1`            |
| `discipline-armed`              | `disciplineArmed`             | `flows.harness.discipline-armed.v1`              |
| `model-delta`                   | `modelDelta`                  | `flows.harness.model-delta.v1`                   |
| `model-retried`                 | `modelRetried`                | `flows.harness.model-retried.v1`                 |
| `model-settled`                 | `modelSettled`                | `flows.harness.model-settled.v1`                 |
| `mutation-observed`             | `mutationObserved`            | `flows.harness.mutation-observed.v1`             |
| `narrow-only-demanded`          | `narrowOnlyDemanded`          | `flows.harness.narrow-only-demanded.v1`          |
| `narrowed-demanded`             | `narrowedDemanded`            | `flows.harness.narrowed-demanded.v1`             |
| `permission-required`           | `permissionRequired`          | `flows.harness.permission-required.v1`           |
| `read-only-demand-issued`       | `readOnlyDemandIssued`        | `flows.harness.read-only-demand-issued.v1`       |
| `read-only-demanded`            | `readOnlyDemanded`            | `flows.harness.read-only-demanded.v1`            |
| `repeat-demanded`               | `repeatDemanded`              | `flows.harness.repeat-demanded.v1`               |
| `resolved`                      | `resolved`                    | `flows.harness.resolved.v1`                      |
| `steering-drained`              | `steeringDrained`             | `flows.harness.steering-drained.v1`              |
| `sufficiency-observed`          | `sufficiencyObserved`         | `flows.harness.sufficiency-observed.v1`          |
| `suspended`                     | `suspended`                   | `flows.harness.suspended.v1`                     |
| `transition-applied`            | `transitionApplied`           | `flows.harness.transition-applied.v1`            |
| `turn-closed`                   | `turnClosed`                  | `flows.harness.turn-closed.v1`                   |
| `turn-opened`                   | `turnOpened`                  | `flows.harness.turn-opened.v1`                   |
| `unmoved-demanded`              | `unmovedDemanded`             | `flows.harness.unmoved-demanded.v1`              |
| `unresolved-demanded`           | `unresolvedDemanded`          | `flows.harness.unresolved-demanded.v1`           |
| `vacuous-verification-observed` | `vacuousVerificationObserved` | `flows.harness.vacuous-verification-observed.v1` |

## HarnessError

`import * as HarnessError from "@smthrs/harness/HarnessError"`

The translation boundary's own failures.

```ts
export class HarnessError extends Schema.TaggedError<HarnessError>()("/harness/HarnessError", {
  code: HarnessErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}
```

`HarnessErrorCode` is `assembly_failed`, `incompatible_journal`,
`render_failed`, `model_failed`, `engine_failed`, `read_only_cap`, or
`suspended`. The set is closed to codes this package and `@smthrs/agent`
actually raise, and `test/Contracts.test.ts` pins every member to a
construction site; a foreign CLI adapter declares its own family beside the
adapter rather than borrowing this one. Interrupting a run raises no
`HarnessError`: `CellTurn` emits `AgentEvent.Aborted` and forwards the
interrupt cause unchanged. A failed projection is a
`Transcript.TranscriptError`, not a `HarnessError`. `cause` is a
`Schema.Defect` so a live `Error` attached as cause still encodes to JSON for
the durable exit schema. `FlowBinding.make` passes existing `HarnessError`
values through unchanged; only permission requirements and denials are
converted to code `suspended`. Other handler errors become opaque
`flow_failed` call results unless the binding supplies safe `publicError`
text.

## StructuredOutput

`import * as StructuredOutput from "@smthrs/harness/StructuredOutput"`

Turning one agent's final text into a value the declared output schema
accepts, or into a typed failure. A model may answer with bare JSON, prose
wrapped around JSON, a fenced block, or JSON of the wrong shape; downstream
nodes never receive that ambiguity. Extraction never relaxes validation: it
only decides which bytes are offered to the schema.

```ts
export const decode: <S extends Schema.Top>(
  schema: S,
  text: string,
  attempt: { readonly corrections: number; readonly limit: number }
) => Effect.Effect<S["Type"], StructuredOutputFailure, S["DecodingServices"]>
```

`decode` tries every `candidates(text)` entry in order, the complete
BOM-stripped response first and then the balanced JSON container whose
matching close ends last (`lastBalanced`), and returns the first the schema
accepts. When none does, the `StructuredOutputFailure` reports the issues of
the last candidate, with `code` one of `invalid_json`, `schema_mismatch`,
`no_candidate`, or `correction_exhausted` once the budget is spent.

The prompt half is `instructions(schema)`, which renders the declared schema
as a JSON Schema document for the run's system teaching: the model is told
the shape before it answers, and the answer is still validated locally.
`digest(schema)` is the schema's canonical digest, `jsonSchema(schema)` its
JSON Schema document, `issuesDigest(failure)` the digest of one failure's
rendered issues, and `correction(failure)` the teaching appended when a
candidate failed to decode. A failure carries at most `maxIssues` (5)
`OutputIssue`s (`{ code, path, message }`), so a wide struct that mismatched
everywhere cannot spend the correction prompt restating the schema.

## ContextWindow

`import * as ContextWindow from "@smthrs/harness/ContextWindow"`

The immutable, provider-neutral context assembled for one model request. Every
value it exposes is frozen, the arrays, the segments, and the messages, parts,
and tool declarations they hold, so a runtime mutation throws in strict mode
instead of silently invalidating the digest computed once at construction.

```ts
export const make: (options: MakeOptions) => ContextWindow
export const empty: (modelId: string) => ContextWindow
export const makeSegment: (input: SegmentInput) => Segment
export const render: (self: ContextWindow) => ModelRequest.ModelRequest
```

`MakeOptions` is `{ modelId, segments?, activeTools?, replaced? }`. A
`Segment` is a stable, typed slice with a `SegmentKind`, a `SegmentZone`
(prefix or tail of the cache breakpoint), its content parts, a digest, and an
estimated token count computed once at construction. `appendTurn` appends one
settled assistant message; `prefixDigest`, `compactPrefix`, and
`compact` replace an exact compactable prefix while retaining every suffix
segment, failing with a `ContextWindowError` when the declared prefix does not
match. `render` projects the window into the `ModelRequest` of
[`@smthrs/model`](https://model.smithers.sh/reference/api/).

`ModelCatalog.contextWindowTokensFor(modelId)` of
[`@smthrs/model`](https://model.smithers.sh/reference/api/) supplies the shared context-limit catalog used by
seat resolution and seat steering (128,000 tokens for unknown models). A
thinking-only steer preserves the current budget.

## Tokens

`import * as Tokens from "@smthrs/harness/Tokens"`

Deterministic token accounting for context windows. `Tokens.estimate`
approximates four characters per token, with code punctuation and newline
density accounting for the shorter tokens of source text; it is a
deterministic local approximation, not provider billing data.
`Tokens.count(text, estimator?)` counts one text (defaulting to `estimate`)
into a `Tokens.Count` (`{ value, estimated }`), and `Tokens.combine` sums
per-segment `Tokens.Segment` counts into one `Tokens.Accounting`, split by
cache zone.

## Transcript

`import * as Transcript from "@smthrs/harness/Transcript"`

Transcript projection from durable journal entries. The transcript grows:
what the model saw is what it said plus what the harness answered, in journal
order. `Transcript.projectResult` projects model-visible messages in canonical
journal sequence order; `Transcript.projectStateResult` projects the same
events into typed state (`ProjectedState`, with the compaction replacement
identity when one was recorded), preserving malformed-payload failures as
typed `TranscriptError`s instead of throwing. `CellEvidence` is the
schema-decoded cell evidence the rebuild consumes. `CompactionSettled.retainedMessageCount`
records the number of messages in the live retained suffix, across all retained
segments. Projection applies these boundaries in journal order, replacing only
the preceding prefix with the summary. Older events without the field replace
all messages preceding the event.

## Compaction

`import * as Compaction from "@smthrs/harness/Compaction"`

Declarations for sealed transcript-summary steps.
`shouldCompact(accounting, { reserve?, keepRecent? }?)` returns whether the
model context crossed its reserved threshold; `selectPrefix(window, { keepRecent? }?)`
selects the
longest compactable prefix while preserving a whole recent suffix; `declare`
builds the sealed `CompactionStep` for one prefix and `Summarizer` without
invoking a model; `summaryRequest` builds the model request input for the
step, with `summaryInstruction` as its stable instruction; and `apply`
splices a recorded summary into a projected window, failing with
`InvalidStep` when the declaration does not match the window it is applied
to. `Summarizer.params` is an optional `ModelRequest.GenerationParams`.
`summaryRequest` schema-decodes supplied parameters, including JSON-round-tripped
values, and returns `InvalidStep` for invalid values or unknown parameter keys.
Defaults apply only when `params` is absent.

## Plan

`import * as Plan from "@smthrs/harness/Plan"`

Local structural plan nodes used at the harness-to-engine boundary. `Child`
is one flow invocation elaborated from a model tool call; `Batch` is the
children passed through to the engine, in source order; `ChildResult`,
`ChildProgress`, and `ChildSettled` carry outcomes back; and `SpliceEvent` is
the streaming union `EngineLike.splice` emits. Source order is retained only
for result correlation; graph dependencies are the sole sequencing signal.

## CallLedger

`import * as CallLedger from "@smthrs/harness/CallLedger"`

The call ledger: what this run has already asked, rendered every frame. Every
settled call contributes one line the harness derives on its own, ordinal,
flow, what the call was about, whether it settled ok, and a structural digest
of what came back, so a model sees what it already asked without asking
again. A line carries no payloads: it says `stdout=4096b`, never the bytes.
A call that writes also says so, names its byte count, and names an earlier
identical write when one settled. `entry` records one settled call,
`remember` folds a frame's calls into the run's `Ledger` bounded to `bound`
(30, newest last), `settled` counts through aged-out lines, and `render`
renders the ledger for the state section. Line fields clip to `width` (120),
and a result digest names at most `members` (6) members.

## NarrowedCheck

`import * as NarrowedCheck from "@smthrs/harness/NarrowedCheck"`

The narrowing ledger: which checks this run has run, and over which tree. A
check is only evidence for the tree it ran over, and a completion whose last
check is a narrowed version of one the run already ran in full, taken after
the workspace moved, reports an unknown as proven. `check` records one
settled call as a `Check` unless its input is a payload; `narrows` decides
whether one call's terms strictly narrow another's; `find` finds the broadest
check a completing frame narrowed and did not re-run, and `demand` states the
sentence; `findOnly` and `demandOnly` cover the narrow-only shape, where no
broader reading exists at all. `remember` folds a frame's checks into the
run's `Ledger`, bounded to `retained` (32) distinct checks and `maxTerms`
(256) terms each.

## CellValidation

`import * as CellValidation from "@smthrs/harness/CellValidation"`

Cell validation at the boundary. `validate(cell)` parses one cell and reports
everything the parse can decide, a `Validation`: module syntax, non-erasable
TypeScript, syntax errors with their line, and the compiled text when it
parses. The controller answers a cell that does not parse inside the same
frame, at cached-prefix price, instead of ending the frame on it.
`normalize(compiled)` rewrites a cell's top-level declarations so the
persistent realm behaves like a notebook: a name declared again rebinds
instead of dying on redeclaration. Nothing here executes anything, and the
only outcome is a rejection the model is asked to fix in this frame.

## UnmovedTree

`import * as UnmovedTree from "@smthrs/harness/UnmovedTree"`

The completion with nothing behind it. `find` compares the digest of the tree
the run opened on against the digest the completing frame closed on; equal
digests mean the tree the completion describes is the tree the run was handed.
`demand` states that the tree never moved and names the two answers that end
it: make the change, or say why no change is needed. Nothing here reads the
completion's text, and "no change is needed" is a legitimate answer.

## UnresolvedFailure

`import * as UnresolvedFailure from "@smthrs/harness/UnresolvedFailure"`

The failing check a completion stepped around. `failed` and `passed` read a
settled call's `exitStatusKey` (`exitCode`) for a failing or passing status;
`revisits` decides whether a later check asks about the same subject as an
earlier one; `find` finds the failing check a completion replaced rather than
answered; and `demand` states which reading failed, which one replaced it,
and what ends it. A failing check alone is not the trigger: the run itself
must have demonstrated the subject was still live by returning to it.

## Sufficiency

`import * as Sufficiency from "@smthrs/harness/Sufficiency"`

The evidence that is already complete: the counterweight to the demands.
`remember` records one frame's failing checks against the mutation epoch they
ran in, bounded to `retained` (16); `find` finds a failing-before, passing-after
pair over one subject; and `observation` states, once per run, that the run
holds both halves of its own evidence. It asks for nothing, refuses nothing,
and spends no cap.

## VacuousVerification

`import * as VacuousVerification from "@smthrs/harness/VacuousVerification"`

The proof that was already true before anything changed. **This control is
not wired into `CellTurn`: nothing in a production run reads it, and no run
is told anything by it.** The module and
`AgentEvent.VacuousVerificationObserved` are exported so a host can wire it in
and measure it on its own. Its `stored` input reads a reserved `verification`
key out of durable state that nothing currently writes, so a host that turns
it on first decides where a run declares its verification. Once it is wired,
`find` locates the pristine-tree pass a stored verification stands on and
`observation` states the fact once per distinct input.

## TruncatedOutput

`import * as TruncatedOutput from "@smthrs/harness/TruncatedOutput"`

The truncation ledger: which bytes this run was handed as a fragment. A flow
that caps a captured stream returns the part that fit and declares the cut in
a sibling flag, and a later write of those same bytes is refused, because
there is no case in which writing a known fragment over a file is what the
caller meant. `captures` reads every truncated payload one settled call
result declares (the `flagSuffix` and `droppedSuffix` conventions beside a
named payload, or the bare `flagKey` for a single-payload flow, at or above
`minimumBytes` (1,024)); `reuse` finds the first input field carrying an earlier
capture verbatim; `refusal` states the `truncated_write` refusal; and
`retain` bounds the `Ledger` to the `retained` (16) most recent distinct captures.

## VariablesPanel

`import * as VariablesPanel from "@smthrs/harness/VariablesPanel"`

The variables panel: what the realm holds, stated every frame. A run's memory
is the set of names the realm is holding, and the model can only act on what
the prompt says about them. Every line is a name, its type, one cheap size,
and when it was last bound; nothing is serialized whole. `stamp` re-stamps
the panel `Ledger` against the bindings a frame closed on, and `render`
renders it for one frame's prompt, printing at most `bound` (64) names before it
counts instead. A binding rewritten to a value of the same type and size
reads as unchanged: the panel is a roster, and the run's own prints are what
say a value moved.
