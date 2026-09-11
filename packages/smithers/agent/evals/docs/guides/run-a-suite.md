---
title: "Run a suite"
description: "Provide a case executor, run the suite deterministically, and choose how scoring happens."
sidebar:
  order: 2
---

`Runner.run` executes every case through the injected `CaseExecutor` service
and grades each execution with the bindings whose `appliesTo` is the flow the
execution reports as its target.

## Implement the executor

The executor is one callback from a case to an `Execution`:

```ts
import { CaseExecutor } from "@smthrs/evals"
import { Effect } from "effect"

const executor = CaseExecutor.make((suiteCase) =>
  Effect.succeed({
    output: `Hello, ${(suiteCase.input as { readonly name: string }).name}`,
    stepKey: suiteCase.name,
    latencyMs: 0,
    target: greet
  })
)
```

`CaseExecutor.make` accepts the bare callback, or an object naming the
callback `run`. An object without one throws a `TypeError`:
a wiring mistake fails loudly instead of degrading to an executor that fails
every case.

Four rules make an execution usable:

- `target` must be the declared flow value itself. Bindings match it by
  reference identity, so a copy of the flow is graded by nothing.
- `stepKey` identifies the work the case produced. Fix it per case and state
  it; do not derive it from the run. The comparison reads a changed key as
  different work and a moved score under an unchanged key as nondeterminism.
  For the full rule, see [Step keys and comparison](../concepts/step-keys.md).
- `latencyMs` is forwarded to the scorer.
- `output` is handed to the scorer and embedded raw in the JSON report. Do not
  let it carry secrets you would not print.

## Fail a case

Return a typed failure and the run records it on the case and moves on:

```ts
import { EvalError } from "@smthrs/evals"

const executor = CaseExecutor.make((suiteCase) =>
  suiteCase.name === "known-bad"
    ? Effect.fail(
      new EvalError.EvalError({ code: "executor", message: "the target crashed", path: "target" })
    )
    : Effect.succeed({ output: 1, stepKey: suiteCase.name, latencyMs: 0, target: greet })
)
```

A failed case keeps its typed error and produces no observations; the rest of
the suite still runs. The error keeps the executor's own `path` when it named
one and is located at `cases['<name>']` otherwise, and its message is prefixed
`Target failed for case '<name>':`. An untyped failure is wrapped with the
`executor` code. Interruption propagates instead: an interrupted target
interrupts the run.

## Pass run identity

`Runner.run` takes `runId` and `at` from the caller. `runId` identifies the
`RunResult` and joins every score job's identity; `at` stamps every
observation. Two runs produce identical observations when their executor and
scorer results are identical too, since the runner invokes those effects afresh
each time:

```ts
Effect.gen(function*() {
  const run = yield* Runner.run(suite, {
    runId: "nightly-2026-01-01",
    at: "2026-01-01T00:00:00.000Z"
  })
})
```

- `runId` must be non-empty.
- `at` must be a canonical UTC timestamp with millisecond precision, such as
  `2026-01-01T00:00:00.000Z`. The value is parsed and re-rendered, and one
  that does not round-trip fails with `invalid_run_options`.
  `new Date().toISOString()` satisfies the format.
- `sampleId` is optional and defaults to `"default"`. It joins the job
  identity, so two samples of one run never share a job identity.

## Choose how scoring happens

A run scores through the first of these that exists:

1. `options.scorer`, a batch runner passed at the call site.
2. The `Runner` service, when a layer provides one.
3. `Runner.makeInline()`, the in-process default.

The inline runner executes each job's scorer in the current process and
validates the result with the scorers package's own `Scorer.validate`. A
scorer that fails becomes an inconclusive observation naming its cause rather
than failing the run. Provide `Runner.layerInline` to state the in-process
choice explicitly. Provide `Runner.layerNoop` to state that a suite must not
score: every bound score then becomes an inconclusive observation, which a
gate grades as an undecidable run rather than a red.

## Implement a batch runner

An adapter implements `Runner.ScoreBatchRunner`. Each `ScoreJob` carries an
`identity`, an `observation` seed with `targetStepKey` and `scorerKey`, the
scorer's `score` effect, and `at` in milliseconds since the epoch.

A runner that implements `runBatchCorrelated` tags every result with its job's
`identity` and may return results in any order. A run rejects a duplicate
identity, an unknown identity, a missing identity, the wrong result count, or
an observation that does not echo its job's `targetStepKey` and `scorerKey`,
all with `scorer_protocol`.

A runner that implements only `runBatch` is correlated positionally:

1. Return exactly one observation per job.
2. Return them in the order the jobs were given.
3. Echo each job's `targetStepKey` and `scorerKey` in each observation.

A run verifies all three and fails with `scorer_protocol` when one is broken.
Before calling an order-only runner, it also refuses two jobs that share a
step key and scorer with `ambiguous_score_job`: give each case its own step
key, or implement `runBatchCorrelated`. The runner service in
`@smthrs/scorers` implements `runBatchCorrelated`, so its service value can be
used directly and `ambiguous_score_job` never applies to it. For that service,
see the [scorers API](/api/scorers).

A returned score that is not finite and inside [0, 1] becomes an inconclusive
observation naming the scorer and the offending value, and the run's own
timestamp, not the adapter's, is what reaches the observation.

## Read the result

`RunResult.cases` is in declaration order regardless of completion order. Each
`CaseResult` carries either an `execution` or an `error`, plus the
observations attributed to the case. `RunResult.observations` flattens the
cases' observations into one list of `score` and `inconclusive` entries.
Reasons are bounded to 2048 characters, because they reach CI logs and
committed reports.

Next: [record a baseline](./maintain-a-baseline.md).
