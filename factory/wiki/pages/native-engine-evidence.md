# Native execution evidence and observation

The host copies the native engine journal into the control run. The app's run card decodes those copies as recorded evidence. Observation completeness is tracked separately from the run's own verdict.

## Project native records into the control run

The private `EngineJournalProjection` helper copies the durable engine journal into the existing control journal without adding a database, table, public export or gateway procedure. Each `catchUp` first records `control.engine.bound`, the one record that associates a control run with its native root.

Native events arrive as `control.engine.event` envelopes carrying the native execution ID, generation, sequence, identities, event type, payload and metadata. An encoded result appears only if the committed journal entry contains it. `control.engine.projection-gap` records a rewind, compaction or read failure; a gap is never a fabricated completion or passing check.

## Decode with the owning contracts

The run card reads `control.engine.event` from its gateway `run-events` projection and lists recorded native executions beside recorded agent turns. The app's `EngineTrace` module re-exports `@smthrs/gateway/EngineTrace`, which is shared with the terminal monitor. Decoding reuses `@smthrs/engine-store/RunState`, `@smthrs/flow/Flow.ResultEncoded` and `@smthrs/journal/EngineEvent`.

Attempt identity includes execution ID, native rewind generation, step digest and attempt number, so a rewind cannot replace a prior generation's result. A native execution returning `{ passed: false }` is shown as that value, not as a passing check. Only recorded parent IDs establish nesting; ambiguous children stay at the root and cyclic evidence is kept separate.

## Inspect through the existing trace flow

Selecting a native execution uses the same `runs.trace.select` flow, persisted selection, cursor and view as an agent frame. The debugger shows recorded child executions, attempts, inputs, results, failures and the original journal envelope. Native execution IDs are not treated as control run IDs for `runs.open`.

## Finish observation separately from the verdict

The host supervisor records `control.engine.projection-started` before an accepted launch returns and `control.engine.projection-settled` after the native terminal commit is drained. Both carry `{ version: 1, executionId, generation }` and describe reader completeness, not another execution outcome.

The run pump preserves the real terminal phase while it keeps reading until the matching generation settles. A transport refusal or the quiet deadline leaves a visible observation error without changing the run's verdict. `run-trace.payload.observationError` keeps that reader failure separate from `error`, and the existing retry gesture can try the observation again.
