---
title: "Normal mode and fast mode"
description: "Normal mode runs every target a change affects; fast mode also skips targets the model predicts a change cannot break, and the replay measures what that skipping misses."
---

`--mode` picks which modes the replay measures: `normal` (the default), `fast`,
or `both`.

|                  | Normal mode                              | Fast mode                                                |
| ---------------- | ---------------------------------------- | -------------------------------------------------------- |
| Runs             | Every target the change affects          | The targets normal mode runs, minus those predicted safe |
| Reuses a result  | Only when its key matches                | The same                                                 |
| A skipped target | Skipped only because a dependency failed | Also skipped by prediction                               |

## Normal mode

Normal mode is the Bazel way. A change selects the targets whose dependency
closure it reaches, and each of those targets either is a cache hit, because
its key matches a result already stored, or runs. A target that does not run
because a dependency failed is reported as skipped for that reason.

Normal mode reuses a result only when the target's key matches, and an equal
key means an equal verdict.

### A first run

With nothing to reuse, normal mode runs every command your CI runs. Three
things differ from your CI:

- A step two jobs both start with, such as an install, runs once.
- Jobs that can write the same files run one after another, where your CI
  runs them on separate machines.
- Starting Smithers build takes a few seconds, once per run.

So the first run of a short CI can take longer than the baseline. The runs
after it reuse every result whose inputs did not change.

## Fast mode

Fast mode starts from the targets normal mode selects, then skips the ones
the model that predicts which tests a change cannot break
says are safe to skip. It can miss a failure; the replay counts every one it
would have missed.

A target fast mode skips is reported as skipped, with the reason
`predicted-safe`. It is never reported as passed and never written to the
cache, so a later run cannot mistake it for a result.

### How a target gets its score

The method follows Machalica, Samylkin, Porth and Chandra, "Predictive Test
Selection" ([arXiv:1810.05286](https://arxiv.org/abs/1810.05286)), sections III
and IV.

One **entry** is one change and one target the dependency graph selects for it.
The model reads these features of each entry:

- the extensions of the changed files;
- how many times those files changed in the last 3, 14 and 56 days;
- the target's failure rate over the last 7, 14, 28 and 56 days;
- the project the target belongs to;
- the number of tests in the target;
- the shortest dependency-graph distance from a changed file to the target.

For each entry the model returns a score from 0 to 1: the chance the target
fails on that change.

Two settings turn scores into a selection. A target runs when its score is at
least the **score cutoff**, or when it is among the **count cutoff**
highest-scoring targets of its change. Every other target is skipped.

### How fast mode is measured

The replay runs normal mode on the same commits, so every entry has a known
outcome. An entry counts as failed only when every attempt failed. An entry whose
attempts disagreed is flaky, and a flaky entry is never counted as a failure.

The report gives the paper's three metrics:

| Metric         | Meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| Test recall    | Of all failures, the share whose target fast mode ran.                         |
| Change recall  | Of all changes with a failure, the share where fast mode ran a failing target. |
| Selection rate | Targets fast mode ran, divided by the targets the dependency graph selected.   |

It also gives the counts behind them: entries, targets selected, failures, and
changes with a failure. When no entry failed, the report gives no recall, since
recall is defined only over a set with at least one failure. Read a recall with
its count: a recall measured over a few failures says little.

Every failure fast mode missed is also a mismatch in the report, and a mismatch
makes the command exit with code 1.

## See also

- [How it works](how-it-works.md)
- [Command reference](../reference/cli.md)
