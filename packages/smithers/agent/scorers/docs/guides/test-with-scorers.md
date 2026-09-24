---
title: "Test code that uses scorers"
description: "Run scorers deterministically in a test: the in-memory database, the two noop seams, a fake store that records what it was handed, and the invariants worth asserting."
sidebar:
  order: 6
---

Everything nondeterministic in this package is an argument or a service: the
timestamp comes from the caller, the sampling decision is pure, and the store
is a layer. A test swaps the services and asserts on the rows.

## Run against a real store in memory

`TestDatabase.layer` composes the production Node SQLite driver and the durable
writer over a fresh `:memory:` database, so the store under test is the real
one, migrations included:

```ts
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Runner, RunnerLive, ScoreStore, SqlScoreStore } from "@smthrs/scorers"
import { Effect, Layer } from "effect"

const scoring = RunnerLive.layer({ concurrency: 2 }).pipe(
  Layer.provideMerge(SqlScoreStore.layer),
  Layer.provide(TestDatabase.layer)
)

const run = <A, E>(program: Effect.Effect<A, E, Runner.Runner | ScoreStore.ScoreStore>) =>
  Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(scoring))))
```

Compose the database layer once. Building `TestDatabase.layer` twice opens two
`:memory:` databases, and the store's tables are invisible to the second one.

Pass a fixed `at` to every job. Two runs over the same inputs then produce
byte-identical rows, which is what makes a golden assertion possible.

## Substitute a store that records what it was handed

When the subject is the code that builds jobs rather than the store,
`ScoreStore.ScoreStore.of` takes a service value directly, so a test can
capture every write:

```ts
import { ScoreStore } from "@smthrs/scorers"
import { Effect } from "effect"

const seen: Array<{ readonly identity: string; readonly observation: ScoreStore.Observation }> = []

const recording = ScoreStore.ScoreStore.of({
  record: () => Effect.void,
  recordOnce: (identity, observation) =>
    Effect.sync(() => {
      seen.push({ identity, observation })
      return true
    }),
  observations: () => Effect.succeed([]),
  aggregate: () => Effect.succeed(undefined),
  prune: () => Effect.succeed({ observations: 0, jobs: 0 })
})
```

Provide it with `Effect.provideService(ScoreStore.ScoreStore, recording)`.
Returning `false` from `recordOnce` simulates a duplicate claim; failing it with
a `ScorerError` simulates a store outage, which the runner logs and reports as
`recorded: "failed"`.

## The two noop seams

Both are explicit absences, not stubs to be avoided:

| Service      | Explicit absence       | Behavior                                                        |
| ------------ | ---------------------- | --------------------------------------------------------------- |
| `ScoreStore` | `ScoreStore.layerNoop` | Accepts every write, claims every identity, reads back nothing. |
| `Runner`     | `Runner.layerNoop`     | Accepts every job, runs no scorer, returns empty batches.       |

Use `ScoreStore.layerNoop` to exercise a runner without a database, and
`Runner.layerNoop` to run a host with scoring switched off entirely. Neither
fails, so a composition that provides one still type-checks and still runs.

## What to assert

The invariants worth pinning are the ones this package promises:

- **A failing scorer does not fail the batch.** Run a job whose `score` fails
  and assert the returned observation is `kind: "inconclusive"` with the code
  you expect. `invalid_score` for an out-of-contract result, `inconclusive` for
  anything else that is not a `ScorerError`.
- **Interruption still propagates.** Interrupting a batch must not produce
  observations for the interrupted jobs.
- **A retry records once.** Run the same batch twice and assert the second
  round reports `duplicate` for every job.
- **A sampling decision is stable.** Call `Sampling.decide` twice with the same
  tuple and assert one answer, and bracket a known ratio to pin the hash. A
  golden vector for one tuple is the pattern.
- **A declaration is refused at plan time.** `Scorer.make` throws
  synchronously, so assert with a `try`/`catch` or `expect(...).toThrow`, not
  with an Effect failure.

## Do not stub the scorer

A scorer is already a pure function of its input. Substituting it removes the
only part of the system that has behavior worth testing. Give the real scorer a
fixed input instead, and swap the store when you want the write path out of the
way.

## Next

- [Run a batch of scorers](./run-a-batch-of-scorers.md): the composition this
  guide substitutes into.
- [Troubleshooting](../troubleshooting.md): the failures a test is most likely
  to hit first.
