---
title: "Fast mode"
description: "What fast mode skips, how each target gets its score, what test recall, change recall and selection rate mean, and what a small history can and cannot show."
---

Fast mode runs fewer targets than [normal mode](concepts/modes.md). Normal mode
runs every target a change affects. Fast mode scores each of those targets by
how likely it is to fail on the change, runs the ones that score high, and
skips the rest.

A target fast mode skips is reported as `skipped` with the reason
`predicted-safe`. It is never a pass and never a cache entry.

Fast mode can miss a failure. The numbers on this page say how often, and
normal mode still runs everything before a release.

## What it does

1. **Entries.** After a normal-mode run of a commit, one entry is recorded per
   target that ran: the change, the target, and whether the target failed.
2. **Scores.** For a new change, each affected target gets a score from 0 to
   1, the estimated chance it fails, with a one-line reason.
3. **Selection.** Two settings turn scores into a selection. A target runs
   when its score is at least the **score cutoff**, or when it is among the
   **count cutoff** highest-scoring targets of its change.

`smithers-ci` runs with a score cutoff of 0.1 and a count cutoff of 5. So a
change that affects five targets or fewer skips nothing, and its selection rate
is 100%.

The method is Machalica, Samylkin, Porth and Chandra, "Predictive Test
Selection" ([arXiv:1810.05286](https://arxiv.org/abs/1810.05286)), sections
III to VI.

## An entry

| Field                       | What it holds                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Changed file extensions     | Lowercased and distinct. Every file with no extension, such as `Justfile`, counts once, as `(none)`.        |
| Changes to those files      | How many earlier commits touched one of the changed files in the 3, 14 and 56 days before the change.       |
| The target's failure rate   | The share of the target's recorded runs that failed in the 7, 14, 28 and 56 days before the change.         |
| Project                     | The directory in the target's label. The root package is `.`.                                               |
| Test count                  | The number of test files in the target's project.                                                           |
| Dependency-graph distance   | The fewest dependency edges from a changed file's project to the target. `-1` when no path is known.        |
| Attempts, `failed`, `flaky` | A target is `failed` only when every attempt failed. Attempts that disagree make it `flaky`, not a failure. |

A target that never ran has no entry: a cache hit, a target skipped because a
dependency failed, and a target fast mode skipped all have no outcome to learn
from. Entries are built only from a normal-mode run.

The failure rates come from earlier entries, so a repository's first runs have
rates of 0 everywhere. The distance needs the change's plan; without one, a
target is at distance 0 only inside a changed file's own project.

## A score

Scores come from the model that predicts which tests a change cannot break. It
reads an entry's six features and nothing else: not the target's name, not the
diff. For each entry it answers the chance the target fails, and which fact most
decides that: the failure rate, the distance, the changes to those files, the
extensions, the test count, or none of them.

A skipped target is listed with why it was safe to skip, read from that fact as
the features measured it. Where the fact points to a failure, such as a changed
file the target depends on, the list gives no reason rather than a wrong one:

| The fact               | Reason a skip carries                                              | When                          |
| ---------------------- | ------------------------------------------------------------------ | ----------------------------- |
| Failure rate           | No failure on record in the last 56 days.                          | Every failure rate is 0       |
| Distance               | No known path leads from the change to it in the dependency graph. | No path is known              |
| Changes to those files | The changed files had no other change in the 56 days before.       | No change in 56 days          |
| Extensions             | Only .md files changed.                                            | Always, naming the extensions |
| Test count             | None                                                               | Never                         |
| None                   | Nothing in its history or in the change points to a failure.       | Always                        |

Entries with equal features share one question, so a change with thousands of
targets asks about a few dozen feature sets. An answer is kept for the rest of
the run, so no question is paid for twice. When the model cannot answer, no score
is guessed.

## Reaching the model

Fast mode reaches the model one of three ways:

| Way         | What to do                                              |
| ----------- | ------------------------------------------------------- |
| A key       | Set `AI_GATEWAY_API_KEY`.                               |
| Claude Code | Run `claude auth login` with `ANTHROPIC_API_KEY` unset. |
| Codex       | Run `codex login` with `SMITHERS_OPENAI_AUTH=chatgpt`.  |

Before a replay copies or runs anything, `smithers-ci` asks the model one small
question. When the model cannot answer, the command exits `4` at once with one
line that says what is missing and how to supply it. `--mode normal` does not
use the model.

When the model stops answering during a replay, fast mode stops and the rest of
the replay goes on. The baseline and normal mode finish for every commit, and
the report holds all of them. It holds no fast-mode number, because part of a
measurement is not one, and it says fast mode was not measured and why. The
same line goes to standard error, and the command exits `4`.

## The three numbers

| Number         | Meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| Test recall    | Of all failures, the share whose target fast mode ran.                         |
| Change recall  | Of all changes with a failure, the share where fast mode ran a failing target. |
| Selection rate | Targets fast mode ran, divided by the targets normal mode ran.                 |

A missed failure lowers test recall. A change whose every failure was missed
lowers change recall: that change would have looked green. A selection rate of
0.3 means fast mode ran three targets in ten.

Every number is reported with its counts: failures caught of failures, changes
caught of failed changes, targets run of targets. When no entry failed, no recall
is reported at all.

The report prints them under `fast mode`, then what the model was asked, then
every target fast mode skipped:

```text
fast mode
test recall      92%  11 of 12 failures
change recall    92%  11 of 12 failed changes
selection rate   63%  120 of 192 targets
the model answered 24 questions in 3m 05s, which is in fast mode's times
over the commits these times cover, fast mode's runs took 1m 42s less than normal mode's and asking the model took 1m 31s

skipped, predicted-safe
3f2a1c9  3 steps  Nothing in its history or in the change points to a failure.  //:ci.yml-unit-api-1, //:ci.yml-unit-cli-1, //:ci.yml-unit-core-1
```

A line of the list is one commit and one reason: how many steps, why they were
safe to skip when the features say, and the steps, the first five by name.
`--json` holds every one, with its score, in the commit's `skipped`.

## What the model costs

The model takes time to answer, and a fast-mode run waits for it before it
starts. So that time is in fast mode's times: in each commit's, and in the
total beside the baseline's and normal mode's. The report says how many
questions the model answered and how long that took over the whole replay
(`model` under `--json`, and for each commit in its own `model`). The next line
sets the two against each other over the commits the times cover: how much
less fast mode's runs took than normal mode's, and how long asking took.

Fast mode pays when what it skips takes longer than the model's answer. On a
CI whose steps take seconds, asking costs more than skipping saves, and the
report shows fast mode slower than normal mode.

Facebook's bar before a merge is a test recall above 0.95 and a change recall
above 0.999.

## What a small history cannot show

A change recall of 0.999 means one failed change in a thousand goes unseen. A
history with fewer than a thousand failed changes cannot show that, and showing
it with 95% confidence takes about 2,700 failed changes, every one caught.

| Failed changes, all caught | The most that supports at 95% confidence |
| -------------------------: | ---------------------------------------- |
|                         10 | Change recall above 0.787                |
|                        100 | Change recall above 0.974                |
|                      1,000 | Change recall above 0.997                |
|                      2,700 | Change recall above 0.999                |

So on a small history the report states the recall it measured and the count
behind it, and never claims the bar.

## The eval

The eval measures fast mode the way the paper measures its model.

- **Split by time.** The newest seven days of entries are the test set. Earlier
  entries only supply the test set's failure rates; the classifier is not trained.
- **Score.** The real model gives every change of the test set its scores.
- **Sweep.** The score cutoff is swept with the count cutoff at 0, and the
  count cutoff with the score cutoff at 1.
- **Weekly check.** The paper accepts a new model when, at a test recall of at
  least 0.9 with the count cutoff at 0, the selection rate is below 0.3. The
  eval says whether that passes. When it does not, fast mode stays off.
- **Calibrate.** The highest swept score cutoff whose test recall passes the
  bar is taken, then the lowest swept count cutoff that, with it, passes the
  change-recall bar. The two are measured together.
- **Refuse.** With no failure in the test set there is no recall to report.
  When a change could not get a score there is no report: the recall of part of
  a test set is not the test set's recall.

It is a Smithers eval: a suite with one case per change, graded per change by
two measures (`caught`, the share of the change's failures selected, and
`skipped`, the share of its targets skipped).

### Running it

From `packages/ci`, with entries in `rows.jsonl` in a directory of your choice:

```sh
SMITHERS_CI_EVAL_DIR=<directory> pnpm exec vitest run --config evals/vitest.config.ts
```

| Variable                       | What it does                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `SMITHERS_CI_EVAL_DIR`         | Where `rows.jsonl` is and where the run's journal, `eval.sqlite`, is kept.       |
| `SMITHERS_CI_EVAL_CHANGES`     | Scores that many evenly spaced changes of the test week in place of all of them. |
| `SMITHERS_CI_EVAL_CONCURRENCY` | How many changes the model answers for at once. The default is 4.                |

With `SMITHERS_CI_EVAL_DIR` unset the eval is skipped. A run that stops is run
again with the same command: the journal answers every request it already
answered. `evals/merge-queue-history.ts` derives `rows.jsonl` from the VibeLang
merge queue's run records.

## Measured on VibeLang's merge queue

Run on 2026-11-18 on the build server. The history is the VibeLang merge
queue's 159 trains from 2026-11-07 to 2026-11-14, each one change: 458,062
entries. The test week is its newest seven days.

| What          | Count                                                                               |
| ------------- | ----------------------------------------------------------------------------------- |
| Test set      | 443,007 entries in 152 changes                                                      |
| Failures      | 687, in 94 changes                                                                  |
| Flaky entries | 41, not counted as failures                                                         |
| Model         | GPT-6 Luna, through a subscription. The build server holds no `AI_GATEWAY_API_KEY`. |
| Requests      | 481, in 17 minutes. A second run replayed every one from the journal, in 2 minutes. |

| Settings                                    | Test recall        | Change recall    | Selection rate             |
| ------------------------------------------- | ------------------ | ---------------- | -------------------------- |
| Score at least 0.05, top 5 (the start)      | 0.531 (365 of 687) | 0.915 (86 of 94) | 0.011 (4,875 of 443,007)   |
| Score at least 0.1                          | 0.376 (258 of 687) | 0.872 (82 of 94) | 0.005 (2,249 of 443,007)   |
| Score at least 0.02                         | 0.674 (463 of 687) | 0.957 (90 of 94) | 0.091 (40,298 of 443,007)  |
| Score at least 0.01 (calibrated to the bar) | 0.985 (677 of 687) | 1.000 (94 of 94) | 0.867 (384,083 of 443,007) |
| Top 100 only                                | 0.667 (458 of 687) | 0.957 (90 of 94) | 0.029 (12,935 of 443,007)  |

What the numbers say:

- **The weekly check does not pass.** A test recall of 0.9 needs a selection
  rate of 0.867, and the paper requires one below 0.3. On this history fast
  mode stays off.
- At Facebook's bar, fast mode skips 13% of the targets.
- Skipping 91% of the targets misses a third of the failures, and every
  failure of 4 of the 94 failed changes.
- 94 failed changes, all caught, support a change recall above 0.972 at 95%
  confidence. They cannot show 0.999.

Why the scores separate so little here:

- 240 of the 687 failures were at targets with no recorded failure. Their
  entries read like the passing entries around them, and 224 failures had a
  score below 0.02, where 400,000 passing entries also sit.
- The queue kept no dependency graph per train, so the distance says only
  whether a target is in a changed file's project.
- 684 of the 687 failures ran once. The queue reran few failures, so some are
  flaky failures that the paper's ten attempts would have removed.
- Only 15,055 entries, eight hours of them, precede the test week. A target's
  failure rate is built from the test week's own earlier changes.

One more line.
