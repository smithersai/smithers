---
title: "Exported members"
description: "Every categorized member reachable through the root namespaces of @smthrs/scorers, with its kind, category, and one-line summary."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/scorers/docs/exports.md"
---

Every categorized member reachable through the root namespaces, in source
order. Signatures, bounds, and the reasoning behind each rule are on the
[API reference](/reference/api/).

10 namespaces, 61 documented members.

| Export                               | Kind      | Category     | Summary                                                                                       |
| ------------------------------------ | --------- | ------------ | --------------------------------------------------------------------------------------------- |
| `ScorerError.ScorerErrorCode`        | const     | models       | Stable scorer failure codes.                                                                  |
| `ScorerError.ScorerErrorCode`        | type      | models       | Stable scorer failure code.                                                                   |
| `ScorerError.ScorerError`            | class     | errors       | A typed scorer declaration, execution, or persistence failure.                                |
| `Scorer.Input`                       | const     | schemas      | Input supplied to a scorer flow.                                                              |
| `Scorer.Input`                       | type      | models       | Input supplied to a scorer flow.                                                              |
| `Scorer.Result`                      | const     | schemas      | Successful scorer output.                                                                     |
| `Scorer.Result`                      | type      | models       | Successful scorer output.                                                                     |
| `Scorer.Scorer`                      | interface | models       | A scorer is an ordinary flow with an independent declaration identity.                        |
| `Scorer.MakeOptions`                 | type      | models       | Options accepted by `make`.                                                                   |
| `Scorer.make`                        | const     | constructors | Declares a scorer flow and derives its scorer key from its own declaration.                   |
| `Scorer.validate`                    | const     | validation   | Decodes a scorer result against `Result`.                                                     |
| `Binding.Binding`                    | interface | models       | A scorer, optional ground truth, and deterministic sampling policy attached to a target flow. |
| `Binding.make`                       | const     | constructors | Creates a scorer binding, defaulting to sampling every target step.                           |
| `Sampling.Sampling`                  | const     | schemas      | Sampling policy for a scorer binding.                                                         |
| `Sampling.Sampling`                  | type      | models       | Sampling policy for a scorer binding.                                                         |
| `Sampling.decide`                    | const     | predicates   | Decides a ratio sample from stable target, scorer, and seed material.                         |
| `ScoreStore.maxReasonBytes`          | const     | models       | Maximum stored size of an observation `reason`, in UTF-8 bytes.                               |
| `ScoreStore.maxMetadataBytes`        | const     | models       | Maximum stored size of an observation `meta`, encoded, in UTF-8 bytes.                        |
| `ScoreStore.maxIdentityBytes`        | const     | models       | Maximum size of a `recordOnce` job identity, in UTF-8 bytes.                                  |
| `ScoreStore.maxObservations`         | const     | models       | Largest page `Service.observations` will return, and its default.                             |
| `ScoreStore.ObservationBase`         | interface | models       | Fields shared by successful and inconclusive observations.                                    |
| `ScoreStore.ScoreObservation`        | interface | models       | A successful score retained by the store.                                                     |
| `ScoreStore.InconclusiveObservation` | interface | models       | A scorer failure retained without failing its target.                                         |
| `ScoreStore.Observation`             | type      | models       | Durable scorer observation.                                                                   |
| `ScoreStore.Observation`             | const     | schemas      | Runtime contract every persisted observation is decoded against.                              |
| `ScoreStore.Aggregate`               | interface | models       | Aggregate over one target's observations.                                                     |
| `ScoreStore.Page`                    | interface | models       | Page bounds for `Service.observations`.                                                       |
| `ScoreStore.Service`                 | interface | services     | Durable score store implementation.                                                           |
| `ScoreStore.Pruned`                  | interface | models       | How many rows one `Service.prune` call removed from each table.                               |
| `ScoreStore.ScoreStore`              | class     | services     | Context service for durable scorer observations.                                              |
| `ScoreStore.makeNoop`                | const     | constructors | Constructs an inoperative score store.                                                        |
| `ScoreStore.layerNoop`               | const     | layers       | Provides the inoperative score store.                                                         |
| `ScoreStore.validate`                | const     | validation   | Decodes an observation against `Observation` before it is persisted.                          |
| `SqlScoreStore.make`                 | const     | constructors | Builds the SQL-backed score store and applies its migrations.                                 |
| `SqlScoreStore.layer`                | const     | layers       | Provides the SQL-backed score store.                                                          |
| `Runner.Job`                         | interface | models       | One scorer execution request.                                                                 |
| `Runner.BatchOptions`                | interface | models       | Batch execution options.                                                                      |
| `Runner.Recorded`                    | type      | models       | Whether a batch job's observation reached the durable store.                                  |
| `Runner.Outcome`                     | interface | models       | One batch result tagged with the job it came from and what the store did with it.             |
| `Runner.Service`                     | interface | services     | Runtime scorer runner implementation.                                                         |
| `Runner.Runner`                      | class     | services     | Context service for live and batch scorer execution.                                          |
| `Runner.makeNoop`                    | const     | constructors | Constructs an inoperative scorer runner.                                                      |
| `Runner.layerNoop`                   | const     | layers       | Provides the inoperative scorer runner.                                                       |
| `Runner.jobIdentity`                 | const     | constructors | Builds a `Job.identity` from its components.                                                  |
| `Runner.inconclusive`                | const     | converting   | Converts a scorer failure into a typed inconclusive observation.                              |
| `RunnerLive.Options`                 | interface | models       | Live runner worker configuration.                                                             |
| `RunnerLive.layer`                   | const     | layers       | Provides a scoped non-blocking queue and a blocking batch runner.                             |
| `Migrations.run`                     | const     | migrations   | Applies all score-store migrations.                                                           |
| `Migrations.layer`                   | const     | layers       | Applies score-store migrations when the layer is constructed.                                 |
| `ScoreGate.ScoreGateCode`            | const     | codes        | The five stable grading and misuse codes.                                                     |
| `ScoreGate.ScoreGateCode`            | type      | codes        | Decoded grading code.                                                                         |
| `ScoreGate.InvalidScoreSample`       | const     | codes        | Schema naming a rejected score observation.                                                   |
| `ScoreGate.InvalidScoreSample`       | type      | codes        | Decoded rejected observation.                                                                 |
| `ScoreGate.ScoreGateError`           | class     | errors       | Typed grading misuse with optional threshold, actual, and samples.                            |
| `ScoreGate.ScoreSample`              | type      | models       | One fixed score or inconclusive observation.                                                  |
| `ScoreGate.Verdict`                  | type      | models       | Passed, Failed, or Inconclusive with findings and faults kept separate.                       |
| `ScoreGate.validateSamples`          | const     | gates        | Reject every non-finite or out-of-range score.                                                |
| `ScoreGate.combine`                  | const     | grading      | Compose findings and unresolved observations in first-seen order.                             |
| `ScoreGate.grade`                    | const     | grading      | Map a verdict to exit code 0, 1, or 5 and its full summary.                                   |
| `ScoreGate.ScoreExpectation`         | interface | constructors | Mean, minimum, and per-case threshold gates.                                                  |
| `ScoreGate.expectScores`             | const     | constructors | Build gates over caller-owned fixed samples.                                                  |
