# @smthrs/flow

## Unreleased

### Breaking Changes

- Two kinds of node re-key once, because their keys did not state what they now state. A call whose callee declares a JSON string (`Schema.fromJsonString`) in its payload, success or error schema folds in what the string decodes to. A `catch` with an error schema that `effect` can represent folds in a representation identity of the filter, which tells `Schema.Null`, `Schema.Undefined` and `Schema.Void` apart. A run recorded before the change with such a node no longer matches its recorded plan on resume. Every other node keeps its key. ([#4623](https://github.com/smithersai/smithers/issues/4623)).

### Added

- `FlowRuntime.StoreUnavailable` is the typed infrastructure failure returned
  when a durable engine cannot record a step. It carries `executionId` and
  code `store_unavailable`; flow and engine execute contracts declare it.

- `Action.CurrentRedispatch` is `true` while an action body re-runs an
  attempt an earlier execution started and never settled, so a body that
  cannot repeat its effect silently can count or reconcile the repeat.
- `SpanFailure`, moved here from `@smthrs/model`: spans whose failures export
  only a tag and a lowercase token code. `Action.execute` and each flow's
  `<tag>.execute` span now end this way, so an action's failure text, such as
  a provider error quoting a prompt, never reaches a trace.
- `Action.CurrentFence` carries the running attempt's ownership fence
  (`Action.Fence`: run, step key digest, attempt, owner) to an action body. A
  durable engine supplies it, and it changes when another incarnation adopts
  a crashed attempt or a failed attempt is retried. An engine without durable
  ownership leaves it `undefined`. `@smthrs/run-store`'s `RunStore.owned`
  turns it into a condition for the body's own SQL writes.

- Canonical `Flow.make(tag, options)` accepts typed prompt declarations lowered
  to ordinary actions with explicit host implementations (#2271). Empty tags
  and declarations without exactly one callable body or prompt are refused.

### Fixed

- `RetryPolicy.decide` treats a failure's `retryAfterMillis` as a floor under
  the policy's backoff instead of a replacement for it. A server that kept
  answering `Retry-After: 0`, or a date in the past, made the engine re-dispatch
  the step with no delay on every attempt, without end under the default
  policy; the attempt now waits the longer of the hint and the backoff.
  ([#4627](https://github.com/smithersai/smithers/issues/4627)).
- `flow.start` and `flow.ensure` declare `FlowRuntime.StoreUnavailable` and
  `FlowRuntime.ExecutionIdentityConflict`, the failures they already raised as
  `execute` with `discard: true`: an `ensure` that reuses a key with a different
  payload is the conflict, and a store that cannot record the run is the
  outage. Before, a caller that handled the two declared errors and treated the
  effect as infallible met a failure it could not have written a handler for.
- `Fault` classifies `CancelRequestFailed` by code: `cancel_request_failed`, a
  store that could not record a cancellation the caller can retry, is `infra`,
  so it is retried and then parked instead of stopping the run as a `bug`;
  `unsafe_interrupt_unsupported` stays `bug`.
- Recovered flows could dispatch before their action handlers finished building and report `unresolved_action`. Interpreter registration now waits for its implementation layers.

- Publish node outcomes only after their settlement records persist. Join journal
  reads isolate their waiting annotation, and joins request loser interruption
  before persisting the cancellation snapshot.
- Reject enumerable symbol payload keys instead of dropping data, and copy
  array lengths from inert descriptors without invoking proxy getters.
- Accepted shrinking retry factors continue until exhaustion or expiry. Invalid
  elapsed readings report exhaustion rather than claiming expiration.
- Deadline diagnostics support starts outside the JavaScript Date range.
- Human-task timeouts whose absolute due time exceeds the durable timer range
  fail as `request_invalid` before parking. Uses the catalog’s `@smthrs/flow`
  retry, durable sleep, and human-wait primitives.

- Breaking: `RetryPolicy.decide` reads a failure's Retry-After hint from
  `retryAfterMillis`, the field `@smthrs/model`'s `ModelError` carries a
  provider's `Retry-After` in, instead of `retryAfterMs`, which no failure
  carried. A rate-limited model step now waits as long as its provider asked.

- A call's step key no longer moves with the installed `effect` release: the graph takes each callee's schema identity from `@smthrs/plan`'s `Node.schemaIdentity`, which prints what `effect@4.0.0-rc.115` printed. ([#3839](https://github.com/smithersai/smithers/issues/3839)).
- Preserve dynamic flow expansion and declaration source mappings when a bundled host loads project flows. ([#1991](https://github.com/smithersai/smithers/issues/1991)).

## [Unreleased]

### Changed

- The package reference page now lives at `docs/reference/flow.md`, written by
  the `referenceDocs` target. The `docs/pages/api/flow.md` page,
  `scripts/docs.mjs` and the `docsPages` target described under 0.1.0 no
  longer exist. (`flows-flow/maintainability/7`)

### Removed

- `FlowInstance.awaitedDeferreds`. No runtime read the set, and
  `DurableDeferred.await` no longer writes it. A completion wakes a parked run
  through `FlowRuntime.resume`, unchanged. (`flows-flow/simplicity/1`)

### Fixed

- Nested explicit `Node.andThen` continuations now carry only their nearest
  success barrier, preserving transitive ordering while making continuation
  edges and `Pending` inputs linear for right-nested chains. This is a
  pre-freeze key-affecting change: affected compiled keys/digests change and
  require a newly approved plan; existing executions are not rewritten.
  Structural `.andThen`/`.then` node IDs retain their spelling and durable
  dispatch identity. Their depth growth and quadratic total ID bytes are now
  documented, with bounded trampoline rounds or `.child()` boundaries for long
  chains. (`flows-flow/performance/1`, `flows-flow/performance/5`)

- Explicit `Node.andThen` now gates its entire next subtree on upstream
  success. Nested combinations, maps, inline flows, branches, catches and
  sequences no longer start actions before the first node finishes or after
  it fails. Graph drafts propagate that prerequisite to every descendant.
  Affected compiled keys/digests change and require a newly approved plan;
  old executions are not silently rewritten. `bindPlanned` retains its data-
  dependency semantics and can expose independent work concurrently. This
  does not close compiled/public scheduler parity or unfinished-run migration.

## [1.0.0-rc.0] - 2026-08-31

### Breaking Changes

- `Flow.make` now requires `body`. A flow with nothing to plan is a category
  error under `docs/specs/Concepts/Unified Flow Authoring.md`: that work is an
  `Action`. Every declaration therefore carries a body, and `Flow.Any.body`
  is no longer optional.
- Removed `toLayer` from the flow surface. Actions carry implementations,
  attached separately with `Action.toLayer`; flows carry bodies, driven by
  `Interpreter.layer`. Registering a behavior under a flow tag is the runtime's
  own seam and is now internal to this package.
- Removed `Flow.Bodied`, which existed only to describe a flow that had a body.
  `Flow.Flow` is that type now.
- Removed `Flow.BodyDefinesBehavior`, the defect a bodied flow raised when a
  second, opaque behavior was attached to it. There is nothing to attach.
- Removed the `missing_body` code from `Interpreter.InterpreterError`.
  `Interpreter.layer` takes a flow that has a body by construction.
- `CancelRequestFailed` now carries the `_tag`
  `@smthrs/flow/CancelRequestFailed`. It was the one error in the package still
  reading `flows/engine/CancelRequestFailed`, a name that was never even the
  old package's. A `_tag` is wire format and freezes at the RC.
- The runtime type identifiers moved out of effect's brand namespace. Every
  `~effect/flow/...` marker now reads `@smthrs/flow/...`, including the
  exported `DurableDeferred.TokenTypeId` and `DurableQueue.TypeId`.
- Execution ids derived from a declared `idempotencyKey`, and from the default
  ambient source, now hash a framed `JSON.stringify([flowTag, key])` tuple
  instead of an unframed `` `${tag}-${key}` `` string, so a tag and a key that
  spliced onto one preimage no longer address one durable invocation. Ids
  derived before this change do not match ids derived after it.

### Added

- Added `@smthrs/flow`, the flow authoring model split out of
  `@smthrs/engine`: `Flow`, `Action`, `RetryPolicy`, `DurableDeferred`,
  `DurableClock`, `DurableQueue`, `StepIdentity`, and their schemas, errors,
  results, boundaries, and combinators.
- Added `FlowRuntime`, the execution contract those APIs are written against.
  It replaces the direct dependency the authoring modules had on the engine's
  `FlowEngine` module, so the dependency now runs `@smthrs/flow` then
  `@smthrs/engine`. The service formerly exported as `FlowEngine.FlowEngine` is
  `FlowRuntime.FlowRuntime`, `FlowEngine.FlowInstance` is
  `FlowRuntime.FlowInstance`, and `FlowEngine.annotateWaiting` and
  `FlowEngine.FlowCycleDetected` moved with them.
- `Graph.build` copies an authored `Node.priority` onto `NodeDraft.priority`,
  so `PlanScheduler` orders ready work by it. A node inherits the priority of
  the nearest enclosing node that declares one, and a node that declares its
  own keeps it. Priority stays out of key material.
- Added `Action.InfraInterruptRetriesExhausted`, the typed identity an
  exhausted `interruptRetryPolicy` now dies with. It carries the action name,
  the attempts made, and the final `InfraInterrupt` including its `reason`,
  which the previous bare-string defect discarded.
- Added the `invalid_deadline` code to `Sleep.SleepRequestInvalid`.
- Added the `duplicate_node_id` code to `Interpreter.InterpreterError`, and a
  matching build diagnostic, so two nodes that would answer to one dispatch
  address are refused instead of resolving last-write-wins.
- Added the `deferred_mismatch` code to `DurableDeferred.TokenInvalid`.
- Added the stable `poll_exhausted` code to `Poll.PollExhausted`, and a
  constructor default for the `code` of `FlowRuntime.FlowCycleDetected` and
  `FlowRuntime.FlowExecutionNotFound`.
- Added documented size bounds to `HumanTask`: `maxAttemptBudget`,
  `maxSchemaDepth`, `maxSchemaNodes`, `maxAnswerNodes`, `maxDiagnosticChars`,
  and `maxRetainedRejectionChars`.
- Added package-owned documentation. `docs/api.md` plus the JSDoc on every
  exported declaration generate `docs/pages/api/flow.md` through
  `scripts/docs.mjs`, declared as the `docsPages` target, so the published page
  cannot drift from the source it describes.

### Fixed

- `RetryPolicy.make` validates its bounds and throws a `RangeError` naming the
  offending field, and copies and freezes `nonRetryable`. `nextDelay` is total
  for a policy that never went through `make`: a jitter ratio out of range no
  longer returns a negative delay, and a non-finite bound, attempt, elapsed
  time, or computed delay answers `None` instead of handing the engine a `NaN`
  duration to sleep for.
- `Sleep.action` refuses a `millis` or `until` that is not a length of time.
  `Infinity` armed a timer nobody wakes, and `NaN` did not wait at all while
  leaving a waiting annotation whose `wakeAt` serialized to null.
- `HumanTask` compares `enum` membership structurally, so an object-valued or
  array-valued member can be answered. It previously compared with `===`, which
  refused every answer and ended the task `rejected`.
- `HumanTask` refuses a `schema` supplied with a kind other than `json`, and
  refuses a malformed `required` or `nullable`, instead of silently dropping
  the constraint.
- `DurableDeferred.into` propagates `interrupted` to the parent instance beside
  `suspended`, so a recorded interruption awaited through `raceAll` settles as
  a durable outcome instead of being misread as an external suspension.
- `DurableDeferred.done` refuses a token that names a different deferred than
  the one it was submitted through, so an exit cannot be written into one
  deferred's row under another's schemas.
- `DurableDeferred.TokenInvalid` carries the parse failure and a bounded
  excerpt of the offending token instead of one fixed sentence.
- `DurableQueue.makeWorker` validates `concurrency`, reports a malformed item
  token at error level instead of dropping the item behind one warning, and
  backs off instead of spinning when `take` fails repeatedly. Both log
  annotations now name `@smthrs/flow` rather than `effect`.
- `Graph.placementConflicts` compares directives structurally instead of
  through `JSON.stringify`, which erased a present `undefined`, mapped `NaN` to
  `null`, and threw on a `BigInt`.
- `Flow.isResult` requires an own data property carrying the exact marker and a
  known result tag, so a forged or getter-backed value no longer passes.
- `Interpreter.childExecutionId` finds the versioned key prefix instead of
  slicing a hardcoded length.
- Corrected the module headers in `Action/Errors.ts` and `RetryPolicy.ts`,
  which claimed the error tags keep an `@smthrs/engine/` prefix that no tag in
  either file uses, and the `FlowInstance.awaitedDeferreds` JSDoc, which
  asserted preemption behaviour no runtime in this repository implements.
- Normalized the inherited `@since 4.0.0` tags, which named effect's version
  rather than any version of this package.
