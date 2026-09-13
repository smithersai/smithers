---
title: "Gate a scored suite"
description: "Turn score observations into a pass, a finding, or an undecidable run: build gates over a fixed sample set, run a whole suite through its case runner, and map the verdict onto a CI exit code."
sidebar:
  order: 7
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/guides/gate-a-scored-suite.md"
---

`ScoreGate` decides whether a graded run is good enough, and keeps a broken
harness from reporting itself as a red.

## Gate a fixed sample set

A `ScoreSample` names its `case`, its `stepKey`, and its `scorer`. It is either
a `score` with a value in `[0, 1]` or an `inconclusive` with a reason:

```ts
import { ScoreGate } from "@smthrs/testing"
import * as Effect from "effect/Effect"

const samples: ReadonlyArray<ScoreGate.ScoreSample> = [
  { case: "first", stepKey: "first-key", scorer: "quality", kind: "score", value: 0.9 },
  { case: "second", stepKey: "second-key", scorer: "quality", kind: "score", value: 0.8 }
]

const verdict = Effect.gen(function*() {
  const gates = ScoreGate.expectScores(samples)
  return ScoreGate.combine([
    yield* gates.mean(0.8),
    yield* gates.min(0.8),
    yield* gates.perCase({ first: 0.9, second: 0.8 })
  ])
})
```

The three gates are `mean` over every score observation, `min` over every
observation, and `perCase` over each named case's lowest observation.

A gate the scores missed comes back as a `Failed` verdict in the success
channel, not as a raised error, because the report has to survive it. The error
channel is reserved for misuse of the gate itself: a threshold or a score
outside `[0, 1]`.

## Run a whole suite

`ScoreGate.suite` runs each case through a caller-supplied runner, collects
every sample, applies the declared gates over the samples that exist, and
grades the whole run. This runnable CI example uses an exact-match scorer;
replace the runner with your case execution and scoring logic:

```ts
import { ScoreGate } from "@smthrs/testing"
import * as Effect from "effect/Effect"

const report = await Effect.runPromise(ScoreGate.suite({
  cases: [
    { name: "greeting", input: { actual: "hello", expected: "hello" }, minScore: 0.7 },
    { name: "answer", input: { actual: "42", expected: "42" } }
  ],
  gates: { mean: 0.8, min: 0.5 },
  run: (suiteCase) =>
    Effect.succeed([{
      case: suiteCase.name,
      stepKey: `${suiteCase.name}-key`,
      scorer: "exact-match",
      kind: "score" as const,
      value: suiteCase.input.actual === suiteCase.input.expected ? 1 : 0
    }])
}))

const { exitCode, summary } = ScoreGate.ciGrade(report)
console.log(summary)
process.exitCode = exitCode
```

Every sample the runner returns is rebound to the case that was actually run.
Trusting the runner's own `case` field let a runner bug attribute samples to
another case, so the per-case gates silently measured the wrong one.

Any failure or defect the runner raises is an **environment fault**. That case
contributes no samples and its reason to the report's `inconclusive` list, and
it no longer cancels the gates the finished cases can still be judged by.

## Grade it for CI

`ScoreGate.suite` returns an Effect. Run it with `Effect.runPromise`, as above,
or yield it inside `Effect.gen` before passing the completed report to
`ScoreGate.ciGrade`.

| Result                                              | Exit code |
| --------------------------------------------------- | --------- |
| Every gate evaluated and met                        | 0         |
| A gate the run measured was missed                  | 1         |
| Nothing decidable, or a pass with unresolved faults | 5         |

Exit 5 is not a red. It says the harness owes an answer it could not give, and
the fix is to repair the harness rather than to lower a threshold.

## Validate samples you built yourself

`ScoreGate.expectScores` validates its own samples. A caller that constructs
samples elsewhere, a suite runner or a reporter, should validate them too:

```ts
yield * ScoreGate.validateSamples(samples)
```

An unvalidated `NaN` reaches a report as a passing number. The failure names
every rejected observation by `case`, `stepKey`, and `scorer`, so a run with
ten bad scorers is diagnosed in one pass.

## Related

- [Scored suites](/concepts/scored-suites/): why a finding and an
  undecidable run are different outcomes.
- [`@smthrs/evals`](https://evals.smithers.sh/reference/api/) builds its CI gate on this module; see
  [its guide](https://evals.smithers.sh/guides/gate-a-run-in-ci/).
