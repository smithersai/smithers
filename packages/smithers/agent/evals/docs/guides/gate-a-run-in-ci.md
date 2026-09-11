---
title: "Gate a run in CI"
description: "Compare a run to its baseline, render the report, and turn the verdict into an exit code."
sidebar:
  order: 4
---

The second half of the pipeline runs in CI: load the committed baseline,
compare the run against it, render the comparison for the log, and grade it
into an exit code.

## Compare with tolerances

`Regression.compare` pairs baseline records with the run's score observations
and reports what moved:

```ts
Effect.gen(function*() {
  const comparison = yield* Regression.compare(baseline, run, {
    absolute: 0.05,
    relative: 0.1
  })
})
```

- A score that dropped at a changed step key is a regression.
- A score that moved at an unchanged step key is nondeterminism.
- An observation present on only one side is a missing observation.
- Inconclusive observations are carried through untouched.

A move is reported only when it exceeds both tolerances, so either one alone
silences it. Both default to 0, which reports every move. A tolerance that is
not finite and non-negative fails with `invalid_tolerance`. For the pairing
and step-key rules, see [Step keys and comparison](../concepts/step-keys.md).

## Render the report

`Report.markdown` is what an operator reads in the CI log. Its summary counts
regressions, nondeterminism, missing observations, inconclusive observations,
and failed cases, and every non-zero count gets a section that names its rows.
`Report.json` is the machine-readable artifact: stable, sorted-key JSON with
embedded strings capped and everything JSON cannot express replaced by a named
marker, so two identical runs produce byte-identical reports.

Nothing redacts the output embedded in a report. A suite whose cases carry
secrets must not print the report where the log is readable.

## Set thresholds

`Gate.check` evaluates score thresholds through the shared gate arithmetic in
[@smthrs/scorers/ScoreGate](/api/scorers):

```ts
Effect.gen(function*() {
  const verdict = yield* Gate.check(comparison, {
    mean: 0.9,
    min: 0.5,
    perCase: { "adds numbers": 0.8 }
  })
})
```

- `mean` gates the arithmetic mean of every score observation.
- `min` gates the lowest score observation.
- `perCase` gates each named case's lowest score.

The threshold gates always run: an unobserved case cannot excuse the cases
that were observed. With no options the gate still runs, as `mean(0)`, so a
run with no score at all is undecidable rather than a pass. Regressions and
nondeterminism are findings and force a `Failed` verdict. Failed cases and
missing observations are environment faults and travel beside the verdict as
unresolved.

A threshold outside [0, 1] is gate misuse and fails in the error channel with
a `ScoreGateError`, code `invalid_threshold`. Catch it and report it rather
than crashing the CI job:

```ts
Effect.gen(function*() {
  const graded = yield* Gate.check(comparison, { mean: 1 }).pipe(
    Effect.map(Gate.ciGrade),
    Effect.catch((error) =>
      Effect.succeed({
        exitCode: 1 as const,
        summary: `${error.code}: threshold ${error.threshold}, actual ${error.actual}`
      })
    )
  )
})
```

## Grade to an exit code

`Gate.ciGrade` maps the verdict to the shared CI convention:

| Exit code | Meaning                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| 0         | Passed: every gate met, nothing unresolved                                      |
| 1         | Failed: a threshold breach, a regression, or nondeterminism                     |
| 5         | Inconclusive: the gate could not decide, or passed with unresolved observations |

Exit code 5 names an unusable harness, not a result: repair the scorer, the
executor, or the wiring instead of reading the red. A pass that carries
unresolved observations also exits 5, because the gates it met were met over
fewer observations than the suite declared.

## The complete gate

Assemble the whole thing as one script that CI runs: build the suite, run it,
load the committed baseline, compare, print the Markdown report, grade, and set
`process.exitCode` from the grade. [Quickstart](../quickstart.md) has that
script in full.

Two flags earn their place on it:

- `--update` re-records the baseline from this run, for the times a score moved
  for a reason you can name. Keep it off the CI path.
- `--json` prints `Report.json` instead of the Markdown summary, so a drifting
  run leaves a machine-readable artifact to diff.

Then call the script from your CI job and let the exit code decide the step:

```yaml
- name: Evaluate
  run: node quickstart.ts
```

The gate's exit code is the whole contract: 0 and the job goes green, 1 and it
fails on a real red, 5 and it fails on a harness you need to repair.
