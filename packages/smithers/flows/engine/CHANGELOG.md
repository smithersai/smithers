# @smthrs/engine

## [Unreleased]

### Fixed

- Execute adapters preserve the typed `FlowRuntime.StoreUnavailable` failure
  from durable stores, so callers can answer unavailable and retry the same
  execution id. Step interruption and caller cancellation remain interrupts.

- The first dispatch of an action whose retry policy declares `expirationMs`
  no longer logs the warning `no durable retry origin`. A durable store finds
  no attempt row for an action's first dispatch, as it does after retention
  pruned its history, and cannot tell the two apart, so the record is now
  Debug for both.

- A keyed sealed action's step key includes what a JSON string (`Schema.fromJsonString`) in its success or error schema decodes to. Key encoding 4, the new default, hashes `Node.representationIdentity` version 3; `FlowEngine.keyEncodings` is now `[4, 3, 2, 1]`. Under encodings 3, 2 and 1 two declarations that differ only in what the string decodes to derive one key, so an outcome recorded under the old shape replayed under the new one. Every keyed sealed key moves, because a key names its encoding. A run finds the records it wrote under an earlier encoding again, which includes a record written before such an edit to its declaration; a cross-run cache row written under an earlier encoding misses once. ([#4623](https://github.com/smithersai/smithers/issues/4623)).

- A sealed action's step key no longer moves with the installed `effect` release: its declaration digest hashes `Node.representationIdentity` instead of `SchemaRepresentation.toJson`. A declaration whose success or error schema carries `Schema.brand` re-keys once. ([#3839](https://github.com/smithersai/smithers/issues/3839)).

- Action retry exhaustion and expiration preserve the final declared failure
  for typed recovery. Retry docs now describe this behavior and the action
  span annotations `retry.stopReason` and `retry.attempt`.

- The memory engine follows trampoline membership and child ownership when
  cancelling through any round ID. Requests persist across the gap before a
  successor exists, and children admitted after cancellation cannot dispatch
  their bodies. Completed round results remain readable; normal cancellation
  requests do not wait for uninterruptible user cleanup.

## [1.0.0-rc.0] - 2026-08-31

### Added

- Added the coded engine refusals `FlowEngine.FlowNotRegistered`,
  `ExecutionIdentityConflict`, `SuspendedResumeGaveUp`, and
  `SnapshotBoundaryRequired`, so an admission or configuration defect carries a
  stable `code` and structured fields instead of a bare string or a generic
  `Error`.
- Added `FlowProxy.InvalidFlowTag` for a flow tag that is not well-formed
  UTF-16, which route construction previously reported as a name collision.
- Added package-owned documentation under `packages/engine/docs`, generated
  into `docs/pages/api/engine.md` by the `//packages/engine:docsPages` target.
- Added the `FlowProxyServer.ExecutionIdScope` option to rewrite client
  execution identity for execute, discard, and resume requests in both derived
  server transports.

### Breaking Changes

- Split the flow authoring model out into `@smthrs/flow`. `Flow`, `Action`,
  `RetryPolicy`, `DurableDeferred`, `DurableClock`, `DurableQueue`, and
  `StepIdentity` are no longer exported here; import them from `@smthrs/flow`.
- The `FlowEngine.FlowEngine` service and `FlowEngine.FlowInstance` moved to
  `@smthrs/flow` as `FlowRuntime.FlowRuntime` and `FlowRuntime.FlowInstance`,
  together with `annotateWaiting`, `WaitingAnnotation`, and
  `FlowCycleDetected`. `@smthrs/engine` implements that port; the dependency
  direction is now `@smthrs/flow` ← `@smthrs/engine`, with no cycle.
- `FlowEngine.FlowInstance.initial(flow, executionId)` is now
  `FlowEngine.makeInstance(flow, executionId)`.

### Changed

- Broke the single `FlowEngine.ts` module into a `FlowEngine/` folder:
  `Encoded.ts`, `SnapshotBoundary.ts`, `FlowInstance.ts`, `ActionKey.ts`,
  `make.ts`, `layerMemory.ts`, and the barrel.

- Renamed `Flow.withCompensation` to `Flow.withRollback` in the new
  `@smthrs/flow` authoring package.
- Moved `BoundaryMode` beside the `Action` model it configures in
  `@smthrs/flow`.
- Split the `Flow` and `Action` implementations into focused modules while
  moving their public imports to `@smthrs/flow`.

### Fixed

- Scoped sealed action keys to one run until the composition declares its
  complete layer and capability identity.
- Made in-memory action execution single-flight, snapshotted replay payloads,
  and encoded deferred and clock addresses as injective tuples.
- Made journal lineage and trampoline-round identities injective and added
  typed validation for malformed round bounds.
- Refused colliding proxy operation names and encoded every HTTP flow tag as
  one case-preserving URL-safe segment.
- Made diagnostic rendering total, bounded, accessor-free, and redacting so a
  hostile failure cannot replace the original cause.
- Scoped `layerMemory.poll` to the flow it is asked about. It ignored its flow
  argument and answered with another flow's `Flow.Result` under the caller's
  declared schemas; an execution belonging to a different declaration now
  answers `Option.none()`, matching the durable driver.
- Refused a reused execution id whose payload differs in the in-memory engine,
  so the memory and durable implementations of one `Encoded` seam agree on the
  same request.
- Clamped a persisted retry origin that sits ahead of the local clock. A skewed
  or corrupt origin made the first failed attempt give up as `expired` with the
  schedule-to-close budget unconsumed; the clamp is logged.
- Ignored an unusable `actionLatestAttempt` from a driver. A non-integer value
  flowed into the attempt identity and the backoff ladder; the engine now falls
  back to its own attempt and logs the rejected value.
- Refused an irreversible keyless action before sleeping its backoff instead of
  after it.
- Populated `Action.UncanonicalIdempotencyKey.path` with the offending path
  inside the declared identity. It was the constant `"$"` on every failure.
- Logged a defect from a body served over RPC. `layerRpcHandlers` logged
  nothing, while `layerHttpApi` logged and annotated every one.
- Derived `layerHttpApi`'s three operation names from
  `FlowProxy.operationAddresses`, the one helper every other proxy site
  already used.
- Documented the `Encoded` seam accurately. Only `actionExecute`,
  `deferredResult`, `deferredDone`, and `deferredDoneIfWaiting` carry encoded
  values; `execute` and `poll` return decoded results the implementation
  produced itself.

## [0.1.0] - 2026-08-05

### Added

- Added the vendored durable flow engine with caller-selected execution
  identity, caller-computed action keys, explicit infrastructure-interrupt
  retry, durability tiers, snapshot boundaries, and signal-assisted resume.

### Fixed

- Kept coverage thresholds on the explicit coverage command so ordinary
  `vitest run` remains the package test gate.
