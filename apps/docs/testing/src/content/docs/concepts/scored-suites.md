---
title: "Scored suites"
description: "Why a graded suite has three outcomes rather than two: a finding is a red, an environment fault is an undecidable harness, and the CI exit codes keep them apart."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/concepts/scored-suites.md"
---

A score gate answers a question with a threshold, and the interesting part is
what happens when it cannot answer at all.

`@smthrs/testing/ScoreGate` re-exports the pure grading contract from
`@smthrs/scorers/ScoreGate` and adds the fixed-suite runner and `ciGrade`
report helper. Runtime applications import scorers directly; testing stays a
development dependency. `TestingError.ScoreGateError`, `ScoreGateCode`, and
`InvalidScoreSample` re-export the same class and schemas from scorers, so
constructor identity, tags, fields, and existing test imports are preserved.

`ScoreGate.Verdict` has three members:

```ts
type Verdict =
  | { readonly _tag: "Passed"; readonly inconclusive: ReadonlyArray<string> }
  | { readonly _tag: "Failed"; readonly reasons: ReadonlyArray<string>; readonly inconclusive: ReadonlyArray<string> }
  | { readonly _tag: "Inconclusive"; readonly reasons: ReadonlyArray<string> }
```

`Failed` is a **finding**: the scores a run produced did not meet a gate. That
is a measurement, and it is a red.

`Inconclusive` is an **environment fault**: nothing could be measured. That is
a broken harness to repair, not a result to read. A judge that was unavailable,
a case runner that threw, a fixture that could not be loaded.

Collapsing the two is the failure this design exists to prevent. A harness that
reported a red for its own outage teaches a team to ignore reds; a harness that
reported a pass for a gate it never evaluated is worse.

## A fault never eats a decision

A fault observed **beside** a decidable gate travels in `inconclusive`
alongside the verdict, never instead of it. Three consequences follow:

- A gate the surviving scores actually missed is a finding and grades `Failed`.
  A suite can never report an undecidable harness on evidence it did decide.
- A case that hit an environment fault contributes no samples and its reason to
  the verdict's `inconclusive` list. It does not cancel the gates the finished
  cases can still be judged by.
- A suite that gated nothing and measured nothing is `Inconclusive` rather than
  a clean pass over zero evidence.

`ScoreGate.combine` reduces several gate verdicts plus the faults observed
outside them into one verdict, with findings taking precedence over
undecidability. Without gates, inconclusive observations still reach `combine`
and grade the suite `Inconclusive`, even when other samples contain scores.
They remain unresolved faults and CI exits 5.

## The gate is over a fixed sample array

A gate is evaluated only over a caller-owned, fixed sample array. Live
production observations never enter it. A `ScoreSample` names its `case`, its
`stepKey`, and its `scorer`, and is either a `score` with a value in `[0, 1]` or
an `inconclusive` with a reason.

`ScoreGate.suite` binds each returned sample to the case that was actually run.
Trusting the runner's own `case` field let a runner bug attribute samples to
another case, so the per-case gates silently measured the wrong one.

`ScoreGate.validateSamples` rejects every observation outside `[0, 1]`, naming
each one. A gate builder validates its own samples, but a caller that
constructs samples itself, a suite runner or a reporter, has no other way to
reach the check, and an unvalidated `NaN` reaches a report as a passing number.

The error channel is reserved for misuse of the gate itself: a threshold or a
score outside `[0, 1]`. A missed gate is a value in the success channel,
because the report has to survive it.

`ScoreGate` has no sample-count limit. Its minimum is an iterative reduction,
not an argument spread.

## Three exit codes

`ScoreGate.grade` maps a verdict onto the shared CI convention:

| Verdict                         | Exit code | What it means                                                       |
| ------------------------------- | --------- | ------------------------------------------------------------------- |
| `Passed`, nothing unresolved    | 0         | Every gate was evaluated and met.                                   |
| `Failed`                        | 1         | A gate the run measured was missed.                                 |
| `Inconclusive`                  | 5         | Nothing decidable. Repair the harness.                              |
| `Passed` with unresolved faults | 5         | The gates were met over fewer observations than the suite declared. |

`ScoreGate.ciGrade` is the same mapping over a whole `SuiteReport`, with a
summary line that counts the cases and `kind: "score"` samples behind a clean
pass. Inconclusive observations do not count as scored evidence.

[Gate a scored suite](/guides/gate-a-scored-suite/) runs one end to end.
