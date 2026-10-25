---
title: Deterministic child startup timeout regression
status: blocked
area: agent
owner: Codex engine-flake
updated: 2026-10-25
links:
  - packages/smithers/agent/test/EngineChildren.test.ts
---

Investigate loaded-host startup timeout failure; prove deterministic abandonment
and successful retry with the real durable engine on Latitude.

Classification: test timing, not an observed engine race. Both attempts used a
20 ms live-clock startup budget. The first correctly returned `failed` and
joined cleanup; the healthy second attempt could itself exceed 20 ms under load
and throw `ChildError`. A baseline nyc-01 run reproduced that failure. The test
and production implementation match the originally reported a0a12649 revision.

The regression now waits for an explicit dependency-entry receipt before
advancing Effect TestClock by exactly 20 ms. Zero-delay polling yields without
advancing time during retry. Assertions retain cleanup, successful output and
exactly one execution, adding zero executions before dependency recovery.
No production behavior, timeout duration or coverage configuration changed.

Library catalog: “Run flows in a Node or Bun program” (`@smthrs/engine`, real
FlowEngine and SQLite host), with Effect's existing TestClock test service.
This is a test-only correction; no public API or runtime changeset is needed.

Validation: nyc-01 EngineChildren file passed 10/10 independent invocations,
48/48 each (480/480). Full package run with unchanged V8 coverage configuration:
162 files passed, 1 failed, 2 skipped; 2,229 tests passed, 1 failed, 3 skipped.
The sole failure is Fault.sweep: `RealmFlowError` has no registered fault class
in unchanged `agent/harness/src/RealmFlow.ts`. An isolated sweep reproduces it.
Vitest emitted no coverage totals after the failed test, so no package coverage
pass is claimed. Package `pnpm check` passed. Scope remains the child test flake;
the unrelated fault registration blocks a green package receipt.
