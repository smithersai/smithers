# @smthrs/testing

## [1.0.0-rc.0]

### Added

- Added the testing and conformance package: scoped Vitest and deterministic
  layer adapters, core graph and journal assertions, typed fixture replay, host
  conformance, and score gates.
- Added executable identity, interruption, replay, and race conformance pins
  with restartable in-memory reference-engine coverage.
- Added production-only Smithers parity accounting: real owning-package tests
  are linked and missing runtime contracts are explicit gaps.
- Added stable `TASK_TIMEOUT` and `RALPH_MAX_REACHED` typed failures.
- Added package-owned documentation: `docs/api.md`, `docs/concepts.md`, and the
  generated site page `docs/pages/api/testing.md`, which replaces the
  hand-maintained module table in `README.md`. `@smthrs/testing` was the last
  published name with no page on the documentation site.
- Added `docs/guide.md`, projected by the package's generator into the site's
  Testing guide. That guide described the fixtures each package under test
  ships and never named this library, so the published testing package was
  reachable from the documentation site only by already knowing it existed.
- Added `Fixture.index`, a memoized digest-keyed lookup over a fixture's
  recorded calls, and `ScoreGate.validateSamples`, the sample validator a suite
  runner needs when it constructs samples itself.
- Added `ExecutionConflictError` and `FixtureEncodingError`, and the
  `execution_conflict`, `fixture_not_encodable`, and `effect_kind_mismatch`
  codes.
- Added `RestartableEngine.restartAndResume` beside `killAndResume`.
- Added 100% coverage thresholds, the workspace norm the release policy's
  tooling baseline states. The floors this package carried were below it, and
  what they excused was the poison layer, the reference engines' cancellation
  paths, and the error construction that decides whether an assertion is sound.

### Fixed

- Cyclic fixture snapshots keep their own record and array references without
  freezing the caller's values.
- Structural assertions compare equal deeply nested values correctly and
  distinguish enumerable symbol-keyed record fields.
- Host conformance probes in one runtime reserve distinct scratch directories
  when concurrent suites share a filesystem and use the same random seed.

- Replay misses after a heartbeat now end with an `unrecorded` stream error
  instead of hanging. Other handler defects also finish the HTTP response.
- Killed restartable engines can no longer write execution state. Late step
  results preserve terminal outcomes and journals after cancellation. Waiting
  callers also settle if the engine closes before its worker starts.
- Fixed `Divergence`: its canonicalizer collapsed every non-plain object to
  `{}`, so two different `Date`s, a `Map` beside a `Set`, `-0` beside `0`, and
  `NaN` beside `Infinity` compared equal and a drifted fixture passed. It also
  ignored `entry.index`, recursed forever on a cyclic value, and threw an
  untyped `TypeError` on a `BigInt` out of a typed error channel.
- Fixed `TestLayers.poisonedService`: a data-property read such as `Path.sep`
  answered with a function instead of failing, and every method failed
  recoverably, so an ordinary `Effect.catch` fallback let `expectPure` report an
  impure plan as pure. Every read now raises a defect.
- Fixed `JournalAssertions`: `.effect(key)` matched an ordinary step,
  `idempotencyKey` reported `missing_idempotency_key` for an effect that never
  ran and a mismatch for an entry carrying no key at all, `executed` reported an
  empty `actual`, and `terminal` read the last array element while `prefix`
  answered by `entry.index`.
- Fixed `RestartableEngine.killAndResume`, which performed a restart. The
  orderly path is now `restartAndResume`, and the hard-kill state a lease-based
  reclaim recovers from is reachable and covered.
- Fixed the conformance adapter's cancellation path: it used
  `FlowRuntime.interruptUnsafe`, which the durable engine refuses by contract,
  so no interrupt pin could have run against the engine that ships.
- Fixed `Plan.render` and `PlanAssertions`, which sorted with locale-dependent
  `localeCompare`; a snapshot containing a non-ASCII node id reordered on a
  machine with a different default locale.
- Fixed `src/Vitest.ts`, which wrote `scoped` into `@effect/vitest`'s own
  exported `it` and so replaced that library's registrar for every other test
  file in the worker process.
- Fixed the record-and-replay aliasing: the request is projected when the stream
  is acquired rather than after it ends, each event is snapshotted at emission,
  and tool `parameters`, `stopSequences`, and `itemIds` are copied.
- Fixed `UnscriptedModelError`, which carried the entire model request -- system
  prompt, whole conversation, every tool schema -- into a defect a runner prints
  in full.
- Fixed the host suite's scratch file, a fixed relative path written and
  force-deleted in the caller's working directory.
- Fixed the `./Vitest` export map entry, which advertised a CommonJS path that
  throws from inside vitest, and stopped emitting the dead CJS artifact.
- Fixed `ScoreGate`: a suite with no gates validated no scores and graded a
  wholly inconclusive or empty run as passed, samples were attributed by the
  runner rather than bound to the case that produced them, and `Math.min(...)`
  threw a `RangeError` above the engine's argument-count limit.
- Fixed the reference engines, which accepted a duplicate execution id and
  silently ran the original flow on the original payload, and which disagreed
  about generated execution ids.
- Fixed the 24 shipped JSDoc citations that named documents absent from the
  repository; the designs are recorded in `docs/concepts.md`.
- Removed the test-owned omnibus capability simulator and false production
  parity claims.
- Replaced the hand-written polling loops in the interrupt and race pins with
  bounded Effect schedules under a live clock, and bounded the conformance
  adapter's publication confirmation, which was an unbounded recursion.
- Moved `ParityManifest` to `test/support/`. It is 0.x migration bookkeeping,
  not a testing-library API, and it had no consumer outside this package's own
  suite. Under `src/internal/` the null-mapped `./internal/*` entry hid it from
  resolution while `files` still shipped the source and the six artifacts the
  build emitted from it; `test/` is neither packed nor built.
- Fixed the two `Fixture` declarations that shared one name. The hand-written
  interface and the schema stated optionality two different ways, so under
  `exactOptionalPropertyTypes` a decoded fixture and the interface `decode`
  claims to return were not the same type, and only the one direction a
  signature happened to use was checked. The schema now states every optional
  field the way `ModelLike` does, `test/FixtureSchema.test.ts` compares the key
  set of both shapes at every level, and the one place the schema is
  deliberately narrower, a tool's `parameters` being JSON rather than `unknown`,
  is stated and pinned by a decode that refuses.
- Fixed `MemoryEngine.interrupt`, which cancelled nothing when it arrived before
  the worker fiber had been recorded. The reference engine used to certify
  interruption held the fiber in a mutable field written after the fork, so an
  interrupt in that window marked the execution aborted and left the worker
  running. The fiber is published through a `Deferred`, so an interrupt waits
  for it.
- Fixed the `kind` on a suspended or aborted journal entry, which was recovered
  by searching the flow for the step key and could answer with a nested race
  branch that shares the name. The engine now carries the step it suspended
  rather than looking the key back up.
- Fixed `FlowEngineLike.layerOver` and `layerMemory`, whose declared output type
  hid the `Crypto` service they provide.
- Fixed a fixture whose `model` disagreed with its own `request.modelId`: the
  two name the same thing, and a disagreement replayed one way for a request
  carrying the first and another way for a request carrying the second. Decoding
  now refuses it.

## [0.1.0]

### Added

- Initial release.
