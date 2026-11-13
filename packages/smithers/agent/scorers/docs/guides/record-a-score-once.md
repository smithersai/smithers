---
title: "Record a score exactly once"
description: "Build a durable job identity, claim it with recordOnce, and understand what a retry, a crash, and a rolled-back transaction each do to the claim."
sidebar:
  order: 4
---

Scoring is retried: a batch is re-dispatched, a process crashes and resumes, a
queue redelivers. Without a claim, each retry appends another row for work that
already happened, and the score history stops being a history. `recordOnce`
makes the write idempotent against an identity you choose.

## Build the identity

```ts
import { Scoring } from "@smthrs/scorers"

const identity = Scoring.jobIdentity(["run-1", "greet/ada", contains.scorerKey])
```

`jobIdentity` length-prefixes every component under a `v1` prefix, so no
character inside a component can imitate a boundary:

```text
v1:5:run-1:9:greet/ada:64:9aa8b7b36ddaf6599509edf03e0eef728b2fba7c96ec5cc51f74b5e4d3b7a769
```

Never build an identity by joining strings with a delimiter. Joining lets two
different tuples produce one identity, and one shared identity silently drops
every observation after the first. No delimiter is safe: any character a
delimiter could use can also appear inside a component.

Three properties make an identity correct:

- **Non-empty**, and at most `ScoreStore.maxIdentityBytes` (512) UTF-8 bytes.
  Either violation fails with code `invalid_request` naming the problem.
- **Stable across a restart.** An identity derived from a process id, a random
  value, or a wall clock defeats the whole mechanism: the retry after a crash
  claims a fresh identity and records a second observation for the same work.
- **Unique per unit of work.** A run id, the target step key, and the scorer
  key are the usual three components, because together they name exactly one
  grading attempt.

## Claim and write in one transaction

```ts
import { ScoreStore } from "@smthrs/scorers"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const store = yield* ScoreStore.ScoreStore
  return yield* store.recordOnce(identity, {
    kind: "score",
    targetStepKey: "greet/ada",
    scorerKey: contains.scorerKey,
    score: 1,
    at: Date.now()
  })
})
```

`recordOnce` returns `true` when it claimed the identity and wrote the
observation, and `false` when the identity was already claimed and nothing was
written. Both happen inside one transaction: the claim row in
`flows_score_jobs` and the observation row in `flows_scores` commit together or
not at all.

A [runner](./run-a-batch-of-scorers.md) calls this for you with the job's
`identity`, so most callers never invoke it directly. `runBatchCorrelated`
reports the answer as `recorded: "persisted"` or `recorded: "duplicate"`.

## What each failure does to the claim

- **A failure inside the transaction rolls the claim back**, so the job can be
  retried. A committed claim survives a process restart against the same
  database file.
- **A contradictory driver result fails the whole transaction.** The claim is a
  single-row insert with `ON CONFLICT DO NOTHING`, so it may affect only zero
  or one row. Zero is the duplicate path and one proceeds to the observation
  insert; any other count rolls everything back rather than guessing.
- **A rejected observation never opens a transaction.** The observation is
  validated and fully encoded when `recordOnce` is called, so an invalid one
  fails before the claim exists and before the single-writer lock is taken.

The affected-row count is read through `DurableWriter.affectedRows`, which is
dialect-agnostic and accepts the bigint that `SqlClient.SafeIntegers` produces.
Reading a driver's own numeric `changes` treated that bigint as "already
claimed", committed the claim, and dropped the observation forever on every
retry. The details are in [Durability](../durability.md#idempotency).

## When you want repetition instead

`recordOnce` is for one unit of work recorded once. Scoring the same target
repeatedly over time is a different intent, and `record` is the entry point for
it: it appends without a claim, and the store keeps every row. See
[Observations](../concepts/observations.md#repetition-is-expected).

## Next

- [Read scores back](./read-scores-back.md): page a long history and aggregate
  it.
- [Durability](../durability.md): what the store refuses to persist, and how
  to prune old observations and job claims.
