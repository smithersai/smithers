---
title: "API reference"
description: "The exports of @smthrs/merge-queue, each with the Lean definition it mirrors."
---

Every export mirrors the definition of the same name in the Lean reference
(`lean/MergeQueue/*.lean`).

## Vocabulary (`Basic`)

| Export                                               | Meaning                                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Part`                                               | One revision of one change: `{ id, rev }`.                                                                |
| `Tree`                                               | The parts applied to the target, in order.                                                                |
| `Change`                                             | A change the queue has seen: id, priority, arrival number, revision, fix attempts used, status.           |
| `Status`                                             | `queued`, `fixing` (with the run that blamed it), `merged`, `unmergeable` (with a `Reason`), `withdrawn`. |
| `Reason`                                             | Why a change is unmergeable: `kind`, `detail` (never empty), `failures`, `attempts`.                      |
| `Run`                                                | One CI run on one exact tree: `base` followed by `batch`, with streamed `results`.                        |
| `Landing`                                            | The audit record of one landing.                                                                          |
| `Config`                                             | `required`, `maxAttempts`, `maxBatch`, `maxRuns`, `window`, `defaultDuration`.                            |
| `State`                                              | Everything the queue remembers; all of it durable.                                                        |
| `Event`                                              | `enqueue`, `withdraw`, `result`, `fixed`, `gaveUp`, `start`, `land`, `blame`, `cancel`.                   |
| `empty`                                              | The queue before anything has happened.                                                                   |
| `part`, `tree`, `samePart`, `sameTree`, `isTerminal` | Accessors and comparisons.                                                                                |

## Transitions (`Step`)

| Export                                                                     | Meaning                                                                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `step(config, state, event)`                                               | The queue. Returns the given state when the event's guard fails.           |
| `run(config, state, events)`                                               | Applies events in order.                                                   |
| `enqueue`, `withdraw`, `result`, `fixed`, `gaveUp`                         | The events that arrive from outside.                                       |
| `start`, `land`, `blame`, `cancel`                                         | The queue's decisions.                                                     |
| `answered`, `passed`, `failed`, `complete`, `green`, `failures`, `pending` | Reading a run's results. `green` is the only result that lets a tree land. |
| `before`, `inOrder`, `ready`                                               | Landing order: priority, then arrival.                                     |
| `strip`, `partReady`, `live`                                               | Whether a run can still land or blame.                                     |
| `pendingCount`, `findRun`, `failuresOf`, `record`, `exhaustedDetail`       | Counting, lookup and bookkeeping.                                          |

## Policy (`Policy`)

| Export                                                                                                                                   | Meaning                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `plan(config, state)`                                                                                                                    | The next decision, or `undefined` when the queue waits for the world.                                            |
| `settle(config, fuel, state)`                                                                                                            | Applies decisions until there is none, at most `fuel` times.                                                     |
| `landable`, `blameable`, `evidence`, `doomed`, `outOfOrder`                                                                              | Why `plan` lands, blames, keeps, cancels or waits.                                                               |
| `prefixLength`, `failedPrefixes`, `unfailedPrefixes`, `shortestFailed`, `longestUnfailed`, `nextStart`, `bestLandable`, `minOf`, `maxOf` | Speculation and bisection.                                                                                       |
| `wantsCi(config, state, run)`                                                                                                            | Whether CI should be running a run.                                                                              |
| `fixBriefs(state)`, `ahead(state, change)`, `FixBrief`, `Ahead`                                                                          | What each fix agent is given: revision, attempt, failures so far, and the changes ahead with who is fixing them. |

## Predicted durations (`Predict`)

| Export                                | Meaning                                 |
| ------------------------------------- | --------------------------------------- |
| `samples(history, check)`             | A check's remembered durations.         |
| `estimate(config, history, check)`    | Their median, or `defaultDuration`.     |
| `schedule(config, history)`           | The required checks, slowest first.     |
| `remaining(config, history, results)` | The checks of a run with no result yet. |
| `eta(config, history, results)`       | The slowest remaining check's estimate. |

## Traces (`Trace`)

| Export                                             | Meaning                                             |
| -------------------------------------------------- | --------------------------------------------------- |
| `parseLine(text)`                                  | Reads one trace line: a config, an event or `plan`. |
| `renderEvent(event)`, `renderState(config, state)` | The lines the reference prints.                     |
| `apply(config, state, line)`, `replay(lines)`      | Runs trace lines.                                   |
| `Line`, `initialConfig`                            | The parsed line and the config a trace starts from. |
