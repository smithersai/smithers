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

| Context    | What it holds                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `github`   | The event above, `sha`, `workspace`, `repository`, `job`, `workflow`, `run_id`, `run_number`, `run_attempt`. `actor` is `smithers-ci`. |
| `env`      | The `env:` of the workflow, the job and the step, and what earlier steps wrote to `GITHUB_ENV`.                                        |
| `matrix`   | The variant's values.                                                                                                                  |
| `inputs`   | What `with:` gives a local action or a called workflow, with its defaults. Empty for a push or a pull request, as on GitHub.           |
| `vars`     | Empty.                                                                                                                                 |
| `runner`   | `os` from `runs-on`, `arch`, `temp`, `tool_cache`. `name` is `smithers-ci` and `environment` is `self-hosted`.                         |
| `steps`    | Each earlier step's `outputs`, `outcome` and `conclusion`.                                                                             |
| `strategy` | `job-total`, and `job-index` for a job with no matrix.                                                                                 |
| `job`      | `status`.                                                                                                                              |

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

Every step is given every
[default variable of a GitHub runner](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables),
whatever it runs. A test that reads `process.env.GITHUB_SHA` from its own code
finds the commit, as it does on GitHub.

| Variable                                                                                                                         | Value                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `CI`, `GITHUB_ACTIONS`                                                                                                           | `true`. A workflow that sets `CI` itself keeps its own value.                          |
| `GITHUB_WORKSPACE`                                                                                                               | The repository root                                                                    |
| `GITHUB_SHA`, `GITHUB_WORKFLOW_SHA`                                                                                              | The commit                                                                             |
| `GITHUB_RUN_ID`, `GITHUB_RUN_NUMBER`, `GITHUB_RUN_ATTEMPT`                                                                       | An id made from the commit, the number of commits up to it, and `1`                    |
| `GITHUB_EVENT_NAME`                                                                                                              | The event                                                                              |
| `GITHUB_EVENT_PATH`                                                                                                              | A file holding what is known of the event as JSON                                      |
| `GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_OWNER`                                                                                   | From your remote. `local` and the directory's name when there is none.                 |
| `GITHUB_REF`, `GITHUB_REF_NAME`                                                                                                  | The default branch, for a push. `refs/pull/1/merge` and `1/merge`, for a pull request. |
| `GITHUB_BASE_REF`, `GITHUB_HEAD_REF`                                                                                             | The default branch and `smithers-ci`, for a pull request. Empty for any other event.   |
| `GITHUB_REF_TYPE`, `GITHUB_REF_PROTECTED`                                                                                        | `branch` and `false`                                                                   |
| `GITHUB_JOB`, `GITHUB_WORKFLOW`                                                                                                  | The job's key and the workflow's name                                                  |
| `GITHUB_WORKFLOW_REF`                                                                                                            | The workflow's file and `GITHUB_REF`                                                   |
| `GITHUB_ACTION`                                                                                                                  | The step's `id`, or `__run` with its place in the job                                  |
| `GITHUB_ACTOR`, `GITHUB_TRIGGERING_ACTOR`, `RUNNER_NAME`                                                                         | `smithers-ci`                                                                          |
| `GITHUB_ACTOR_ID`, `GITHUB_REPOSITORY_ID`, `GITHUB_REPOSITORY_OWNER_ID`                                                          | `1`                                                                                    |
| `GITHUB_SERVER_URL`, `GITHUB_API_URL`, `GITHUB_GRAPHQL_URL`                                                                      | The addresses of github.com                                                            |
| `GITHUB_RETENTION_DAYS`                                                                                                          | `90`                                                                                   |
| `RUNNER_OS`, `RUNNER_ARCH`                                                                                                       | The system `runs-on` names, and this machine's architecture                            |
| `RUNNER_ENVIRONMENT`                                                                                                             | `self-hosted`                                                                          |
| `RUNNER_TEMP`, `RUNNER_TOOL_CACHE`                                                                                               | Directories of the job under `/tmp`, emptied when the job starts                       |
| `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`, `GITHUB_STATE`, `GITHUB_ARTIFACTS`, `GITHUB_ARTIFACTS_LIST` | A fresh file for each step                                                             |

No step is given a token: `GITHUB_TOKEN` and the `ACTIONS_` credentials are not
set. `GITHUB_ACTION_REPOSITORY` and `RUNNER_DEBUG` are not set either, as a
runner leaves them for a script with debug logging off. `GITHUB_ACTION_PATH` is
set inside an action.

A pull request's number and branch, and the numbers GitHub gives an account and
a repository, exist only on GitHub. A step still finds a value under each name:
a replayed commit stands for pull request `1` from the branch `smithers-ci`. A
script of yours that names one of them leaves its job out, as an expression
that reads one does: it would act on a value that is not GitHub's.

A step that writes `NAME=value`, or `NAME<<MARK` with the value on the lines up
to `MARK`, to `GITHUB_ENV` sets that variable for every later step of its job.
A line it writes to `GITHUB_PATH` goes first on `PATH` for later steps. What it
writes to `GITHUB_OUTPUT` is its `steps.<id>.outputs`. As on GitHub, a step's
own `env:` wins over `GITHUB_ENV`, and a step may not set `NODE_OPTIONS` for
later steps.

A step is given what the steps before it wrote, and nothing else. When a
change makes one step of a job run again and the steps around it are reused,
the step does not see what a later step wrote the last time the job ran.

The commit, the run's id, number and attempt, and the event file are another at
every commit, and every step is given them. A step that used none of them is
reused at the next commit while the files it read are unchanged. A step that
used one runs again: its result is that commit's. See
[when a step used a runner's variable](how-it-works.md#a-runners-variables).

In the workflow `smithers-ci apply` writes, GitHub's own runner gives each step
the commit, the run's id, number and attempt, and the event file. Every other
value in the table is the same there as in a replay.

Each job runs its own steps, as each has a machine of its own on GitHub. Two
jobs that start with the same step each run it, and each is told its own
`GITHUB_JOB`.

A step that only installs system packages, such as `sudo apt-get install -y zsh`,
is left out when your machine already has them. So it takes no part in what the
steps pass to one another: it is given what earlier steps set, a step that reads
its `outputs` or `outcome` leaves the job out, and one that writes to
`GITHUB_ENV`, `GITHUB_PATH` or `GITHUB_OUTPUT` stops and says so.

`RUNNER_ENVIRONMENT` is `self-hosted` because your machine is not one of
GitHub's. A step a workflow keeps for GitHub's own machines, such as one that
deletes system directories to free disk space, is left out.

A script that names a `GITHUB_` or `RUNNER_` variable outside GitHub's list
leaves its job out: no runner gives it.

### Software a runner comes with

A GitHub runner has the Android SDK, several Java versions, browser drivers,
Conda and vcpkg installed, and its variables say where they are. Steps use them
without a workflow naming them. When your machine sets one of these variables,
a step is given its value, in the baseline and in your new CI:

| Software        | Variables                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Android         | `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_NDK`, `ANDROID_NDK_HOME`, `ANDROID_NDK_ROOT`, `ANDROID_NDK_LATEST_HOME` |
| Java            | `JAVA_HOME`, `JAVA_HOME_8_X64`, `JAVA_HOME_11_X64`, `JAVA_HOME_17_X64`, `JAVA_HOME_21_X64`, `JAVA_HOME_25_X64`       |
| Browser drivers | `CHROMEWEBDRIVER`, `EDGEWEBDRIVER`, `GECKOWEBDRIVER`, `SELENIUM_JAR_PATH`                                            |
| Packages        | `CONDA`, `VCPKG_INSTALLATION_ROOT`                                                                                   |

A step that sets one of them itself keeps its own value. Smithers CI installs
none of this software. A job that needs what your machine lacks fails in the
first run, and the report lists it with the first line of its error. Install
the software and set its variable, then run again.

## Actions

| A step that uses                                                    | Becomes                                                                                                                                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions/checkout`                                                  | Nothing to run: the replay made the checkout. One that asks for another repository, directory or commit, or for submodules, leaves the job out.                 |
| A setup action, such as `actions/setup-node` or `oven-sh/setup-bun` | Nothing to run. Smithers CI installs no tool: it looks for the tool on your machine before it runs the job. See [setup actions](how-it-works.md#setup-actions). |
| `actions/cache`, `actions/cache/restore`, `actions/cache/save`      | A command that restores and one that saves, in a store on your machine. See [Caches](#caches).                                                                  |
| `actions/upload-artifact`                                           | Nothing to run.                                                                                                                                                 |
| A local action, `./path`, that is composite                         | Its own steps, with its `inputs` and `outputs`.                                                                                                                 |
| A local workflow, `./.github/workflows/x.yml`, called by a job      | Its jobs, with its `inputs`. The calling job waits for all of them. A matrix of calls is not read, and its job is left out.                                     |
| Any other action, `actions/download-artifact` included              | Nothing: the job is left out.                                                                                                                                   |

A setup action also sets variables for the steps after it, such as `GOROOT`.
Smithers CI sets none of them, so a job with a step that reads one is left out.
`JAVA_HOME` is the exception: a runner has one anyway, so a step gets your
machine's, as [above](#software-a-runner-comes-with).

## Caches

A cache step restores files an earlier run saved under a key, and saves them
again when its job has passed. Smithers CI keeps those files in a store of its
own on your machine, outside your checkout and outside the step's home. What
one commit's run saved is there for the next commit, as on GitHub, so a build
tool finds its own cache and the baseline takes the time your CI takes. Each
way of running a commit, the baseline and each mode, has a store of its own.

`actions/cache` restores where the step stands and saves after the job's other
steps. `actions/cache/restore` only restores, and `actions/cache/save` only
saves.

| What                                | How                                                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An entry is found                   | Under `key` itself, or else the newest entry whose key starts with one of `restore-keys`, in the order written. Only entries saved for the same `path` are read. |
| `cache-hit`                         | `true` for `key` itself, `false` for one of `restore-keys`, empty when nothing was found. `cache-primary-key` and `cache-matched-key` are set too.               |
| An entry is saved                   | Once. A job that restored its own `key` saves nothing, and neither does a job with a failed step.                                                                |
| `path`                              | Files and directories of the checkout, of the home (`~/...`) and of `RUNNER_TEMP`.                                                                               |
| `fail-on-cache-miss`, `lookup-only` | As on GitHub.                                                                                                                                                    |
| An entry that cannot be unpacked    | A warning and a miss, as on GitHub. The job goes on.                                                                                                             |

In a cache step's `key`, `hashFiles` also takes patterns, such as
`hashFiles('**/package-lock.json', '!vendor/**')`: the files they name are
hashed in sorted order. The key is another than GitHub's, where the runner
decides the order, and it is the same from one run on your machine to the
next, which is all a key has to be.

A cache step restores and saves nothing, as after a miss, when its `path` is a
pattern (`dist/**`, `!dist/tmp`) or leads outside those three places. So does
one whose `key` or `path` cannot be worked out on your machine, such as one
that reads a secret. Its job is replayed all the same.

A setup action that keeps its package manager's cache is read the same way,
with the same store. `actions/setup-node` with `cache: npm`, `pnpm` or `yarn`,
`actions/setup-go` from version 4 on, and `actions/setup-python` with
`cache: pip` restore the cache when the step starts and save it after the job.
The directory is asked of the tool, as the action asks it (`npm config get
cache`, `go env GOMODCACHE`, `pip cache dir`), and the key holds the hash of
the lockfile, or of the files `cache-dependency-path` names: `go.sum` for
`setup-go`, or `go.mod` from version 6.3 on, and for `setup-python` also
`pyproject.toml`. With no lockfile the step does what the action does:
`setup-node` and `setup-python` stop, and `setup-go` goes on without a cache.
Their `cache-hit` is `true` or `false`. A tool that cannot say where its cache
is gives no cache, and the job goes on. Any other output of a setup action is
unknown, so what reads one leaves the job out.

Where the store is: in a replay, in the replay's own working directory, which
is removed when the replay ends. When you run the generated targets yourself,
in the directory Smithers build keeps its cache in, so the generated workflow
carries it from one run to the next with that cache.

## What leaves a job out

`smithers-ci inventory` shows each of these under its job, and the report lists
every job left out with the matching
[sentence](../reference/cli.md#why-a-job-is-not-replayed).

| Reason            | The job                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- |
| `condition`       | has an `if:` that is false for the event, or that reads what only GitHub knows      |
| `expression`      | has a step whose `${{ }}` reads what only GitHub knows, or what another job gave    |
| `secret`          | has a step that receives a secret                                                   |
| `uses`            | uses an action that is none of those above                                          |
| `checkout`        | checks out something other than the commit under replay                             |
| `runner-variable` | has a script that names a runner variable no runner gives, or one only GitHub knows |
| `services`        | starts service containers                                                           |
| `needs`           | needs a job that is left out                                                        |

A job left out is not run in the baseline either, so the times compare the same
work on both sides.
