---
title: "Run a batch of scorers"
description: "Await scoring inside a durable flow action and inspect durable write outcomes."
sidebar:
  order: 3
---

Call `Scoring.runBatchCorrelated` from a caller-owned `@smthrs/flow` action.
The engine persists the action payload before execution and resumes interrupted
work. There is no submission queue. Reconstruct each job's score Effect from
serializable action inputs, and use a stable identity for every job.

```ts
import { Action } from "@smthrs/flow"
import { Scorers, Scoring } from "@smthrs/scorers"
import { Effect, Schema } from "effect"

const Grade = Action.make("example/Grade", {
  payload: { run: Schema.String, output: Schema.String, expected: Schema.String },
  success: Schema.Void,
  implementationVersion: "grade/v1"
})
const exact = Scorers.exact()
const implementation = Grade.toLayer(({ run, output, expected }) =>
  Effect.gen(function*() {
    const outcomes = yield* Scoring.runBatchCorrelated([{
      identity: Scoring.jobIdentity([run, "answer", exact.scorerKey]),
      observation: { targetStepKey: "answer", scorerKey: exact.scorerKey },
      score: exact.score({ input: null, output, groundTruth: expected }),
      at: 1
    }])
    if (outcomes.some((outcome) => outcome.recorded === "failed")) {
      return yield* Effect.die("Scoring observation could not be persisted")
    }
  }), { implementationVersion: "grade/v1" })
```

Provide `SqlScoreStore.layer` over the host database to `implementation`, and
register the enclosing flow with the durable engine. The job key prevents a
second observation if a crash occurs after the insert commits but before the
action result is journaled. The scorer itself can run again in that window;
external effects must use the same idempotency key. A completed action replays
its recorded result without executing the scorer again.

Both `runBatch` and `runBatchCorrelated` await all work in the calling fiber.
`runBatch` returns observations; `runBatchCorrelated` also reports each job's
identity and whether the insert was `persisted`, `duplicate`, or `failed`.
Results preserve input order. `concurrency` defaults to 1 and accepts a positive
safe integer; other values use 1.

Scorer errors become typed inconclusive observations. Non-canonical or
oversized scorer `meta` becomes inconclusive with code `invalid_observation`.
Returned `reason` and `meta` are redacted before recording or returning.
Interruption propagates.
A failed store write is logged and reported as `failed`; the caller decides
whether to fail the action under its flow retry policy. The library never
retries or re-dispatches work itself.

See [Durability](../durability.md) and
[Record a score once](./record-a-score-once.md).
