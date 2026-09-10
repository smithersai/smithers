# /harness

## [Unreleased]

### Removed

- Removed the reserved provider-tool loop. `Steering.ActivateTools` and the
  `activatedToolNames` member of `Steering.Drain` and `Steering.DrainRecord`,
  `ContextWindow.activateTools`, and `appendTurn`'s tool-result parameter are
  gone: nothing in this package produced or read them, and every implementer of
  `Steering.Source` had to write an empty array to satisfy the type. A journal
  written before this still decodes, because a `DrainRecord` that carries the
  key drops it. `ContextWindow.activeTools` and
  `AgentEvent.TurnOpened.activeToolNames` stay for a foreign-adapter loop to
  fill, and stay empty until one does. `appendTurn(self, message)` now takes
  two arguments.
- Removed `ContextWindow.contextWindowTokensFor`. The provider window table
  belongs beside the catalog it describes and now lives in `@smthrs/model` as
  `ModelCatalog.contextWindowTokensFor`. `CellTurn` still resolves a seat with
  no host callback through it, and `@smthrs/agent` still re-exports it as
  `SeatResolver.contextWindowTokensFor`.

### Added

- Added `Transcript.controlEventPrefix` and `Transcript.ControlEventType`.
  `Transcript.validateJournal` selects the entries it validates by that prefix,
  and the session that writes them lives in `@smthrs/agent`; typing the writer
  against `ControlEventType` makes a rename on either side a compile error
  instead of silently validating nothing.

### Changed

- **Breaking journal format 2.** Summary text is user context. Controller state,
  session journals, and model-key inputs now carry this harness format version.
  Resuming an older state or session journal fails with typed
  `HarnessError` code `incompatible_journal` before any live model call. Start a
  new run; rc.0 does not promise journal compatibility. Historical transcript
  display remains available and renders summaries as user messages.

### Fixed

- Keep `Cell.CallResult`'s historical encoded schema identity while validating
  success/failure invariants in the constructor and boundary decoder. Adding
  the redundant schema filter had changed every agent sealed cell-call key.
  Valid recorded results retain their keys; malformed records still fail.

## [1.0.0-rc.0] - 2026-09-01

The first published release of this package. `0.1.0` was never published; the
wave-by-wave record of how this loop was built is in
[`HISTORY.md`](./HISTORY.md).

### Added

- **The cell-first controller.** `CellTurn` runs one frame as
  `model -> generated cell -> realm evaluation -> individually durable flow calls -> transition`,
  and decides continuation from the transition the cell returned rather than
  from provider tool calls. `Cell` models the source, its digest, the
  `continue` / `complete` / `park` transition, the outcomes of a cell that threw
  or never produced one, and the identity carried by every call made inside it.
- **The REPL realm.** A run holds one realm for its whole life, so the realm is
  the run's memory and what a cell prints is what the next model turn reads.
  `Sandbox` is the port; `QuickJSSandbox` is the QuickJS-WASM binding, which
  runs the same single-file build on Node and in a browser, and
  `VariablesPanel` renders what the realm holds and when each name was last
  bound.
- **Flows as the only capability primitive.** A cell is handed exactly one
  authority, `ctx.call(flowName, input)`. `FlowBinding` pairs an ordinary flow
  declaration with its handler and composes ordered sources into a catalog that
  refuses two implementations under one name; `CellCalls` resolves each call
  against the registry, refusing anything whose declaration moved since the
  model was shown the catalog.
- **Durable boundaries.** Every `ctx.call` is its own keyed, journaled,
  permission-gated activity, and `EngineLike.record` is the same mechanism for
  the controller's own nondeterministic reads: the workspace measurement, the
  checkpoint mint, the frame outcome, and the turn-boundary steering drain.
- **Bounded context.** `ContextWindow` assembles the immutable, zoned window;
  `Compaction` selects and applies a deterministic summary; `Tokens` estimates
  and combines the accounting; `Transcript` projects journal entries back into
  model-facing state; `CallLedger` is the run's automatic ledger of settled
  calls, rendered in every frame.
- **Completion demands.** `NarrowedCheck`, `UnmovedTree`, `UnresolvedFailure`,
  `Sufficiency`, `TruncatedOutput` and `VacuousVerification` are the controls
  that answer "did this run actually do the work it says it did".
  `VacuousVerification` ships unwired: `CellTurn` does not read it and no run is
  told anything by it.
- **The workerd seam.** `QuickJSSandbox.Variant` lets a host name the QuickJS
  build instead of compiling one from bytes, which is what a runtime that
  forbids `WebAssembly.compile` needs.
- **Structured output.** `StructuredOutput` decodes an agent's final text into a
  declared schema, spends a bounded correction budget, and reports a typed,
  coded failure.

### Changed

- Every failure class a caller branches on is a closed union with a stable code:
  `HarnessError.HarnessErrorCode`, `Cell.CallFailureCode`,
  `Sandbox.SandboxErrorCode`, `Transcript.TranscriptErrorCode` and
  `StructuredOutput.StructuredOutputFailureCode`.
- A failed `ctx.call` **resolves** with `{ ok: false, error: { code, message, hint } }`
  instead of throwing, so the recovery branch the model already wrote still
  runs. `Cell.callFailureHint` names the one move that recovers each class.
- Nothing a frame shows is cut silently. Every bound states what it dropped and
  the id that brings it back, and every bound is measured in UTF-8 bytes.
- `memoryBytes` is a **run** budget rather than a per-frame one, enforced by the
  panel probe at each frame's close, because the realm outlives its frames.

### Removed

- The provider-tool-call loop and the modules that existed only to serve it:
  `LegacyHarness`, `Harness`, `Turn`, `Tools`, `Assemble`, `AgentStep`,
  `Elaborate`, `FlowTool` and `Visibility`. Foreign CLI adapters implement the
  `Agent` service in `@smthrs/agent` instead of the neutral `Harness` contract
  this package used to declare.
- The filing authoring surface: `Cell.Mode`, `Cell.defaultMode`,
  `Cell.transition`, `Cell.renderEntry`, `StateManifest`, `Sandbox.evaluate`,
  `Sandbox.Evaluation`, `Sandbox.makeRestricted`, `Sandbox.layerRestricted`,
  and `Steering.drainBoundary`. `Cell.Continue`'s `state`, `context`, `render`
  and `recall`, and `Cell.Complete`/`Cell.Park`'s `state`, survive as
  **decode-only** optional fields: nothing populates them and nothing reads
  them, and they exist so journals written before the cell-first loop still
  decode.
- `HarnessErrorCode`'s thirteen unraised members, `invalid_step`,
  `lazy_tool_prompt_metadata`, `elaboration_failed`, `unknown` and the nine
  `adapter_*` codes. Nothing in this repository constructed them, and a code the
  package cannot raise is a promise it cannot keep. An adapter error family
  belongs beside the adapter in `@smthrs/agent`.

## [0.1.0]

### Added

- Initial release.
