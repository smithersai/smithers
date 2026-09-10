---
title: "Module and export inventory"
description: "Every public module of @smthrs/harness and every export it publishes, one table per module."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/harness/docs/reference.md"
---

This page lists every public module and the exports it publishes, one table
per module. Behavior, signatures, and error semantics for each module are in
the [API reference](/reference/api/); this page is the lookup table.

The root barrel `@smthrs/harness` re-exports every module below as a
namespace, except `QuickJSSandbox`, which is imported from its own subpath
because it carries an embedded WebAssembly build. Every module is also
importable as `@smthrs/harness/<Module>`.

| Module | Public exports | Description |
| --- | --- | --- |
| `HarnessError` | `HarnessErrorCode`, `HarnessError` | Stable failures reported at the harness translation boundary. |
| `AgentEvent` | `DisciplineArmed`, `TurnOpened`, `ModelDelta`, `ModelRetried`, `ModelSettled`, `CellProduced`, `CellRejectedInFrame`, `CellCallStarted`, `CellCallSettled`, `CellPrinted`, `CellSettled`, `TransitionApplied`, `ReadOnlyDemandIssued`, `ReadOnlyDemanded`, `RepeatDemanded`, `NarrowedDemanded`, `UnmovedDemanded`, `UnresolvedDemanded`, `NarrowOnlyDemanded`, `SufficiencyObserved`, `VacuousVerificationObserved`, `MutationObserved`, `CheckpointMinted`, `Suspended`, `CompactionSettled`, `SteeringDrained`, `TurnClosed`, `PermissionRequired`, `Aborted`, `Resolved`, `AgentEvent`, `eventType` | Serializable events emitted by harness adapters. |
| `Plan` | `Child`, `Batch`, `ChildResult`, `ChildProgress`, `ChildSettled`, `SpliceEvent` | Local structural plan nodes used at the harness-to-engine boundary. |
| `EngineLike` | `SuspendReasonCode`, `SuspendReason`, `SealedModelStep`, `BoundaryIdentity`, `DurableSchema`, `RecordBoundary`, `Observation`, `Snapshot`, `CaptureRequest`, `EngineLike`, `make`, `layer`, `makeNoop`, `layerNoop` | Narrow engine port consumed by the built-in harness. |
| `Tokens` | `Count`, `Segment`, `Accounting`, `Estimator`, `estimate`, `count`, `combine` | Deterministic token accounting for context windows. |
| `ContextWindow` | `TypeId`, `SegmentKind`, `SegmentZone`, `Content`, `ContextWindowErrorCode`, `ContextWindowError`, `Segment`, `ContextWindow`, `SegmentInput`, `MakeOptions`, `makeSegment`, `make`, `empty`, `appendTurn`, `activateTools`, `prefixDigest`, `compactPrefix`, `compact`, `render` | The immutable, provider-neutral context assembled for one model request. |
| `Transcript` | `TranscriptErrorCode`, `TranscriptError`, `ProjectedMessage`, `ProjectedState`, `CellEvidence`, `projectStateResult`, `projectResult` | Transcript projection from durable journal entries. |
| `Compaction` | `summaryInstruction`, `InvalidStep`, `Summarizer`, `CompactionStep`, `TokenAccounting`, `shouldCompact`, `selectPrefix`, `declare`, `summaryRequest`, `apply` | Declarations for sealed transcript-summary steps. |
| `Steering` | `Delivery`, `SteerInsert`, `QueueInsert`, `Insert`, `SeatChange`, `ThinkingChange`, `ActivateTools`, `Item`, `Queue`, `Drain`, `BoundaryInput`, `DrainRecord`, `drainRecord`, `PromotionState`, `empty`, `enqueue`, `drainAtClose`, `promoteAtIdle`, `Source`, `SourceInput`, `make`, `makeNoop`, `layer`, `layerNoop` | Turn-boundary steering values and their source contract. |
| `Notifications` | `Options`, `make`, `layer` | Adapter from the durable notification queue to harness turn boundaries. |
| `Cell` | `Language`, `Source`, `digestOf`, `source`, `Continue`, `Complete`, `Park`, `Transition`, `renderText`, `RejectionCode`, `Settled`, `Raised`, `Rejected`, `Outcome`, `FlowProjection`, `project`, `CallFailureCode`, `defaultCallFailureCode`, `callFailureHint`, `CallIdentity`, `declarationDigest`, `Call`, `baseCheckpoint`, `checkpoint`, `checkpointOf`, `CallResult`, `CallSuccess`, `CallFailure`, `CallResultVariant`, `decodeCallResult`, `decodeOutcome`, `decodeTransition`, `callFailure`, `Extracted`, `extract` | The cell contract. |
| `Sandbox` | `SandboxErrorCode`, `SandboxError`, `Invocation`, `Mint`, `Minter`, `mintUnavailable`, `Handler`, `Limits`, `Capabilities`, `defaultLimits`, `minimumSteps`, `minimumTimeMs`, `minimumMemoryBytes`, `printFrameBytes`, `printStatementFloor`, `printRetainedBytes`, `withDefaults`, `Intent`, `replTransition`, `RealmEvaluation`, `RealmFrame`, `Realm`, `RealmOptions`, `Sandbox`, `make`, `layer`, `makeNoop`, `layerNoop`, `realmUnsupported`, `callTimedOut`, `compile`, `PendingCall`, `driveCell`, `raisedOutcome` | The deterministic script sandbox port. |
| `CellTurn` | `defaultMaxFrames`, `defaultReadOnlyFrames`, `defaultModelCallMs`, `defaultRepeatFrames`, `defaultNarrowingDemands`, `defaultUnmovedDemands`, `defaultUnresolvedDemands`, `defaultRevalidations`, `defaultMaxCheckpoints`, `State`, `Input`, `make`, `teach`, `run` | The cell-first controller. |
| `CellHistory` | `ExecutedCell`, `Service`, `CellHistory`, `make`, `makeCells`, `makeNoop`, `layer`, `layerCells`, `layerNoop` | The source of every cell the current turn executed. |
| `CellCalls` | `Implementation`, `Prompt`, `PromptRunner`, `Options`, `Resolver`, `make` | Registry-backed resolution for the flow calls a cell makes. |
| `FlowBinding` | `Declared`, `DescriptorOptions`, `descriptorOf`, `Binding`, `Options`, `make`, `provide`, `Source`, `source`, `Catalog`, `empty`, `catalogResult`, `catalog`, `registry` | The executable-flow binding contract. |
| `StructuredOutput` | `StructuredOutputFailureCode`, `OutputIssueCode`, `OutputIssue`, `StructuredOutputFailure`, `maxIssues`, `jsonSchema`, `digest`, `instructions`, `issuesDigest`, `correction`, `lastBalanced`, `candidates`, `decode` | Turning one agent's final text into a value the declared output schema accepts, or into a typed failure. |
| `TruncatedOutput` | `flagSuffix`, `droppedSuffix`, `flagKey`, `minimumBytes`, `retained`, `Capture`, `Reuse`, `captures`, `reuse`, `refusal`, `retain`, `Ledger` | The truncation ledger: which bytes this run was handed as a fragment. |
| `CallLedger` | `bound`, `width`, `members`, `Entry`, `Ledger`, `subject`, `target`, `digest`, `payload`, `Settlement`, `entry`, `settled`, `remember`, `render` | The call ledger: what this run has already asked, rendered every frame. |
| `NarrowedCheck` | `retained`, `maxTerms`, `targeting`, `names`, `lex`, `terms`, `conditions`, `Check`, `Narrowing`, `check`, `narrows`, `find`, `demand`, `Only`, `findOnly`, `demandOnly`, `remember`, `Ledger` | The narrowing ledger: which checks this run has run, and over which tree. |
| `CellValidation` | `Validation`, `normalize`, `validate` | Cell validation at the boundary. |
| `UnmovedTree` | `Unmoved`, `find`, `demand` | The completion with nothing behind it. |
| `UnresolvedFailure` | `exitStatusKey`, `failed`, `passed`, `Displaced`, `revisits`, `find`, `demand` | The failing check a completion stepped around. |
| `Sufficiency` | `retained`, `Failure`, `Ledger`, `remember`, `Sufficient`, `find`, `observation` | The evidence that is already complete. |
| `VacuousVerification` | `retained`, `Pass`, `Ledger`, `remember`, `stored`, `find`, `observation` | The proof that was already true before anything changed. |
| `VariablesPanel` | `bound`, `Binding`, `Stamp`, `Ledger`, `stamp`, `render` | The variables panel: what the realm holds, stated every frame. |
| `QuickJSSandbox` *(subpath)* | `cacheSuccessful`, `VariantService`, `Variant`, `layerVariantLive`, `layerVariant`, `ComputeClockService`, `ComputeClock`, `layerClockLive`, `loadModule`, `makeWithVariant`, `makeWithClock`, `make`, `layerWithVariant`, `layer` | The QuickJS-WASM sandbox binding. |

## HarnessError

`import * as HarnessError from "@smthrs/harness/HarnessError"`

Stable failures reported at the harness translation boundary.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `HarnessErrorCode` | const | models | Stable harness failure codes. |
| `HarnessError` | class | errors | A failure while translating a recorded agent turn. |

## AgentEvent

`import * as AgentEvent from "@smthrs/harness/AgentEvent"`

Serializable events emitted by harness adapters.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `DisciplineArmed` | class | events | The loop discipline a run was armed with, journaled once when it starts. |
| `TurnOpened` | class | events | The serializable snapshot fixed when a turn opens. |
| `ModelDelta` | class | events | One provider-neutral model progress event. |
| `ModelRetried` | class | events | A transport-only model retry taken before the sealed step settled. |
| `ModelSettled` | class | events | The complete recorded model settlement and usage. |
| `CellProduced` | class | events | The cell source recovered from one model settlement. |
| `CellRejectedInFrame` | class | events | One reply the boundary parse refused, answered inside the frame it arrived in rather than by ending the frame. |
| `CellCallStarted` | class | events | One flow call opened from inside a running cell. |
| `CellCallSettled` | class | events | One settled flow call made from inside a running cell. |
| `CellPrinted` | class | events | What one REPL cell printed, as the next model turn will read it. |
| `CellSettled` | class | events | The outcome of executing one cell, whether it settled, threw, or was rejected before it ran. |
| `TransitionApplied` | class | events | The durable transition the controller applied after a cell settled. |
| `ReadOnlyDemandIssued` | class | events | The controller issuing a read-cap intervention to the next frame. |
| `ReadOnlyDemanded` | class | events | The outcome of the frame immediately following a read-cap intervention. |
| `RepeatDemanded` | class | events | The controller telling a run it has stopped learning anything. |
| `NarrowedDemanded` | class | events | The controller refusing one completion whose evidence was narrowed. |
| `UnmovedDemanded` | class | events | The controller refusing one completion with no change behind it. |
| `UnresolvedDemanded` | class | events | The controller refusing one completion that stepped around a failing check. |
| `NarrowOnlyDemanded` | class | events | The controller refusing one completion that holds a single reading. |
| `SufficiencyObserved` | class | events | The controller telling a run that its own evidence is complete. |
| `VacuousVerificationObserved` | class | events | The controller telling a run that its stored proof was already green. |
| `MutationObserved` | class | events | What one frame did to the workspace, and how the controller knows. |
| `CheckpointMinted` | class | events | One tree this run pinned, and the store's own name for it. |
| `Suspended` | class | events | The durable reason a cell execution parked. |
| `CompactionSettled` | class | events | A sealed compaction summary and the prefix it replaces. |
| `SteeringDrained` | class | events | Steering messages drained at a turn boundary. |
| `TurnClosed` | class | events | The terminal decision made at a turn boundary. |
| `PermissionRequired` | class | events | A permission request reported for engine-owned suspension and resolution. |
| `Aborted` | class | events | A normalized harness abort. |
| `Resolved` | class | events | The final assistant message produced by the harness. |
| `AgentEvent` | const | events | All normalized events emitted by a harness adapter. |
| `eventType` | const | events | The journal event type of every member of `AgentEvent`, by tag. |

## Plan

`import * as Plan from "@smthrs/harness/Plan"`

Local structural plan nodes used at the harness-to-engine boundary. These
values project the canonical registry metadata defined by `@smthrs/registry`'s
`Descriptor` and consumed at the splice boundary described in
[concepts](/concepts/#child-plans-and-the-splice-boundary). Source order is
retained only for result correlation; graph dependencies are the sole
sequencing signal.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `Child` | class | models | One flow invocation elaborated from a model tool call. |
| `Batch` | class | models | The children passed through to the engine. |
| `ChildResult` | class | models | A settled child outcome suitable for transcript projection. |
| `ChildProgress` | class | models | One harness-owned progress update emitted while a child call is executing. |
| `ChildSettled` | class | models | One settled child result in the streaming splice protocol. |
| `SpliceEvent` | const | models | Streaming output of one engine splice. |

## EngineLike

`import * as EngineLike from "@smthrs/harness/EngineLike"`

Narrow engine port consumed by the built-in harness. Governing contracts:
[durable cell loop](/concepts/#durable-cell-loop),
[child plans and the splice boundary](/concepts/#child-plans-and-the-splice-boundary),
and [step keys and the model layer](/concepts/#step-keys-and-the-model-layer).

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `SuspendReasonCode` | const | models | Stable reasons for parking a harness turn at a safe boundary. |
| `SuspendReason` | class | models | A serializable request to park the current engine frame. |
| `SealedModelStep` | interface | models | A sealed model request and the complete digest-free material declared by the harness. |
| `BoundaryIdentity` | interface | models | The durable identity of one journaled controller boundary. |
| `DurableSchema` | type | models | A schema that decodes without services, the only kind a durable store can reconstruct a journaled value with. |
| `RecordBoundary` | interface | models | One nondeterministic read the controller must perform exactly once per run. |
| `Observation` | class | models | One measurement of the workspace the run is changing. |
| `Snapshot` | class | models | One pinned tree the run can come back to. |
| `CaptureRequest` | interface | models | A request to pin the workspace as it stands right now. |
| `EngineLike` | interface | services | The engine operations required by harness translation. |
| `make` | const | constructors | Constructs an engine port from an implementation. |
| `layer` | const | layers | Provides an engine port implementation. |
| `makeNoop` | const | constructors | Constructs an unavailable engine stub, optionally overriding operations. |
| `layerNoop` | const | layers | Provides an unavailable engine stub. |

## Tokens

`import * as Tokens from "@smthrs/harness/Tokens"`

Deterministic token accounting for context windows.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `Count` | class | models | A token count, and whether it was estimated locally or reported by a provider. |
| `Segment` | class | models | One segment's contribution to the accounting, keyed by its content digest so an unchanged segment keeps its count across turns. |
| `Accounting` | class | models | The token totals of a whole context window, split by cache zone and broken down per segment. |
| `Estimator` | type | models | A deterministic local approximation, not provider billing data. |
| `estimate` | const | constructors | Estimates tokens using four characters per token, with code punctuation and newline density accounting for the typically shorter tokens in source text. |
| `count` | const | constructors | Counts the tokens of `text`, defaulting to `estimate`. |
| `combine` | const | combinators | Sums per-segment counts into one `Accounting`. |

## ContextWindow

`import * as ContextWindow from "@smthrs/harness/ContextWindow"`

The immutable, provider-neutral context assembled for one model request. Every
value it exposes is frozen, so a runtime mutation throws in strict mode instead
of silently invalidating the cached digest. Governing design:
[context window](/concepts/#context-window).

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `TypeId` | const | type | The brand a `ContextWindow` carries so a structurally similar object cannot pass for one. |
| `SegmentKind` | const | models | What a segment holds. |
| `SegmentZone` | const | models | Where a segment sits relative to the cache breakpoint. |
| `Content` | const | models | The parts a segment may hold. |
| `ContextWindowErrorCode` | const | models | The failure vocabulary of a context window operation. |
| `ContextWindowError` | class | errors | Stable failure returned for an invalid public compaction prefix. |
| `Segment` | class | models | A stable, typed slice of the model-visible context. |
| `ContextWindow` | class | models | One assembled, immutable model context. |
| `SegmentInput` | interface | models | A segment before its digest and token count are computed. |
| `MakeOptions` | interface | models | The declaration `make` takes. |
| `makeSegment` | const | constructors | Creates one segment, computing its identity and estimated token count. |
| `make` | const | constructors | Constructs a window from already-derived values. |
| `empty` | const | constructors | Constructs an empty context window for a model. |
| `appendTurn` | const | combinators | Appends one settled assistant message and its ordered tool results. |
| `activateTools` | const | combinators | Adds tools permanently for the lifetime of this window lineage. |
| `prefixDigest` | const | conversions | Computes the declared identity of an exact compactable prefix. |
| `compactPrefix` | const | combinators | Replaces an exact compactable prefix while retaining every suffix segment. |
| `compact` | const | combinators | Replaces the compactable transcript prefix with a summary segment. |
| `render` | const | conversions | Renders this provider-neutral value into a model request. |

## Transcript

`import * as Transcript from "@smthrs/harness/Transcript"`

Transcript projection from durable journal entries. The transcript grows: what
the model saw is what it said plus what the harness answered, in journal order.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `TranscriptErrorCode` | const | models | Stable failures produced while projecting a durable transcript. |
| `TranscriptError` | class | errors | Stable failures produced while projecting a durable transcript. |
| `ProjectedMessage` | interface | models | The kind and message of one projected transcript item. |
| `ProjectedState` | interface | models | A projection with the compaction replacement identity, when one was recorded. |
| `CellEvidence` | interface | models | Schema-decoded cell evidence consumed while rebuilding a journal. |
| `projectStateResult` | const | projections | Projects journal events into their model-visible transcript state as typed data, preserving malformed payload failures instead of throwing. |
| `projectResult` | const | projections | Projects model-visible messages in canonical journal sequence order. |

## Compaction

`import * as Compaction from "@smthrs/harness/Compaction"`

Declarations for sealed transcript-summary steps.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `summaryInstruction` | const | constants | Stable instruction for sealed summary steps. |
| `InvalidStep` | class | errors | A compaction declaration cannot be applied to the supplied context window. |
| `Summarizer` | interface | models | A serializable identity for the summarizer used by a compaction step. |
| `CompactionStep` | interface | models | The sealed declaration consumed by the engine to request one summary. |
| `TokenAccounting` | interface | models | The token accounting accepted by the compaction policy. |
| `shouldCompact` | const | predicates | Returns whether the model context has crossed its reserved compaction threshold. |
| `selectPrefix` | const | operations | Selects the longest compactable prefix while preserving a whole recent suffix. |
| `declare` | const | constructors | Declares a compaction step without invoking a model or selecting a trigger. |
| `summaryRequest` | const | operations | Builds the model request input for a compaction step. |
| `apply` | const | operations | Applies a recorded summary to a projected context window. |

## Steering

`import * as Steering from "@smthrs/harness/Steering"`

Turn-boundary steering values and their source contract. Governing design:
[notification queue](/concepts/#notification-queue).

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `Delivery` | type | models | The boundary at which a transcript insertion may be promoted. |
| `SteerInsert` | interface | models | A transcript insertion promoted at the next turn boundary. |
| `QueueInsert` | interface | models | A transcript insertion promoted only when the run would otherwise go idle. |
| `Insert` | type | models | A transcript insertion admitted for a future turn. |
| `SeatChange` | interface | models | A model-seat change that applies only after the current turn closes. |
| `ThinkingChange` | interface | models | A thinking-level change that applies only after the current turn closes. |
| `ActivateTools` | interface | models | An additive active-tool update for a future turn. |
| `Item` | type | models | A serializable steering event. |
| `Queue` | interface | models | An immutable, FIFO queue of steering events. |
| `Drain` | interface | models | The values promoted when a turn reaches its close boundary. |
| `BoundaryInput` | interface | models | The boundary a drain is being attempted at, and whether the run would go idle if nothing were delivered. |
| `DrainRecord` | const | schemas | The journaled record of one turn-boundary drain. |
| `drainRecord` | const | conversions | Projects a `Drain` into its journaled record. |
| `PromotionState` | interface | models | The close-frame facts required to admit one queued follow-up. |
| `empty` | const | constructors | Creates an empty immutable steering queue. |
| `enqueue` | const | operations | Appends an item without mutating the prior queue. |
| `drainAtClose` | const | operations | Drains only items admitted at or before the turn's fixed cutoff. |
| `promoteAtIdle` | const | operations | Returns the oldest queued insertion only when the current turn would otherwise resolve. |
| `Source` | interface | services | Source of a serializable steering-queue snapshot. |
| `SourceInput` | interface | models | The methods `make` needs to build a `Source`. |
| `make` | const | constructors | Constructs a steering source service. |
| `makeNoop` | const | constructors | Creates a source that always returns an empty queue. |
| `layer` | const | layers | Provides a steering source as a layer. |
| `layerNoop` | const | layers | Provides an empty steering source as a layer. |

## Notifications

`import * as Notifications from "@smthrs/harness/Notifications"`

Adapter from the durable notification queue to harness turn boundaries.
Governing contract: [notification queue](/concepts/#notification-queue).

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `Options` | interface | models | Which run and lineage this steering source draws notifications for. |
| `make` | const | constructors | Captures the journal-backed queue as the harness steering source for one run lineage. |
| `layer` | const | layers | Provides `Source` backed by the durable notification queue for one run lineage. |

## Cell

`import * as Cell from "@smthrs/harness/Cell"`

The cell contract. This module owns the serializable half of the frame: the
cell source the model emits, the transition the cell settled, the typed
outcomes a cell may settle with, and the identity carried by every flow call
made inside one. Nothing here executes anything. Governing designs:
[durable cell loop](/concepts/#durable-cell-loop),
[repl realm](/concepts/#repl-realm), and
[agent cell context](/concepts/#agent-cell-context).

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `Language` | const | models | The source language a cell is written in. |
| `Source` | class | models | One unit of agent-authored source and its stable content digest. |
| `digestOf` | const | constructors | Computes the stable digest of cell source. |
| `source` | const | constructors | Constructs cell source with its computed digest. |
| `Continue` | class | models | The cell's turn ended without settling the run. |
| `Complete` | class | models | The cell declares the task finished and supplies its final output. |
| `Park` | class | models | The cell asks the controller to park the run durably. |
| `Transition` | const | models | The serializable decision one cell returns. |
| `renderText` | const | conversions | Renders a projected value as the text one context entry carries. |
| `RejectionCode` | const | models | Stable reasons a cell failed to produce a transition. |
| `Settled` | class | models | The cell ran and returned a well-formed transition. |
| `Raised` | class | models | The cell ran and threw. |
| `Rejected` | class | models | The cell never ran, or ran and returned something that is not a transition. |
| `Outcome` | const | models | Everything one cell evaluation may settle with. |
| `FlowProjection` | class | models | The read-only projection of one callable flow handed to a cell. |
| `project` | const | conversions | Projects a discovered descriptor into the cell-visible catalog entry. |
| `CallFailureCode` | const | models | Why one flow call failed, as a closed set a cell may branch on. |
| `defaultCallFailureCode` | const | constants | The code a failure carries when nothing classified it. |
| `callFailureHint` | const | constants | The one action that recovers each failure class, stated to the cell. |
| `CallIdentity` | class | models | The complete identity of one flow call made inside one cell. |
| `declarationDigest` | const | constructors | Computes the declaration digest folded into a call identity. |
| `Call` | class | models | One flow call requested from inside a cell. |
| `baseCheckpoint` | const | constants | The id naming the tree a run opened on, pinned for free and always present. |
| `checkpoint` | const | constructors | Builds the handle a cell holds for one checkpoint. |
| `checkpointOf` | const | conversions | Reads the checkpoint id out of whatever a cell passed as `at`. |
| `CallResult` | class | models | The settled outcome of one flow call. |
| `CallSuccess`, `CallFailure`, `CallResultVariant` | const | schemas | Discriminated JSON results; success cannot carry a failure code. |
| `decodeCallResult`, `decodeOutcome`, `decodeTransition` | const | decoders | Validate host or recorded values, preserving original causes in typed errors. |
| `callFailure` | const | conversions | The failure envelope a cell observes when a flow call does not succeed. |
| `Extracted` | interface | models | One reply's cell program, and how many fenced blocks it was written in. |
| `extract` | const | conversions | Extracts the cell program one model settlement emitted. |

## Sandbox

`import * as Sandbox from "@smthrs/harness/Sandbox"`

The deterministic script sandbox port. A cell runs behind this port, which
grants exactly one effectful primitive, flow invocation against the
capability-narrowed catalog the run was given, and returns a serializable
`Outcome`. The port opens a `Realm`, and a realm is the whole surface: it is
acquired once per run and every cell of that run is evaluated in it.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `SandboxErrorCode` | const | models | Stable failures raised by a sandbox binding itself, as opposed to failures of the cell it was asked to run. |
| `SandboxError` | class | errors | A failure of the sandbox binding. |
| `Invocation` | interface | models | One flow invocation requested from inside a running cell. |
| `Mint` | interface | models | One request to pin the workspace, issued from inside a running cell. |
| `Minter` | type | models | Pins the workspace on behalf of a running cell. |
| `mintUnavailable` | const | constructors | The refusal a binding answers `ctx.checkpoint()` with when the caller wired no minter. |
| `Handler` | type | models | Resolves one invocation on behalf of a running cell. |
| `Limits` | interface | models | Execution limits for one cell evaluation. |
| `Capabilities` | interface | models | Which limits a binding can actually enforce. |
| `defaultLimits` | const | constants | The execution ceilings a cell runs under when the caller declares none. |
| `minimumSteps` | const | constants | Smallest interpreter-step budget a binding can enter a realm under. |
| `minimumTimeMs` | const | constants | Smallest wall-clock budget, in milliseconds, a binding can enter a realm under. |
| `minimumMemoryBytes` | const | constants | Smallest heap ceiling the QuickJS binding can initialize and tear down safely. |
| `printFrameBytes` | const | constants | How many UTF-8 bytes of one frame's whole print buffer reach the next model turn. |
| `printStatementFloor` | const | constants | The smallest UTF-8-byte share of `printFrameBytes` one print statement is given. |
| `printRetainedBytes` | const | constants | How many UTF-8 bytes of one frame's print buffer the host keeps while the cell still runs. |
| `withDefaults` | const | constructors | Fills omitted ceilings from `defaultLimits` for limits a binding can enforce. |
| `Intent` | type | models | What a REPL cell asked the controller to do. |
| `replTransition` | const | constructors | Builds the durable transition one cell settled. |
| `RealmEvaluation` | interface | models | One cell evaluated inside a realm that outlives it. |
| `RealmFrame` | interface | models | Everything one REPL frame produced. |
| `Realm` | interface | services | A JavaScript realm that persists across the cells of one run. |
| `RealmOptions` | interface | models | What a realm is opened with, which is everything that is fixed for the run. |
| `Sandbox` | interface | services | The deterministic script sandbox. |
| `make` | const | constructors | Constructs a sandbox from an implementation. |
| `layer` | const | layers | Provides a sandbox implementation. |
| `makeNoop` | const | constructors | Constructs an unavailable sandbox stub, optionally overriding operations. |
| `layerNoop` | const | layers | Provides an unavailable sandbox stub. |
| `realmUnsupported` | const | constructors | Refuses a run on a binding that has no persistent realm. |
| `callTimedOut` | const | constructors | Settles one overrunning flow call as a catchable failure. |
| `compile` | const | conversions | Erases type-only syntax from a cell without evaluating or resolving modules. |
| `PendingCall` | interface | models | A queued call awaiting resolution by a binding's driver. |
| `driveCell` | const | constructors | Drives one externally compiled cell to settlement. |
| `raisedOutcome` | const | conversions | Projects a thrown value into a stable serializable cell outcome. |

## CellTurn

`import * as CellTurn from "@smthrs/harness/CellTurn"`

The cell-first controller. One frame is: seal a model step, recover the cell
from the settlement, run it in the sandbox, resolve each of its flow calls as
its own keyed durable boundary, then apply the transition it returned.
Governing design: [durable cell loop](/concepts/#durable-cell-loop).

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `defaultMaxFrames` | const | constants | Default number of frames one admitted task may spend. |
| `defaultReadOnlyFrames` | const | constants | Default number of consecutive read-only frames a task run may spend. |
| `defaultModelCallMs` | const | constants | Default wall-clock milliseconds one model call may spend. |
| `defaultRepeatFrames` | const | constants | Default number of consecutive repeat-observation frames a run may spend. |
| `defaultNarrowingDemands` | const | constants | Default number of completions a run may have bounced for narrowed evidence. |
| `defaultUnmovedDemands` | const | constants | Default number of completions a run may have bounced for an unmoved tree. |
| `defaultUnresolvedDemands` | const | constants | Default number of completions a run may have bounced for a failing check it replaced rather than answered. |
| `defaultRevalidations` | const | constants | Default number of times one frame may answer its own unparseable cell. |
| `defaultMaxCheckpoints` | const | constants | Default number of trees one run may pin with `ctx.checkpoint()`. |
| `State` | class | models | The serializable state carried across cell frames. |
| `Input` | interface | models | Runtime declarations used to interpret serializable controller state. |
| `make` | const | constructors | Constructs an initial controller state. |
| `teach` | const | constructors | Prepends the cell contract and the callable-flow catalog to a context window. |
| `run` | const | streams | Runs the cell loop until it completes, parks, or exhausts its budget. |

## CellHistory

`import * as CellHistory from "@smthrs/harness/CellHistory"`

The source of every cell the current turn executed. The service is optional: a
host that offers no way to save a flow binds nothing and the controller records
nothing; `layerNoop` states the same answer explicitly.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `ExecutedCell` | interface | models | One cell the current turn executed. |
| `Service` | interface | models | Records and reports the current turn's executed cells. |
| `CellHistory` | class | services | Service tag for the current turn's executed cells. |
| `make` | const | constructors | Constructs a history that records what the controller executes. |
| `makeCells` | const | constructors | Constructs a history over a fixed cell list. |
| `makeNoop` | const | constructors | Constructs a history that records nothing, optionally overriding operations. |
| `layer` | const | layers | Provides a history that records what the controller executes. |
| `layerCells` | const | layers | Provides a history over a fixed cell list. |
| `layerNoop` | const | layers | Provides a history that records nothing. |

## CellCalls

`import * as CellCalls from "@smthrs/harness/CellCalls"`

Registry-backed resolution for the flow calls a cell makes. Governing designs:
[durable cell loop](/concepts/#durable-cell-loop) and
[flow registry](/concepts/#flow-registry).

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `Implementation` | type | models | One module-backed flow, implemented by the host that discovered it. |
| `Prompt` | interface | models | One discovered markdown flow, rendered against the call's arguments. |
| `PromptRunner` | type | models | Runs a rendered markdown flow. |
| `Options` | interface | models | The collaborators registry-backed resolution needs. |
| `Resolver` | interface | models | Resolves one cell call to the registered flow that answers it. |
| `make` | const | constructors | Constructs registry-backed call resolution. |

## FlowBinding

`import * as FlowBinding from "@smthrs/harness/FlowBinding"`

The executable-flow binding contract. Governing designs:
[durable cell loop](/concepts/#durable-cell-loop) and
[flow registry](/concepts/#flow-registry).

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `Declared` | interface | models | The declaration half of a binding. |
| `DescriptorOptions` | interface | models | The metadata a projected descriptor needs that a flow declaration does not carry. |
| `descriptorOf` | const | conversions | Projects an ordinary flow declaration into a registry descriptor. |
| `Binding` | interface | models | One flow declaration and the code that runs it. |
| `Options` | interface | models | Everything one executable binding declares. |
| `make` | const | constructors | Binds one flow declaration to its runtime implementation. |
| `provide` | const | combinators | Supplies a binding's remaining requirements from a context the host built. |
| `Source` | interface | models | A named producer of executable bindings. |
| `source` | const | constructors | Constructs a source over a fixed binding list. |
| `Catalog` | interface | models | The deterministic composition of every executable binding a host resolved. |
| `empty` | const | constructors | The empty catalog. |
| `catalogResult` | const | constructors | Composes bindings into a catalog, refusing duplicate names. |
| `catalog` | const | constructors | Resolves ordered sources into one catalog. |
| `registry` | const | constructors | Discloses a catalog's descriptors through an existing registry. |

## StructuredOutput

`import * as StructuredOutput from "@smthrs/harness/StructuredOutput"`

Turning one agent's final text into a value the declared output schema accepts,
or into a typed failure. Governing design:
[structured output](/concepts/#structured-output).

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `StructuredOutputFailureCode` | const | models | Stable reasons a structured-output boundary failed. |
| `OutputIssueCode` | const | models | Stable reasons an individual structured-output issue was reported. |
| `OutputIssue` | class | models | One bounded issue raised while decoding structured output. |
| `StructuredOutputFailure` | class | errors | The terminal failure of one structured-output boundary. |
| `maxIssues` | const | constants | The most validation issues a failure or a correction prompt carries. |
| `jsonSchema` | const | conversions | The JSON Schema document for a declared output schema. |
| `digest` | const | identity | The canonical digest of a declared output schema. |
| `instructions` | const | prompts | The system teaching that tells a run what its final `output` must be. |
| `issuesDigest` | const | identity | The digest of one failure's rendered validation issues. |
| `correction` | const | prompts | The correction teaching appended when a candidate failed to decode. |
| `lastBalanced` | const | extraction | The balanced JSON container whose matching close ends last. |
| `candidates` | const | extraction | The candidates offered to the decoder, in the declared recovery order. |
| `decode` | const | decoding | Decodes one agent answer with the declared output schema. |

## TruncatedOutput

`import * as TruncatedOutput from "@smthrs/harness/TruncatedOutput"`

The truncation ledger: which bytes this run was handed as a fragment. A write
of bytes a call already reported as truncated is refused rather than warned
about, because there is no case in which writing a known fragment over a file
is what the caller meant.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `flagSuffix` | const | constants | The suffix a flow flags one named payload's truncation with. |
| `droppedSuffix` | const | constants | The suffix a flow states one named payload's discarded byte count with. |
| `flagKey` | const | constants | The bare flag a single-payload flow declares its truncation with. |
| `minimumBytes` | const | constants | Smallest payload, in UTF-8 bytes, the ledger records or refuses. |
| `retained` | const | constants | How many *distinct* captures one run carries forward. |
| `Capture` | class | models | One payload a flow returned after cutting it. |
| `Reuse` | interface | models | One input field found to carry the exact bytes of an earlier capture. |
| `captures` | const | conversions | Reads every truncated payload one settled call result declares. |
| `reuse` | const | conversions | Finds the first input field that carries an earlier capture verbatim. |
| `refusal` | const | constructors | States why a call carrying a known fragment was refused. |
| `retain` | const | conversions | Bounds the ledger to the `retained` most recent distinct captures. |
| `Ledger` | const | schemas | The ledger schema carried in controller state. |

## CallLedger

`import * as CallLedger from "@smthrs/harness/CallLedger"`

The call ledger: what this run has already asked, rendered every frame. It
carries no payloads: a line says `stdout=4096b`, never the four kilobytes.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `bound` | const | constants | How many settled calls the rendered ledger carries, newest last. |
| `width` | const | constants | How much of one call's subject or result digest a line may quote. |
| `members` | const | constants | How many members of a result object the digest may name. |
| `Entry` | class | models | One settled call, as one line of the run's history. |
| `Ledger` | const | models | The run's settled calls, oldest first and bounded to `bound`. |
| `subject` | const | conversions | What one call was about. |
| `target` | const | conversions | The first term of a value that names a target, or nothing. |
| `digest` | const | conversions | The one-line structural digest of what a call returned. |
| `payload` | const | conversions | The bytes one call carried into the tree. |
| `Settlement` | interface | models | One settled call, as the controller observed it. |
| `entry` | const | constructors | Records one settled call. |
| `settled` | const | conversions | How many calls this run has settled, given a ledger some of whose lines have aged out. |
| `remember` | const | combinators | Folds one frame's settled calls into the run's ledger, newest last. |
| `render` | const | conversions | Renders the ledger for the state section, or nothing when the run has settled no call yet. |

## NarrowedCheck

`import * as NarrowedCheck from "@smthrs/harness/NarrowedCheck"`

The narrowing ledger: which checks this run has run, and over which tree. A
check is only evidence for the tree it ran over.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `retained` | const | constants | How many distinct checks one run carries forward. |
| `maxTerms` | const | constants | Most distinct terms one recorded check may carry. |
| `targeting` | const | predicates | Whether a term names a target rather than a condition. |
| `names` | const | predicates | Whether a term names a target a reader would recognise as one. |
| `lex` | const | conversions | The terms of one call input in the order the canonical document states them. |
| `terms` | const | conversions | The distinct terms of one call input, sorted. |
| `conditions` | const | conversions | The terms of one call input that could be conditions its author added. |
| `Check` | class | models | One check this run has run, and the tree it ran over. |
| `Narrowing` | interface | models | A check this frame ran, paired with the broader one it stands in for. |
| `check` | const | constructors | Records one settled call as a check, unless its input is a payload. |
| `narrows` | const | predicates | Whether one call's terms are a strict narrowing of another's. |
| `find` | const | conversions | Finds the broadest check a completing frame narrowed and did not re-run. |
| `demand` | const | constructors | States which check a completion is standing on, and which one it is missing. |
| `Only` | interface | models | The reading a completion stands on, when the run holds no other reading of what it names. |
| `findOnly` | const | conversions | Finds a completion standing on the run's only reading of its own subjects. |
| `demandOnly` | const | constructors | States that the completion has one reading of its subjects, and asks for the other one. |
| `remember` | const | conversions | Folds this frame's checks into the run's ledger, newest last and bounded. |
| `Ledger` | const | schemas | The ledger schema carried in controller state. |

## CellValidation

`import * as CellValidation from "@smthrs/harness/CellValidation"`

Cell validation at the boundary. Nothing here executes anything, and nothing
here is a gate: the only outcome it can produce is a rejection the model is
asked to fix in this frame.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `Validation` | type | models | Either compiled source or a rejection, never both. |
| `normalize` | const | conversions | Rewrites a cell's top-level declarations so a persistent realm can re-run it. |
| `validate` | const | conversions | Parses one cell and reports everything the parse can decide. |

## UnmovedTree

`import * as UnmovedTree from "@smthrs/harness/UnmovedTree"`

The completion with nothing behind it.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `Unmoved` | interface | models | A completion taken over the tree the run was handed. |
| `find` | const | conversions | Whether a completing frame is finishing on the tree the run started with. |
| `demand` | const | constructors | States that the tree never moved, and names the two answers that end it. |

## UnresolvedFailure

`import * as UnresolvedFailure from "@smthrs/harness/UnresolvedFailure"`

The failing check a completion stepped around.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `exitStatusKey` | const | identifiers | The reserved key a flow reports its subject's exit status under. |
| `failed` | const | predicates | Whether a settled call's result reports a failing exit status. |
| `passed` | const | predicates | Whether a settled call's result reports a passing exit status. |
| `Displaced` | interface | models | A failing check, paired with the reading the run took in its place. |
| `revisits` | const | predicates | Whether a later check asks about the same subject as an earlier one. |
| `find` | const | conversions | Finds the failing check a completion replaced rather than answered. |
| `demand` | const | constructors | States which reading failed, which one replaced it, and what ends it. |

## Sufficiency

`import * as Sufficiency from "@smthrs/harness/Sufficiency"`

The evidence that is already complete.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `retained` | const | constants | How many distinct failing checks one run carries forward. |
| `Failure` | class | models | One check that reported a failure, and where the run was when it did. |
| `Ledger` | const | schemas | The failing checks this run carries, oldest first and bounded. |
| `remember` | const | combinators | Records one frame's failing checks against the epoch it ran in. |
| `Sufficient` | interface | models | A failure this run has answered, and the check that answered it. |
| `find` | const | conversions | Finds a failing-before, passing-after pair this frame has completed. |
| `observation` | const | constructors | States that the run holds both halves of its own evidence. |

## VacuousVerification

`import * as VacuousVerification from "@smthrs/harness/VacuousVerification"`

The proof that was already true before anything changed. This control is not
wired into `CellTurn`; the table describes what it does for a host that wires
it in.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `retained` | const | constants | How many pristine-tree passes one run carries forward. |
| `Pass` | class | models | One check that passed over the tree the run was handed. |
| `Ledger` | const | schemas | The pristine-tree passes this run carries, oldest first and bounded. |
| `remember` | const | combinators | Records one frame's passing checks, but only while the tree is untouched. |
| `stored` | const | conversions | The `{ flow, input }` pair a cell stored as its verification, if it stored one this module can read. |
| `find` | const | conversions | Finds the pristine-tree pass a stored verification is standing on. |
| `observation` | const | constructors | States that the stored proof was already green before anything changed. |

## VariablesPanel

`import * as VariablesPanel from "@smthrs/harness/VariablesPanel"`

The variables panel: what the realm holds, stated every frame.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `bound` | const | constants | How many names the panel prints before it starts counting instead. |
| `Binding` | class | models | One name the realm holds, with the cheap facts a probe can read off it. |
| `Stamp` | class | models | One name the realm holds, with the frames that first and last bound it. |
| `Ledger` | const | models | Every name the realm holds, with the frames that bound it. |
| `stamp` | const | combinators | Re-stamps the panel against the bindings a frame closed on. |
| `render` | const | conversions | Renders the panel for one frame's prompt. |

## QuickJSSandbox

`import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"` (not
re-exported from the root)

The QuickJS-WASM sandbox binding. The cell runs inside a QuickJS interpreter
compiled to WebAssembly, a genuinely separate JavaScript realm with no
reference to the host's globals, prototypes, or module loader. The same
single-file variant runs unmodified on Node and in a browser. Which QuickJS
build is compiled is a seam: a host whose runtime forbids compiling WebAssembly
from bytes, such as Cloudflare's workerd, provides `Variant` instead and names
a build whose module came from its toolchain.

| Export | Kind | Category | Summary |
| --- | --- | --- | --- |
| `cacheSuccessful` | const | constructors | Caches only a successful asynchronous load; a rejection may be retried. |
| `VariantService` | interface | models | The QuickJS build the sandbox compiles. |
| `Variant` | class | services | The QuickJS build the sandbox compiles. |
| `layerVariantLive` | const | layers | Provides the single-file build, which Node and a browser both compile. |
| `layerVariant` | const | layers | Provides a build the host names. |
| `ComputeClockService` | interface | models | Synchronous monotonic-enough clock required by QuickJS's interrupt callback. |
| `ComputeClock` | class | services | Synchronous monotonic-enough clock required by QuickJS's interrupt callback. |
| `layerClockLive` | const | layers | Provides the browser-safe host clock behind the QuickJS clock seam. |
| `loadModule` | const | constructors | Loads a QuickJS module through the sandbox's typed failure boundary. |
| `makeWithVariant` | const | constructors | Constructs the QuickJS sandbox over the build the host names, compiling the WebAssembly module once. |
| `makeWithClock` | const | constructors | Constructs the QuickJS sandbox over the single-file build. |
| `make` | const | constructors | Constructs the QuickJS sandbox with the live clock layer. |
| `layerWithVariant` | const | layers | Provides the QuickJS sandbox over the build the host names. |
| `layer` | const | layers | Provides the QuickJS sandbox over the single-file build. |
