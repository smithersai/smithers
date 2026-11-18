---
title: "How it works"
description: "The four stages of smithers-ci: the inventory of today's CI, the Smithers build targets, the replay of past commits, and the report."
---

`smithers-ci` runs four stages in order. Each stage writes one document the next
one reads.

```text
your CI files ──> inventory ──> targets ──> replay ──> report
(workflows,        what CI     Smithers     past       times,
 Justfile, ...)    does today  build        commits    speedup,
                               targets      3 ways     mismatches
```

## 1. Inventory

The inventory is what the repository's CI does today, written as shell
commands. `smithers-ci inventory` prints it.

It reads five sources:

| Source           | Read from                |
| ---------------- | ------------------------ |
| `github-actions` | `.github/workflows/*`    |
| `justfile`       | a `Justfile`             |
| `makefile`       | a `Makefile`             |
| `package-json`   | `package.json` scripts   |
| `turbo`          | Turborepo's `turbo.json` |

Each source becomes the same shape, so a Zig repository driven by a Justfile
and a TypeScript monorepo driven by GitHub Actions and Turborepo look alike:

- A **job** is a list of steps that run in order on one machine. It records the
  file it came from, the jobs it needs first, what triggers it, and its matrix:
  one set of variables per variant, or none when the job runs once.
- A **step** is one shell command with its working directory and plain
  environment values. A secret the step uses appears by name only, never by
  value. A value under `env:` that is a URL with a path of 20 or more
  characters is withheld the same way: a webhook's path is its credential.
- A **toolchain** is a tool the repository pins, such as Zig or Bun, with the
  file that pins it and its version when the file gives one.

Some CI features have no command to run, such as a hosted service container or
a third-party action. The inventory lists each one under its job as
unsupported, with the reason. When the repository depends on something
Smithers CI cannot run yet, the command stops with exit code 3.

A job with one of these is never run and never becomes a target:

| Feature            | The job                                                   |
| ------------------ | --------------------------------------------------------- |
| `secret`           | has a step that receives a secret                         |
| `release-trigger`  | is in a workflow that only a pushed tag starts            |
| `write-permission` | may write outside its checkout (`permissions: ... write`) |
| any other feature  | except `host-action` and `trigger-filter`, which are safe |

A workflow limited to some branches or paths (`trigger-filter`) is run for
every change: more often than its CI runs it, never less.

## 2. Targets

Smithers CI turns the inventory into a Smithers build workspace: target files
and a CI workflow. It builds these as text and writes nothing; only
`smithers-ci apply` writes them.

A target has a content key. The key changes when anything the target reads
changes, so an unchanged target is a cache hit instead of a rerun. For one
change, the plan is the set of targets the change selects, each with its key
and its dependencies.

What a target reads comes from its dependency closure: every file its entry
files reach. Each language has its own strategy for finding them, and every
strategy returns the same shape. A strategy never guesses. When it meets an
import it cannot follow, the closure counts as affected by every change, so
the target always runs.

## 3. Replay

The replay runs past commits, 20 unless `--commits` says otherwise, and
measures each one up to three ways. Each commit runs its own CI: the inventory
and the targets are made again from that commit's own files, so a commit that
renamed a script is replayed with the name it had. A commit that had no CI, or
none that can be run on this machine, is not replayed and the report lists it.

| Way      | What runs                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------- |
| Baseline | The repository's CI as it is today.                                                                      |
| Normal   | Only the targets the change affects, with the cache.                                                     |
| Fast     | Normal mode, minus the targets the scorer judged safe to skip. Only with `--mode fast` or `--mode both`. |

Every run happens in a copy. The replay never changes the repository it reads.
`--jobs` caps how many targets run at once; the default is the machine's.

A copy fetches from the repository's remote and has no remote to push to. A
baseline step gets what a target gets: a short list of the machine's
variables such as `PATH` and `HOME`, the step's own `env`, end of file on
standard input, and a limit of six hours. It gets no other variable of the
person running the replay.

In the baseline, a GitHub Actions job runs in a fresh checkout of its own.
The recipes of one Justfile, and the scripts of one `package.json`, run one
after another in one checkout, in the order the `ci` recipe lists them, and
stop at the first failure.

Three things are left out and listed in the report:

| Feature        | What is not replayed                                      |
| -------------- | --------------------------------------------------------- |
| `other-system` | a matrix variant whose runner is another operating system |
| `no-target`    | a job with a step that has no target                      |
| `needs`        | a job that needs a job left out                           |

A failed target reruns up to the limit the program sets (two) or until it
passes. Its attempts give its verdict:

| Verdict   | When                                  |
| --------- | ------------------------------------- |
| `pass`    | The first attempt passed.             |
| `fail`    | Every attempt failed.                 |
| `flaky`   | Some attempts passed and some failed. |
| `skipped` | The target did not run.               |

A **mismatch** is a target whose verdict in normal or fast mode differs from
its baseline verdict. `pass` and `flaky` agree: the step passed in the end.
Flaky verdicts are counted apart. Fast mode skipping a target that failed in
the baseline is a mismatch. Skipping one that passed is not.

## 4. Report

The report compares the three ways. For each commit it gives the number of
changed files, and for each way whether the run passed, its wall time, its
work time and its target counts:

| Count     | Meaning              |
| --------- | -------------------- |
| `hit`     | Came from the cache. |
| `ran`     | Ran and passed.      |
| `failed`  | Ran and failed.      |
| `skipped` | Never ran.           |

Wall time is elapsed time. Work time is the sum of every target's own time.

Over all commits it gives the total wall time of each way, the speedup, the
number of mismatches and the number of flaky verdicts. The speedup is the
baseline wall time divided by the normal-mode wall time, both summed over
every commit. It lists each CI job that was not replayed with its reasons,
and each file the inventory could not read, so the speedup is never read as
covering them. With fast mode, it also
gives fast mode's selection metrics; see
[Normal mode and fast mode](modes.md#how-fast-mode-is-measured).

The report prints as text: the totals, then one line for each commit that
says whether each way passed, with its wall time. `--out` also writes it as an
HTML file, and `--json` prints it as JSON; both also hold work time and the
target counts.

## See also

- [Quickstart](../getting-started/quickstart.md)
- [The shared cache](shared-cache.md)
- [Command reference](../reference/cli.md)
