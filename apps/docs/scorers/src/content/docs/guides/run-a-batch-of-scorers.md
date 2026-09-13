---
title: "Run a batch of scorers"
description: "Compose the live runner, choose between runBatch and runBatchCorrelated, set concurrency and queue capacity, and read what happened to each durable write."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/scorers/docs/guides/run-a-batch-of-scorers.md"
---

A runner executes scorer jobs and records what they answer. `RunnerLive.layer`
provides the implementation: a scoped worker queue for fire-and-forget
submission, and a blocking batch entry point for work you wait on.

## Compose the runner over a store

```ts
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { RunnerLive, SqlScoreStore } from "@smthrs/scorers"
import { Layer } from "effect"

const scoring = RunnerLive.layer({ concurrency: 4, capacity: 256 }).pipe(
  Layer.provideMerge(SqlScoreStore.layer),
  Layer.provide(TestDatabase.layer)
)
```

`concurrency` sets both the number of queue workers and the default batch
concurrency; it defaults to 1. `capacity` bounds the submission queue and
defaults to 1024. A value that is not a positive safe integer is coerced to the
default rather than rejected, because the layer's error channel is `never` by
contract: there is no run to fail yet.

The layer is scoped: its workers are forked into the scope that builds it.
`Effect.provide` opens and closes that scope around the effect it provides, so
a job still queued when the effect ends is never scored. Build the layer once
for the life of the host rather than per call, and prefer a batch entry point
when you need the answer.

To turn scoring off without changing the code that submits jobs, provide
`Runner.layerNoop`, which accepts every job and records nothing. To keep the
runner and drop only persistence, compose it over `ScoreStore.layerNoop`.

## Describe a job

```ts
import { Runner } from "@smthrs/scorers"

const job: Runner.Job = {
  identity: Runner.jobIdentity(["run-1", "greet/ada", contains.scorerKey]),
  observation: { targetStepKey: "greet/ada", scorerKey: contains.scorerKey },
  score: contains.score({ input: "greet Ada", output: "Hello, Ada", groundTruth: "hello" }),
  at: Date.now()
}
```

`score` is an unexecuted `Effect`. The runner runs it, so a job costs nothing
until a worker takes it. Build `identity` with `Runner.jobIdentity` and never
by joining strings; see
[Record a score exactly once](/guides/record-a-score-once/).

Every field must be stable from the moment the job is submitted. `submit`
copies the scalar fields at the boundary so a later mutation cannot change what
is recorded, but the `score` Effect is yours: do not close over a value you
intend to change.

## Choose a batch entry point

Both entry points run jobs at the configured concurrency and neither fails.

```ts
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const runner = yield* Runner.Runner
  const observations = yield* runner.runBatch([job], { concurrency: 1 })
  const outcomes = yield* runner.runBatchCorrelated([job])
  return { observations, outcomes }
})
```

- **`runBatch`** returns the observations in job order, one per job. Use it
  when the caller correlates by position.
- **`runBatchCorrelated`** returns an `Outcome` per job: the job `identity`,
  the `observation`, and `recorded`, which is `"persisted"`, `"duplicate"`, or
  `"failed"`. Use it when jobs may share a target and scorer pair, or when you
  need to know what the store did.

`runBatch` records what each scorer answered. `runBatchCorrelated` also records
what the store did with the answer. A `duplicate` outcome means the identity
was already claimed; it does not claim that the returned observation matches
the one already in the store.

The per-call `concurrency` option overrides the layer's for that batch only.

## Submit without waiting

`submit` queues a job and returns:

```ts
const enqueue = Effect.gen(function*() {
  const runner = yield* Runner.Runner
  yield* runner.submit(job)
})
```

It does not wait for the scorer to run, but it backpressures once `capacity`
queued jobs are outstanding, so it is not safe on a latency-critical path. A
submitted job's result reaches you only through the store, never as a return
value.

## What failure does

One rule governs both entry points: a scorer failure becomes an inconclusive
observation and never fails the target or the batch. Batch interruption
propagates, because an interrupted run produced no result. A queued job's
interruption or defect stays local to that job; workers continue processing
submissions. Closing the layer scope interrupts running jobs.

- A scorer that fails is recorded with `code` taken from its `ScorerError`, or
  `inconclusive` for any other cause, and a `reason` naming the cause,
  truncated to `ScoreStore.maxReasonBytes`.
- A scorer that returns an out-of-contract result is recorded with code
  `invalid_score`.
- A store failure is logged with the structured error and `identity`,
  `targetStepKey`, and `scorerKey` annotations. Batch outcomes report
  `recorded: "failed"`.
  It does not fail the batch, so a `runBatch` result alone cannot tell you a
  write was lost. Use `runBatchCorrelated` when that matters.

For the reasoning, see [Observations](/concepts/observations/).

## Next

- [Record a score exactly once](/guides/record-a-score-once/): job identities and
  what survives a restart.
- [Read scores back](/guides/read-scores-back/): paging and aggregates.
