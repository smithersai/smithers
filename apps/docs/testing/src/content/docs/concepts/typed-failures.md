---
title: "Typed failures"
description: "Every failure this package raises carries a stable code from one closed union, and three rules keep an assertion honest: no unknown channel, no host errors escaping, no unbounded payloads."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/concepts/typed-failures.md"
---

Every failure this package raises carries a stable `code` drawn from one closed
literal union, exported as `TestingError.Code`. A consumer matches on the code,
never on the prose of a message:

```ts
import { PlanAssertions } from "@smthrs/testing"
import * as Effect from "effect/Effect"

const checked = PlanAssertions.expectKeyGoldens(actual, golden).pipe(
  Effect.catchTag("PlanAssertionError", (error) =>
    error.code === "key_golden_mismatch"
      ? Effect.logError("canonical key serialization drifted")
      : Effect.fail(error))
)
```

Codes are grouped by the family that raises them, and each family exports its
own schema: `TestingError.PlanAssertionCode`,
`TestingError.JournalAssertionCode`, and `TestingError.ScoreGateCode`.
`TestingError.Code` combines those three families, every standalone testing
code, and the upstream `FlowCycleDetected` and `CancelRequestFailed` code
schemas. It accepts every `EngineSubjectError` code, including
`flow_cycle_detected`, `cancel_request_failed`, and
`unsafe_interrupt_unsupported`.

Approval timeouts and loop limits have no concrete subject or behavioral pin.
`TaskTimeoutError`, `RalphMaxReachedError`, and their reserved codes have been
removed. Add capability-specific failures when those behaviors are implemented.

Every literal is `snake_case`, without exception, so a consumer never has to
remember which family spells its codes differently.

## No unknown channel on a conformance seam

A subject that laundered a foreign cause into `unknown` could not be matched on
by the pin that reports it, so every conformance seam names the closed union its
cases actually produce. `Conformance.ConformanceCase` fails with
`ConformanceViolation | EngineSubjectError`. `HostSuite.HostSuiteCase` fails
with `HostSuite.HostSuiteError`, which is the typed contract violation plus the
incidental host failures a supported capability's own probe can produce: a
scratch write, a jj command, an HTTP request.

That last part is the point of naming the union rather than widening it. A
runner has to tell "this host violates the contract" from "the scratch write
failed because the disk is full", and it cannot do that against `unknown`.

## No host errors escaping

A `TypeError` or a `RangeError` thrown out of an operation declared to fail
with a typed error is a contract break. Two consequences run through the
package:

- The fixture encoder raises `FixtureEncodingError` with the `path` of the
  offending value and the `reason` it broke, rather than letting `JSON.stringify`
  throw a bare `TypeError`. Tool parameter accessors and sparse array holes
  fail with `unsupported-type` without invoking getters. Snapshotting preserves
  accessors for this validation rather than reading or dropping them.
- Every polling loop is bounded, so exhaustion is a typed failure rather than a
  hang. `FlowEngineLike` gives a runtime 1000 scheduler passes to publish a
  result whose body has already exited, then fails typed. Conformance pins wait
  on a bounded live-clock schedule, roughly one second, then fail.

## No unbounded payloads

An error a runner prints in full must carry a bounded identity, not the input
that produced it. `UnscriptedModelError` names the `modelId`, the
`messageCount`, and the `toolNames`, and nothing else. Carrying the whole
request put every system block, every turn of the conversation, and every tool
schema into CI logs and into any attached error reporter, for a replay double
whose whole purpose is long agent conversations, and one that routinely holds
file contents and customer data.

The same rule shapes the rest. `ExecutionConflictError` carries bounded
renderings of the conflicting flow or payload, never the payloads themselves.
`ScoreGateError` names every rejected observation by `case`, `stepKey`, and
`scorer`, so a run with ten bad scorers is diagnosed in one pass without
printing the samples.

## A wrong code is a typed field, not a message

When a conformance case observes the wrong stable code, the expectation and the
observation travel as the typed `expectedCode` and `actualCode` fields of
`CapabilityContractError`. They are never encoded into the operation string,
because a consumer that has to parse a message to learn which code it got is a
consumer that will parse it wrong.

The complete list of errors, their fields, and the codes each one can carry is
in the [API reference](/reference/api/#testingerror). What each failure means in
practice, and what to change, is in
[Troubleshooting](/troubleshooting/).
