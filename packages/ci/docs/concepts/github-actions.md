---
title: "GitHub Actions workflows"
description: "What Smithers CI does with each part of a workflow: the event a replay stands for, expressions, conditions, the runner's variables and files, actions, and what leaves a job out."
---

A workflow step is a script and everything a GitHub runner does around it: the
runner fills `${{ }}` into the script, decides `if:`, sets variables, and passes
what one step wrote on to the next. Smithers CI does the same on your machine,
so a step replayed here does what it does on GitHub.

Nothing is guessed. A value Smithers CI cannot know leaves the job that reads it
out of the replay, and the report lists the job with what it read.

## The event a replay stands for

A workflow runs for an event. A past commit is replayed as the event that
starts its workflow:

| The workflow starts on           | The commit is replayed as            |
| -------------------------------- | ------------------------------------ |
| `pull_request`                   | a pull request to the default branch |
| `push`, and no pull request      | a push to the default branch         |
| `merge_group`, and neither above | a merge group for the default branch |

The default branch is the one your remote names, or the branch you are on when
it names none. An event whose `branches` or `branches-ignore` keep the default
branch out does not start the workflow for it, so the next event in the table
is taken.

| Event        | What is known                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request | Its head is the commit and its base is the commit's first parent, on the default branch. It has no labels, is not a draft, and comes from the repository itself. |
| Push         | `github.ref` is the default branch, `github.event.before` is the commit's first parent, and `github.event.after` is the commit.                                  |
| Merge group  | Its head is the commit and its base is the commit's first parent.                                                                                                |

A pull request's number, title and branch name exist only on GitHub. So do
`github.ref` and `github.head_ref` of a pull request. A step or a job that reads
one of them is left out.

## Expressions

`${{ }}` and `if:` are evaluated by GitHub's rules: the same literals, the same
operators in the same order, loose equality, text compared without case, and
the same values counted as false.

| Context    | What it holds                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github`   | The event above, `sha`, `workspace`, `repository`, `job`, `workflow`. `actor` is `smithers-ci`; `run_id`, `run_number` and `run_attempt` are `1`. |
| `env`      | The `env:` of the workflow, the job and the step, and what earlier steps wrote to `GITHUB_ENV`.                                                   |
| `matrix`   | The variant's values.                                                                                                                             |
| `inputs`   | What `with:` gives a local action or a called workflow, with its defaults. Empty for a push or a pull request, as on GitHub.                      |
| `vars`     | Empty.                                                                                                                                            |
| `runner`   | `os` from `runs-on`, `arch`, `temp`, `tool_cache`. `name` is `smithers-ci` and `environment` is `self-hosted`.                                    |
| `steps`    | Each earlier step's `outputs`, `outcome` and `conclusion`.                                                                                        |
| `strategy` | `job-total`, and `job-index` for a job with no matrix.                                                                                            |
| `job`      | `status`.                                                                                                                                         |

The functions are `contains`, `startsWith`, `endsWith`, `format`, `join`,
`toJSON`, `fromJSON`, `hashFiles` of files named without a wildcard, and the
status functions `success()`, `always()`, `failure()` and `cancelled()`.

What is known when the workflow is read, such as `github.event_name`, is
filled in then. What is known only while the job runs, such as
`steps.diff.outputs.base` or `github.sha`, is filled in by the step when it
starts, before its shell reads the script, as a runner does. A variable such as
`env.NODE_VERSION` is read from the file for a job's first step, and when the
step starts for every step after it: any step before may have set it anew
through `GITHUB_ENV`.

The values a local action is given with `with:` are worked out once, when the
action starts, whatever its steps change after.

Text is compared without case, as on GitHub. For text with letters beyond a
to z that differs, only GitHub can say whether it is equal: a step that makes
such a comparison while the job runs stops and says so.

`secrets` and `needs` are not read: a step that receives a secret is never run,
and a job that reads what another job gave is left out.

## Conditions

A step or a job whose `if:` is false for the event is left out, and the report
lists it with the condition. As on GitHub, an `if:` with text around its
`${{ }}`, even a line end after it, is text and so is true: write `if: ${{ x }}`
on one line, or `if: x`. A step kept for a release, or for a push to one
branch, is not run for a pull request, here or on GitHub.

A condition that depends on a step's output is decided when the step is
reached. A step it turns off prints `not run, its condition is false` and
passes, and `steps.<id>.outcome` reads `skipped`.

After a step fails, no later step of its job runs, in the baseline and in the
replay alike. So wherever a step is reached, `success()` and `always()` are true
and `failure()` and `cancelled()` are false: a step that runs only after a
failure, such as one that collects logs, is left out.

## Time limits

A step with `timeout-minutes` is stopped when it runs longer, together with
every program it started, and has failed, as on GitHub. The step prints
`stopped, it ran longer than the 10 minutes its timeout-minutes allows`. The
step and its programs are asked to stop and have ten seconds; what is still
there is then ended. Stopping the replay itself stops a step the same way.

A job's `timeout-minutes` holds each of its steps: a step that alone runs
longer than its job may is stopped. A step of a local action is held to the
limit of the step that uses the action.

Any step is stopped after six hours, so a limit of 360 minutes or more adds
nothing.

The value is a positive whole number, written out or given by an expression
that is known when the workflow is read. Any other value, such as a fraction
or a matrix value, leaves the job out: no limit is guessed.

## What a step is given

| Variable                                                                            | Value                                                                       |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `CI`, `GITHUB_ACTIONS`                                                              | `true`. A workflow that sets `CI` itself keeps its own value.               |
| `GITHUB_WORKSPACE`                                                                  | The repository root                                                         |
| `GITHUB_SHA`                                                                        | The commit, for a step that names it                                        |
| `GITHUB_EVENT_NAME`                                                                 | The event                                                                   |
| `GITHUB_EVENT_PATH`                                                                 | A file holding what is known of the event as JSON, for a step that names it |
| `GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_OWNER`                                      | From your remote                                                            |
| `GITHUB_REF`, `GITHUB_REF_NAME`                                                     | The default branch, for a push                                              |
| `GITHUB_BASE_REF`                                                                   | The default branch, for a pull request                                      |
| `GITHUB_JOB`, `GITHUB_WORKFLOW`                                                     | The job's key and the workflow's name                                       |
| `GITHUB_RUN_ID`, `GITHUB_RUN_NUMBER`, `GITHUB_RUN_ATTEMPT`                          | `1`                                                                         |
| `GITHUB_ACTOR`, `RUNNER_NAME`                                                       | `smithers-ci`                                                               |
| `RUNNER_OS`, `RUNNER_ARCH`                                                          | The system `runs-on` names, and this machine's architecture                 |
| `RUNNER_ENVIRONMENT`                                                                | `self-hosted`                                                               |
| `RUNNER_TEMP`, `RUNNER_TOOL_CACHE`                                                  | Directories of the job under `/tmp`, emptied when the job starts            |
| `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`, `GITHUB_STATE` | A fresh file for each step                                                  |

A step that writes `NAME=value`, or `NAME<<MARK` with the value on the lines up
to `MARK`, to `GITHUB_ENV` sets that variable for every later step of its job.
A line it writes to `GITHUB_PATH` goes first on `PATH` for later steps. What it
writes to `GITHUB_OUTPUT` is its `steps.<id>.outputs`. As on GitHub, a step's
own `env:` wins over `GITHUB_ENV`, and a step may not set `NODE_OPTIONS` for
later steps.

A step is given what the steps before it wrote, and nothing else. When a
change makes one step of a job run again and the steps around it are reused,
the step does not see what a later step wrote the last time the job ran.

`GITHUB_SHA` and the event file are another at every commit. A step that names
neither in its script, and reads neither `github.sha` nor the event's commits,
is given neither. What it reads is then the files it opens and what earlier
steps gave it, so its result is reused until one of those changes. A step that
does read the commit runs again at every commit.

Two jobs that start with the same step run it once and share its result. So a
job's first step is given `GITHUB_JOB` only when its script names it; every
later step is given it always. A first step that names `GITHUB_JOB`,
`RUNNER_TEMP` or `RUNNER_TOOL_CACHE` is run for each job that starts with it.

A step that only installs system packages, such as `sudo apt-get install -y zsh`,
is left out when your machine already has them. So it takes no part in what the
steps pass to one another: it is given what earlier steps set, a step that reads
its `outputs` or `outcome` leaves the job out, and one that writes to
`GITHUB_ENV`, `GITHUB_PATH` or `GITHUB_OUTPUT` stops and says so.

`RUNNER_ENVIRONMENT` is `self-hosted` because your machine is not one of
GitHub's. A step a workflow keeps for GitHub's own machines, such as one that
deletes system directories to free disk space, is left out.

A script that names another `GITHUB_` or `RUNNER_` variable leaves its job out:
no runner is there to give it.

## Actions

| A step that uses                                                    | Becomes                                                                                                                                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions/checkout`                                                  | Nothing to run: the replay made the checkout. One that asks for another repository, directory or commit, or for submodules, leaves the job out.                 |
| A setup action, such as `actions/setup-node` or `oven-sh/setup-bun` | Nothing to run. Smithers CI installs no tool: it looks for the tool on your machine before it runs the job. See [setup actions](how-it-works.md#setup-actions). |
| `actions/cache`                                                     | Nothing to run. No cache is restored, so `cache-hit` is empty, as after a miss.                                                                                 |
| `actions/upload-artifact`                                           | Nothing to run.                                                                                                                                                 |
| A local action, `./path`, that is composite                         | Its own steps, with its `inputs` and `outputs`.                                                                                                                 |
| A local workflow, `./.github/workflows/x.yml`, called by a job      | Its jobs, with its `inputs`. The calling job waits for all of them. A matrix of calls is not read, and its job is left out.                                     |
| Any other action, `actions/download-artifact` included              | Nothing: the job is left out.                                                                                                                                   |

A setup action also sets variables for the steps after it, such as
`JAVA_HOME`. Smithers CI sets none of them, so a job with a step that reads
one is left out.

## What leaves a job out

`smithers-ci inventory` shows each of these under its job, and the report lists
every job left out with the matching
[sentence](../reference/cli.md#why-a-job-is-not-replayed).

| Reason            | The job                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `condition`       | has an `if:` that is false for the event, or that reads what only GitHub knows   |
| `expression`      | has a step whose `${{ }}` reads what only GitHub knows, or what another job gave |
| `secret`          | has a step that receives a secret                                                |
| `uses`            | uses an action that is none of those above                                       |
| `checkout`        | checks out something other than the commit under replay                          |
| `runner-variable` | has a script that names a runner variable outside the list above                 |
| `services`        | starts service containers                                                        |
| `needs`           | needs a job that is left out                                                     |

A job left out is not run in the baseline either, so the times compare the same
work on both sides.
