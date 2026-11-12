---
title: "Observations"
description: "The two kinds of durable record this package keeps, why a scorer failure becomes an observation instead of an error, and what an aggregate over them means."
sidebar:
  order: 3
---

An observation is the durable record of one grading attempt. There are two
kinds, and both are records: a scorer that could not answer is as much a fact
about the run as a scorer that answered 0.4.

## The two kinds

Every observation carries the target step it grades, the scorer key that
produced it, and the instant `at` the caller supplied:

```ts
interface ObservationBase {
  readonly targetStepKey: string
  readonly scorerKey: string
  readonly at: number
}

interface ScoreObservation extends ObservationBase {
  readonly kind: "score"
  readonly score: number
  readonly reason?: string | undefined
  readonly meta?: unknown
}

interface InconclusiveObservation extends ObservationBase {
  readonly kind: "inconclusive"
  readonly reason: string
  readonly code: ScorerErrorCode
}

type Observation = ScoreObservation | InconclusiveObservation
```

A `score` observation carries a finite value in `[0, 1]`, an optional `reason`
the scorer wrote, and optional `meta`. An `inconclusive` observation carries a
required non-empty `reason` and a required `code`. The runtime schema
`ScoreStore.Observation` is the single statement of those rules, and both the
write path and the read path decode against it.

`at` is the caller's, not the store's. Passing one instant for a whole batch is
what makes two runs over the same inputs produce byte-identical rows, which is
what a baseline comparison depends on.

## A scorer failure is a record, not an error

`runBatch` and `runBatchCorrelated` return `Effect`s that do not fail. When a
scorer fails, the runner converts the cause into an inconclusive observation
and carries on with the rest of the batch. The rule has one exception: fiber
interruption still propagates, because an interrupted run is not a scoring
result.

This is the design decision the whole package turns on. Grading is a side
observation of work that already happened. A judge that is unreachable, a
scorer with a bug, a model that returned prose where a number was expected:
none of those should fail the target flow, and none of them should vanish
either. They become rows.

Two fields keep an inconclusive row actionable:

- **`code`** classifies the failure, so a scorer bug (`invalid_score`) and an
  unreachable judge (`inconclusive`) are distinguishable without parsing prose.
  A `ScorerError` raised by the scorer contributes its own code; anything else
  is classified `inconclusive`. The eight codes are listed in the
  [API reference](../api.md#failures).
- **`reason`** names the cause, redacted and truncated to `ScoreStore.maxReasonBytes` on a
  code-point boundary. A fixed sentence would make a `TypeError` (a bug to fix)
  indistinguishable from an outage (something to wait out).

A score whose `meta` cannot be represented as canonical JSON, or exceeds
`ScoreStore.maxMetadataBytes` after redaction, becomes an inconclusive
observation with code `invalid_observation`. Returned reasons and metadata
are scrubbed before reaching reports or the store.

A store failure is different again: it never fails a batch either, but it is
logged as a warning and reported through `runBatchCorrelated` as
`recorded: "failed"`. Without that report, a persisted observation, a duplicate
suppressed by the job claim, and an observation lost to a database failure would
be indistinguishable. See
[Run a batch of scorers](../guides/run-a-batch-of-scorers.md).

## What an aggregate means

`ScoreStore.aggregate` reports four numbers for one target:

| Field          | Meaning                                                     |
| -------------- | ----------------------------------------------------------- |
| `count`        | How many successful scores exist.                           |
| `mean`         | Their arithmetic mean, or `undefined` when `count` is zero. |
| `min`          | The lowest of them, or `undefined` when `count` is zero.    |
| `inconclusive` | How many attempts produced no score.                        |

`inconclusive` is the denominator. Without it, a target scored a hundred times
where ninety-nine attempts failed and one returned `1.0` reports exactly what a
target scored once, cleanly, reports. Read `mean` next to `inconclusive` or the
number is not evidence.

The whole aggregate is `undefined` only when the target has no observations of
either kind. Reading a history back, including how to page one that is long, is
covered in [Read scores back](../guides/read-scores-back.md).

## Repetition is expected

Nothing collapses observations. Scoring the same target step with the same
scorer twice keeps two rows, ordered by `(at, insertion)`, which is what makes
a score history readable over time. When you need one row per unit of work
instead, that is idempotency rather than deduplication: claim a job identity
with `recordOnce`, described in
[Record a score exactly once](../guides/record-a-score-once.md).
