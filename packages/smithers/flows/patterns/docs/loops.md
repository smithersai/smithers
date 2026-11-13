---
title: "Loops"
description: "Optimizer, ScanFixVerify, DriftDetector, Sidecar, and durable trampoline rounds."
---

A loop is a flow that hands off to itself with `Flow.to` and bounds its lineage
with `maxRounds`; see [Trampoline rounds](../../flow/docs/concepts/trampoline-rounds.md).

This page covers [`Optimizer`](#optimizer), [`ScanFixVerify`](#scanfixverify),
[`DriftDetector`](#driftdetector), and [`Sidecar`](#sidecar).

## Declared work

`Optimizer.make` and `ScanFixVerify.make` return flows. Execute them on the
engine so completed steps replay from the journal after a crash. Neither
pattern exports an executed `run` form.

The declarations carry the conservative topology: every iteration the bound
allows is visible before execution. `Node.branch` evaluates its predicate on
real results during execution and runs only the selected continuation.

## Optimizer

`Optimizer` generates and scores candidates, stopping when one reaches the
target. It keeps the best attempt even when a later candidate scores worse.

```ts
import { Optimizer } from "@smthrs/patterns"

const search = Optimizer.make({
  generate: writeFlow,
  evaluate: gradeFlow,
  maxIterations: 5,
  targetScore: 0.8,
  onMaxReached: "return-last"
})
const result = yield* search.execute({ input: brief }, { executionId: "summary-search" })
```

`generate` receives `{ input, previous, iteration }`. `previous` is the whole
preceding attempt, `{ candidate, score, feedback, iteration }`, and is absent
on the first iteration. `evaluate` receives `{ value, iteration }` and answers
`{ score, feedback? }`. The next generation receives that score and feedback.

The flow returns `{ best, iterations, converged }`. `best` is the highest-scoring
attempt, with ties keeping the earliest attempt. `converged` is true when the
search reaches `targetScore`. Without a target, the search uses its whole
iteration budget and reports `converged: false`.

`onMaxReached` defaults to `"return-last"`. `"fail"` requires a `targetScore`
and fails with `PatternError` code `exhausted` when the budget ends below it.
The ceiling vocabulary comes from `@smthrs/plan/Repetition`.

`make` throws `PatternError` code `invalid_decorator` for a non-finite target,
a bound that is not a positive safe integer, or a fail policy without a target.
A non-finite evaluation score fails the executing flow with `invalid_input`,
naming the iteration and score. Each evaluation folds the best attempt and
branches on the target check. The target score enters declaration identity.
See [Declaration size](./api.md#declaration-size) for the graph depth limit.

## ScanFixVerify

`ScanFixVerify` scans for issues, fixes each one, verifies the fixes, and scans
again until nothing remains. Each issue gets its own fix.

```ts
import { ScanFixVerify } from "@smthrs/patterns"

const repair = ScanFixVerify.make({
  scan: lintFlow,
  fix: repairFlow,
  verify: testFlow,
  maxRetries: 3,
  maxIssues: 20,
  concurrency: 4
})
const report = yield* repair.execute({ input: { path: "src" } }, { executionId: "repair-source" })
```

`scan` receives `{ input, iteration }` and returns an array of issues. `fix`
receives `{ issue, index, iteration }`. `verify` receives
`{ input, issues, fixes, iteration }`. `ScanFixVerify.resolved` reads `true`
or an object's own `resolved: true` from a verification. The final confirming
scan receives `iteration: maxRetries + 1`. Every scan, including this final
confirmation, must return an array. A non-array fails with `PatternError`
code `invalid_input`, naming the iteration, before any further fix,
verification, or scan.

An empty scan settles `resolved: true`. Even a verification that reports success
is followed by a confirming rescan. A clean first scan runs no fix or verify.
The flow returns `{ iterations, remaining, resolved, verifications }`.
After the last allowed fix round, one final scan confirms whether anything
remains, without running more fixes or verification. `remaining` holds that
scan's issues, and `resolved` is true exactly when it is empty. This final
confirmation does not increase `iterations`, which counts rounds entered up
to `maxRetries`. `verifications` records each round that had issues, in order.

The declaration reserves `maxRetries + 1` scans, `maxRetries * maxIssues` fix
slots in `concurrency`-sized batches, and `maxRetries` verifications. A fix slot
runs only when its scan returned an issue at that index. The verifier receives
only the fixes for those issues. Keep `maxIssues` at or above what the scanner
can produce; issues beyond that bound wait for the next rescan.

`maxRetries`, `maxIssues`, and `concurrency` must be positive safe integers.
`make` throws `PatternError` code `invalid_decorator` for an invalid bound.

## DriftDetector

`DriftDetector` captures the world, compares it to a remembered baseline, and
acts only when the comparison says something moved. It is the shape behind
config auditing, index freshness, and dependency pinning.

```ts
import { DriftDetector } from "@smthrs/patterns"

const result = yield* DriftDetector.run({ target: "prod" }, {
  baseline: recordedChecksum,
  capture: ({ input }) => readConfig(input),
  compare: ({ snapshot, baseline }) => diff(snapshot, baseline),
  alert: ({ comparison }) => page(comparison)
})
```

`capture` receives `{ input, baseline }` and `compare` receives
`{ snapshot, baseline }`. A comparison reports drift with `true` or an object
carrying its own `drifted: true`; `DriftDetector.drifted` is that reader. For a
comparison that reports a magnitude instead of a verdict, supply `alertIf`:

```ts
const detector = {
  alertIf: (comparison) => comparison.delta > tolerance
}
```

`alert` runs at most once per detection and receives
`{ comparison, snapshot, baseline }`. Its failure is the run's failure: a
detector that cannot page has detected nothing an operator will see. Omit it
for a detector that only reports.

`run` returns `{ snapshot, comparison, drifted, alert? }`. `alert` is present
only when the action ran, so its presence is the proof.

`make` declares the alert call as the drifted arm of a `Node.branch` on the
comparison, read with `DriftDetector.drifted` at run time, and settles to the
same `{ snapshot, comparison, drifted, alert? }` record as `run`. Capability
analysis still sees the paging authority a run may use. `alertIf` is run-only.
The baseline rides declaration identity, so two detectors watching the same
target against different baselines do not share a step key.

### Polling

The pattern detects once. For repeated detection, call `DriftDetector.make`'s
flow from a flow that hands off to itself with `.to(...)`, and declare
`maxRounds` on that lineage. Each round runs through the engine.

## Sidecar

`Sidecar` answers one question: would the cheaper model have been good enough?
It runs a shadow beside the primary over the same input, concurrently, and
scores the pair.

```ts
import { Sidecar } from "@smthrs/patterns"

const result = yield* Sidecar.run(prompt, {
  primary: (input) => opus(input),
  shadow: (input) => haiku(input),
  score: ({ primary, shadow }) => grade(primary, shadow)
})
```

The shadow is an experiment, so its failure is quarantined: `run` returns
`{ quarantined: true, cause }` for the shadow and the primary value stands. A
defect is quarantined the same way. Interruption is not, because a cancelled
run is cancelled, and reporting the shadow as merely failed would hide that.

The primary is not quarantined. A sidecar is not a fallback ladder, and a
failed primary is a failed run. `Escalation` is the pattern for alternatives.

`score` receives both outputs and returns `{ primary, shadow }` scores. It runs
only when the shadow produced an output, so a quarantined shadow leaves `delta`
absent rather than fabricating a comparison.

`Sidecar.delta(primaryScore, shadowScore)` is pure and is what `run` applies:

| Field               | Meaning                                              |
| ------------------- | ---------------------------------------------------- |
| `primary`, `shadow` | the two scores as given                              |
| `difference`        | `primary - shadow`, rounded to twelve decimal places |
| `cheaperWins`       | the shadow matched or beat the primary               |

The rounding is not cosmetic. A raw subtraction reports `0.30000000000000004`
for scores an operator entered as `0.8` and `0.5`, and a dashboard that shows
that number invites a bug report. A tie counts as `cheaperWins`: equal quality
at lower cost is the cheaper seat winning, which is the finding a sidecar
exists to produce.

`make` declares both calls under one `Node.all`, which is what makes the
shadow concurrent rather than an extra sequential step, with the shadow
behind a `Node.catch` whose arm settles `{ quarantined: true, error }`, with
`error` as the data the shadow's error schema encodes it to.
Capability and cost analysis still count the shadow as work that happens;
what the arm adds is that the plan shows a failed shadow does not fail the
run. The scorer is the settled arm of a `Node.branch` on the real shadow, so
a quarantined shadow is never scored, as in `run`. The declared result is
`{ primary, shadow, delta? }`; a quarantined shadow carries its typed `error`
where `run` carries the whole `cause`, because a cause does not cross the
declared wire.

## The durable round recipe

Each handoff ends the current round and names the next one. The engine journals
each round and follows the lineage, so recovery can reuse completed work.

```ts
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Schema from "effect/Schema"

const Attempt = Action.make("repo/Attempt", {
  payload: { goal: Schema.String },
  success: Schema.Struct({ done: Schema.Boolean, summary: Schema.String })
})

const Payload = Schema.Struct({ goal: Schema.String, round: Schema.Number })

type FixFlow = Flow.Flow<
  "repo/fix",
  typeof Payload,
  typeof Schema.String,
  typeof Schema.Never,
  Action.Requirement<"repo/Attempt">
>

const Fix: FixFlow = Flow.make("repo/fix", {
  payload: { goal: Schema.String, round: Schema.Number },
  success: Schema.String,
  // The BUDGET, not loop detection: identical consecutive rounds are legal.
  maxRounds: 20,
  body: ({ goal, round }) =>
    Attempt.call({ goal }).pipe(
      Node.branch({
        if: (result) => result.done,
        then: (result) => Flow.done(result.summary),
        else: () => Fix.to({ goal, round: round + 1 })
      })
    )
})
```

`Flow`, `Action`, and `Flow.done` come from `@smthrs/flow`; `Node.branch` comes
from `@smthrs/plan`. The alias on `Fix` is what lets the body name the flow it
recurses into: a flow whose body calls itself needs its own type before the
constructor returns.

`maxRounds` bounds one trampoline lineage. Exceeding it terminates the lineage
with a `MaxRoundsExceeded` defect in the execution result; it is not a typed
`execute` failure. See [`@smthrs/flow`](/api/flow).
