---
title: "Quickstart"
description: "Score inside a durable action and replay it over the same SQL journal."
sidebar:
  order: 2
---

Install `@smthrs/scorers@next`, `@smthrs/flow@next`,
`@smthrs/plan@next`, `@smthrs/platform-node@next`, and `effect`.
This example uses the real Node host and its on-disk SQL journal. Each step
below is TypeScript; the [VibeLang tab](#the-same-walkthrough-in-vibelang) runs
the same steps as Effect code.

## Declare the action

The payload contains serializable inputs and a stable job identity. Reconstruct
the score Effect when the action executes; never put an Effect in the payload.

```ts
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { NodeRuntime } from "@smthrs/platform-node"
import { Scorers, Scoring, SqlScoreStore } from "@smthrs/scorers"
import { Effect, Layer, Schema } from "effect"
import { resolve } from "node:path"

const Grade = Action.make("example/Grade", {
  payload: {
    jobKey: Schema.String,
    output: Schema.String,
    expected: Schema.String,
    at: Schema.Number
  },
  success: Schema.Void,
  implementationVersion: "grade/v1"
})
const GradeFlow = Flow.make("example/GradeFlow", {
  payload: Grade.payloadSchema,
  success: Schema.Void,
  body: Node.capture({ action: Grade.name }, (payload) => Grade.call(payload))
})
```

## Attach scoring and the store

`SqlScoreStore.layer` applies the scorer migrations using the database and
durable writer supplied by the Node host. A failed store write must not mark
the action complete; the caller fails it and the engine owns any retry policy.
Scorer failures themselves become typed inconclusive observations.

```ts
const exact = Scorers.exact()
const implementation = Grade.toLayer(({ jobKey, output, expected, at }) =>
  Effect.gen(function*() {
    const outcomes = yield* Scoring.runBatchCorrelated([{
      identity: Scoring.jobIdentity([jobKey, exact.scorerKey]),
      observation: { targetStepKey: jobKey, scorerKey: exact.scorerKey },
      score: exact.score({ input: null, output, groundTruth: expected }),
      at
    }])
    if (outcomes.some((outcome) => outcome.recorded === "failed")) {
      return yield* Effect.die("Scoring observation could not be persisted")
    }
  }), { implementationVersion: "grade/v1" }).pipe(Layer.provide(SqlScoreStore.layer))
```

`runBatchCorrelated` returns each job identity, its observation and `recorded`:
`persisted`, `duplicate`, or `failed`. `runBatch` returns only the observations.
Both await all work and preserve input order. Neither accepts background work.

## Run on a durable host

```ts
const workspaceRoot = resolve(".")
const host = NodeRuntime.layerHost({
  filename: `${workspaceRoot}/.flows/scoring.sqlite`,
  workspaceRoot,
  owner: { hostId: "scoring-example" }
}, Interpreter.layerWithImplementations(GradeFlow, implementation))

await Effect.runPromise(
  GradeFlow.execute({
    jobKey: "greet/ada",
    output: "Hello, Ada",
    expected: "Hello, Ada",
    at: 1
  }, { executionId: "grade-ada-1" }).pipe(Effect.provide(host), Effect.scoped)
)
```

Run the same file again: the completed action replays its journaled result
without executing the scorer. An interrupted runtime resumes unfinished work
under the same execution identity. If the observation committed before the
action result did, `recordOnce` deduplicates the observation by job identity.
External scorer side effects still need their own stable idempotency keys.

See [Durability](./durability.md),
[Run a batch](./guides/run-a-batch-of-scorers.md), and
[Read scores back](./guides/read-scores-back.md).

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) the implementation is an
`effect` arrow passed to `Grade.toLayer`, so `try` runs the batch and `die`
fails the action without `Effect.gen`. `main` takes the workspace root instead
of reading the current directory, and a `provide` block supplies the Node host.
Call it twice over the same root and the second call replays the journaled
action, as above.

This is `examples/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

```vibe
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { NodeRuntime } from "@smthrs/platform-node"
import { Scorers, Scoring, SqlScoreStore } from "@smthrs/scorers"

export const Grade = Action.make("example/Grade", {
  payload: {
    jobKey: Schema.String,
    output: Schema.String,
    expected: Schema.String,
    at: Schema.Number
  },
  success: Schema.Void,
  implementationVersion: "grade/v1"
})

export const GradeFlow = Flow.make("example/GradeFlow", {
  payload: Grade.payloadSchema,
  success: Schema.Void,
  body: Node.capture({ action: Grade.name }, (payload) => Grade.call(payload))
})

const exact = Scorers.exact()

/** Scores inside the action; a store write that failed must not complete it. */
export const implementation = Grade.toLayer(effect ({ jobKey, output, expected, at }) => {
  const outcomes = try Scoring.runBatchCorrelated([{
    identity: Scoring.jobIdentity([jobKey, exact.scorerKey]),
    observation: { targetStepKey: jobKey, scorerKey: exact.scorerKey },
    score: exact.score({ input: null, output, groundTruth: expected }),
    at
  }])
  if (outcomes.some((outcome) => outcome.recorded === "failed")) {
    try die("Scoring observation could not be persisted")
  }
}, { implementationVersion: "grade/v1" }) |> Layer.provide(%, SqlScoreStore.layer)

/** Grades one job on the Node host whose SQL journal lives under `workspaceRoot`. */
export effect function main(workspaceRoot: string) {
  const host = NodeRuntime.layerHost({
    filename: `${workspaceRoot}/.flows/scoring.sqlite`,
    workspaceRoot,
    owner: { hostId: "scoring-example" }
  }, Interpreter.layerWithImplementations(GradeFlow, implementation))

  try scoped(effect {
    provide host {
      try GradeFlow.execute({
        jobKey: "greet/ada",
        output: "Hello, Ada",
        expected: "Hello, Ada",
        at: 1
      }, { executionId: "grade-ada-1" })
    }
  })
}
```
