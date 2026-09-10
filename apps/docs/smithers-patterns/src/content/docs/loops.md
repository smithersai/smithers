---
title: "Loops"
description: "Loop, Optimizer, ScanFixVerify, DriftDetector, and Sidecar: the @smthrs/patterns shapes whose round count is a runtime fact, and how each one declares its worst case in advance."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/patterns/docs/loops.md"
---

This page covers the loop-shaped patterns: [`Loop`](#loop),
[`Optimizer`](#optimizer), [`ScanFixVerify`](#scanfixverify),
[`DriftDetector`](#driftdetector), and [`Sidecar`](#sidecar). They all answer
one question: how does a plan express work whose round count is a runtime fact.
They all answer it the same way.

## Two halves, and why

Every pattern here exports `make` and `run`.

`make` returns a `Flow` whose body is the **conservative topology**: every
iteration the bound allows is declared, whether or not a run reaches it. Core
plans a body by evaluating `Node.bindPlanned` builders once against symbolic values
(`@smthrs/core/Graph.build`), so a declaration cannot branch on a value it does
not have yet. Declaring the worst case is the honest answer: capability
analysis, write-conflict analysis, and cost estimation all see every call a run
could make.

`run` is the Effect that performs the value-dependent stop. It short-circuits
the moment the predicate is satisfied, so the work actually performed is the
loop the author meant. Fiber interruption propagates normally, which is why
none of these patterns carry a cancellation flag.

One consequence follows from core's node vocabulary, and it is deliberate:

- **A declaration cannot branch on a value.** Graph planning evaluates a
  builder once against a symbolic value, so `onMaxReached: "fail"` is applied
  by `run` and `make` declares the exhausted value instead. Recovery is
  different: `Node.catch` declares a static arm, which is how `Sidecar`
  declares its shadow's quarantine.

## Loop

```ts
import { Loop } from "@smthrs/patterns"

const loop = Loop.make({
  body: draftFlow,
  until: reviewFlow,
  maxIterations: 5,
  onMaxReached: "return-last"
})
```

`body` runs once per iteration with `{ input, previous, iteration }`, where
`previous` is the preceding iteration's output and is absent on the first.
`until` receives `{ value, iteration }` and answers with `true`, the string
`"done"`, or an object carrying `done: true`. `Loop.done` is that reader,
exported so a caller can reuse the same vocabulary.

The body always runs at least once. `until` reads a value the body produced, so
a predicate that would answer `true` before any work still costs one iteration.
Write the loop as "do this, then ask whether to stop".

`Loop.done` reads the same three signals from an explicit `until` flow and from
a Ralph body, so both forms share one completion vocabulary. The match is
exact: `"DONE"`, `"yes"`, `1`, and `{ done: "true" }` all continue the loop.

`onMaxReached` defaults to `"return-last"`.

`Loop.run` returns `{ value, iterations, exhausted }`. `exhausted` is true when
the bound stopped the loop rather than the predicate; under
`onMaxReached: "fail"` that case fails `PatternError` with code `exhausted`
instead.

```ts
const result = yield * Loop.run(goal, {
  maxIterations: 5,
  onMaxReached: "fail",
  body: ({ input, previous, iteration }) => draft(input, previous, iteration),
  until: ({ value }: { readonly value: Draft }) => Effect.succeed(value.tests === "green")
})
```

The annotation on `until` is required whenever `body` is written inline and
reads `previous`. See [Inline callbacks and inference](#inline-callbacks-and-inference).

`maxIterations` must be a positive safe integer. `make` throws `PatternError`
`invalid_decorator` at declaration; `run` fails with the same error before the
first body runs.

`make` unrolls the bound, so it is capped a second time by the plan depth
limit: 511 iterations for a body alone, 255 when an `until` flow is declared
too. `make` refuses a bound past that with the same `invalid_decorator` error,
naming the limit. `run` takes any positive safe integer, because it iterates
instead of unrolling. See
[Declaration size](/reference/api/#declaration-size).

### Ralph

`Loop.ralph` and `Loop.runRalph` are the loop with no separate predicate flow:
the body reports its own completion, so the declared topology is
`maxIterations` body calls and nothing else. It is the "keep handing the agent
the same goal until it says it is finished" loop.

```ts
const result = yield * Loop.runRalph(goal, {
  maxIterations: 20,
  body: ({ iteration }) => agentTurn(goal, iteration)
})
```

`onMaxReached` defaults to `"return-last"`, so a body and a bound are the whole
call. A Ralph loop that reaches its bound returns the last value with
`exhausted: true`; pass `onMaxReached: "fail"` for a run that should fail
instead.

Nothing here bounds how much history a run accumulates, because every iteration
lives in one execution. Bounding retained history is a property of
[the durable round](#the-durable-round-recipe), not of the pattern.

## Optimizer

`Optimizer` is `Loop` with a score threshold as its predicate and a best-so-far
ledger, because the last candidate a search produces is often not its best one.

```ts
import { Optimizer } from "@smthrs/patterns"

const result = yield* Optimizer.run(brief, {
  maxIterations: 5,
  targetScore: 0.8,
  onMaxReached: "return-last",
  generate: ({ input, previous }) => write(input, previous),
  // Annotated because `generate` reads `previous`. See "Inline callbacks and
  // inference" below.
  evaluate: ({ value }: { readonly value: Draft }) => grade(value)
})
```

`generate` receives `{ input, previous, iteration }`, where `previous` is the
whole preceding attempt: `{ candidate, score, feedback, iteration }`. Handing
the score and the feedback back is what makes the next generation an
improvement rather than a fresh guess. `evaluate` receives `{ value, iteration }`
and answers `{ score, feedback? }`; `feedback` is opaque to the pattern.

`run` returns `{ best, iterations, converged }`. `best` is the highest-scoring
attempt, so a run whose last iteration scored worse still reports the good one.
A later attempt has to beat the standing best rather than match it, so `best` is
the earliest of equal scores wherever the tie falls. `converged` is true when
`best` reached `targetScore`.

`onMaxReached` defaults to `"return-last"`, as it does in `Loop`.
`onMaxReached: "fail"` requires a `targetScore`: without one there is nothing
for the search to fall short of, so `make` throws and `run` fails
`invalid_decorator` before generating anything. With a target, exhausting the
bound below it fails `exhausted`.

The target score never enters the declared topology, because comparing a score
is a runtime decision. It enters declaration identity instead, so two searches
that differ only in their target do not share a step key.

`Optimizer.make` declares each iteration as a `generate` call followed by an
`evaluate` call, and declares the next `generate` call as reading the previous
attempt. Dependency analysis therefore sees `evaluate` feeding the generation
that follows it, which is the edge the search actually depends on.

## ScanFixVerify

`ScanFixVerify` is the lint-fix, test-repair, and audit-remediation shape: scan
for issues, fix each one on its own, verify, and scan again until nothing is
left. `ReviewLoop` cannot express it, because a review loop revises one
artifact; here every issue gets its own fix.

```ts
import { ScanFixVerify } from "@smthrs/patterns"

const report = yield* ScanFixVerify.run({ path: "src" }, {
  maxRetries: 3,
  concurrency: 4,
  scan: ({ input }) => lint(input),
  fix: ({ issue, index }) => repair(issue, index),
  verify: ({ issues, fixes }) => runTests(issues, fixes)
})
```

`scan` receives `{ input, iteration }` and returns the issues. `fix` receives
`{ issue, index, iteration }` and runs once per issue over a snapshot of what
the scan returned, so `concurrency` is the real in-flight bound. `verify`
receives `{ input, issues, fixes, iteration }` and answers `true` or an
object carrying `resolved: true`; `ScanFixVerify.resolved` is that reader.

An empty scan is the only terminal. A verification is evidence about the round
it closes, so a round the verifier calls resolved is followed by one confirming
rescan, and the loop ends when that rescan finds nothing. The scanner is the
authority on what is left: a verifier reads the fixes it was handed, and a fix
that reported success can still leave the issue in place. A clean scan ends the
round before fixing or verifying anything, so a run whose first scan finds
nothing reports one iteration and no verifications.

`run` returns `{ iterations, remaining, resolved, verifications }`. `resolved`
is true only when a scan came back empty. `remaining` is empty on that clean
exit and lists the last scan's issues when the retry bound stopped the loop,
which is the signal an operator acts on. `verifications` holds one entry per
round that had something to fix, in order, and `ScanFixVerify.resolved` reads
each one.

`make` needs one bound `run` does not: `maxIssues`. A plan cannot know how many
issues a scan will find, so the declaration carries the largest fan-out the
author will admit, batched at `concurrency`. The declared topology is therefore
`maxRetries` scans, `maxRetries * maxIssues` fixes, and `maxRetries` verifies.
Keep `maxIssues` at or above what the scanner can produce, or the declaration
understates the work a run performs.

```ts
const pattern = ScanFixVerify.make({
  scan: lintFlow,
  fix: repairFlow,
  verify: testFlow,
  maxRetries: 3,
  maxIssues: 20,
  concurrency: 4
})
```

`maxRetries`, `maxIssues`, and `concurrency` must be positive safe integers.
`make` throws `PatternError` `invalid_decorator`; `run` fails with the same
error before the first scan.

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
carrying `drifted: true`; `DriftDetector.drifted` is that reader. For a
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

`make` declares the alert call whenever an alert flow is supplied, because a
declaration cannot branch on a comparison it does not have. Capability analysis
therefore sees the paging authority a run may use, which is the answer a
reviewer wants. The baseline rides declaration identity, so two detectors
watching the same target against different baselines do not share a step key.

### Polling

The pattern detects once. How often to look is a deployment decision, so it
belongs to the caller. Inside one execution, wrap the detection in a loop:

```ts
type Detection = DriftDetector.Result<Config, Diff, PagerAck>

yield * Loop.run(target, {
  maxIterations: 12,
  onMaxReached: "return-last",
  body: ({ input }) => DriftDetector.run(input, detector),
  until: ({ value }: { readonly value: Detection }) => Effect.succeed(value.drifted)
})
```

`Config`, `Diff`, and `PagerAck` are what `capture`, `compare`, and `alert`
return. The `until` annotation is the one from
[Inline callbacks and inference](#inline-callbacks-and-inference): a polling
loop needs it even though its `body` reads only `input`.

For polling that outlives an execution, place `DriftDetector.run` under an
external scheduler. Start one run per fire so each detection is independently
journaled and a missed window is a scheduling question rather than a lost loop
iteration.

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
behind a `Node.catch` whose arm settles `{ quarantined: true, error }`.
Capability and cost analysis still count the shadow as work that happens;
what the arm adds is that the plan shows a failed shadow does not fail the
run. The declared result is `{ primary, shadow, delta }`, and the scorer is
declared unconditionally because a plan has no branch for "only when the
shadow produced a value": `run` performs that skip.

## Inline callbacks and inference

`Loop.run` and `Optimizer.run` hand each iteration the previous one's output.
That makes the first callback's own parameter depend on the loop's value type,
and TypeScript cannot infer a type variable from a callback whose parameters
already mention it. The value type resolves to `unknown`, and the second
callback's parameter goes with it:

```ts
Loop.run(goal, {
  maxIterations: 5,
  onMaxReached: "return-last",
  body: ({ previous }) => draft(previous),
  until: ({ value }) => Effect.succeed(value.done) // error: `value` is unknown
})
```

Annotate the second callback's parameter, which fixes the type for both:

```ts
const options = {
  until: ({ value }: { readonly value: Draft }) => Effect.succeed(value.done)
}
```

Three cases never need it. `Loop.ralph` and `Loop.runRalph` have no second
callback. `ScanFixVerify.run` infers throughout, because `scan` does not read
any value the loop produced. A `body` that ignores `previous` still declares
the parameter, so the annotation is about the declared shape rather than about
what the callback happens to use: the polling loop under
[DriftDetector](#polling) needs the annotation even though its `body` reads only
`input`, and so does `Optimizer.run` whenever `evaluate` is written inline.

## The durable round recipe

`Loop.run` is one execution. Its iterations live in one fiber, so a crash
between iteration 3 and 4 loses iterations 1 through 3 unless the body itself
journaled them. When rounds must survive a crash, hand each iteration to the
trampoline in `@smthrs/flow` instead: `Flow.to` ends the current execution and
names the next one, and each round is a separate journaled execution that
resumes independently.

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
`execute` failure. See [`@smthrs/flow`](https://flow.smithers.sh/reference/api/).

Choose by durability, not by size:

| Requirement                                               | Use                        |
| --------------------------------------------------------- | -------------------------- |
| Rounds inside one execution, bounded at declaration       | `Loop.make` and `Loop.run` |
| Rounds that survive a crash, each independently resumable | `Flow.to` with `maxRounds` |
| One expansion of a literal tree known while planning      | `Recursion.recurse`        |
