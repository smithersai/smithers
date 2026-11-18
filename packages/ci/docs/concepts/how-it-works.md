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
- A **toolchain** is a tool the repository uses, such as Zig or Bun, with the
  file that names it, its version when the file gives one, and the job that
  installs it. The version may be a matrix value.

The recipes of one Justfile, and the scripts of one `package.json`, share a
working tree, so they count as CI in the order they run: the order the `ci`
recipe names them.

### Setup actions

A step that uses an action to put a tool on the CI machine means the job needs
that tool, at that version when the step gives one. Smithers CI downloads no
tool. A replay looks for the tool on your machine:

| The tool is              | The job                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| on your machine          | runs                                                               |
| there at another version | runs, and the report gives the version asked for and the one found |
| not there                | is not replayed, and the report names the tool to install          |

Versions are compared by number: `22` and `22.x` are any 22, `^1.22` is any 1
from 1.22 on. A name such as `latest`, and a version read from a file such as
`.nvmrc`, are not compared.

An action is read as a setup action by its name: the last part of its path,
with a closing `-action` left off.

| Name               | Example                                   | Tool     |
| ------------------ | ----------------------------------------- | -------- |
| `setup-<tool>`     | `actions/setup-node`, `ruby/setup-ruby`   | `<tool>` |
| `<tool>-setup`     | `bufbuild/buf-setup-action`               | `<tool>` |
| `install-<tool>`   | `snok/install-poetry`                     | `<tool>` |
| `<tool>-installer` | `DeterminateSystems/nix-installer-action` | `<tool>` |
| `<tool>-toolchain` | `dtolnay/rust-toolchain`                  | `<tool>` |

When `<tool>` names nothing, as `action` and `cli` do, the tool is the owner of
the action: `pnpm/action-setup` means pnpm. Four actions set a tool up under
another name: `actions-rs/toolchain` (Rust), `jdx/mise-action` (mise),
`subosito/flutter-action` (Flutter) and `taiki-e/install-action` (the tools its
`tool` input lists).

The version is the step's `<tool>-version`, `<tool>_version`, `version` or
`toolchain` input; `dtolnay/rust-toolchain@1.85.0` names it in its release. A
version written with a matrix value is filled in for each variant.

An action with such a name is still not a setup action when what it names is
no tool: a server, a cluster or an environment it starts, as `setup-minikube`,
`setup-postgres` and `setup-miniconda` do, or the job's own preparation, as
`setup-env` does. A setup action that receives a secret, or that changes what
the steps after it see (`astral-sh/setup-uv` with `activate-environment`,
`actions-rust-lang/setup-rust-toolchain` and its `RUSTFLAGS`), does more than a
tool on your machine stands for. The job of any of these is not run.

Two setup actions also run a command when asked, and the job runs it too:
`ruby/setup-ruby` with `bundler-cache: true` installs the gems into the
checkout, and `pnpm/action-setup` with `run_install: true` runs `pnpm install`.

A tool counts as on your machine when its program is a file on `PATH`. Python
is `python3` or `python`, and Rust is `cargo`.

### What has no command

Some CI features have no command to run, such as a hosted service container or
a third-party action. The inventory lists each one under its job as
unsupported, with the reason. When the repository depends on something
Smithers CI cannot run, the command stops with exit code 3.

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

Jobs often start with the same step, such as `npm ci`. When two GitHub Actions
jobs run the same command, in the same directory, with the same environment,
after the same steps, one target runs it for both: the install runs once, and
each job's next step waits for it. The report still lists the step under each
job.

Targets that cannot write the same files run at the same time. A target
confined to the files it reads cannot write the checkout, so any number of
them run together. Two targets that can write the checkout run one after the
other.

What a target reads comes from its dependency closure: every file its entry
files reach. Each language has its own strategy for finding them, and every
strategy returns the same shape. A strategy never guesses. When it meets an
import it cannot follow, the closure counts as affected by every change, so
the target always runs.

A plain shell step, `npm test` or `make check`, has no entry files, and nobody
can say what it reads. Smithers CI records it. The step runs under a trace that
names every file it opened, every directory it listed, and every path it looked
for and did not find. Its result is stored with that list. On the next change
the step is a cache hit when everything on the list is unchanged. It runs again
when a file it read changed, when a file appeared in a directory it listed, or
when a path it looked for now exists. A change to a file it never read, the
docs for one, does not run it.

A step that reached the network, or a program outside its own run, stores
nothing and runs every time: what those answered is on no list. Recording
needs Linux with `strace`, which the generated workflow installs on its
runners. On any other system such a step runs on every change, as it does in
the repository's CI today.

Each step runs under the tool versions its job sets up, so a matrix over Node
18 and 20 tests both. Steps that need different versions run on separate
machines of the generated workflow, and a result made under one version is
never reused for another. A step does not wait for a job that runs under other
versions: both run, and the workflow fails when either fails.

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
The recipes of one Justfile, the rules of one Makefile, and the scripts of one
`package.json` run one after another in one checkout, in the order the `ci`
recipe or rule lists them, and stop at the first failure.

Four things are left out and listed in the report:

| Feature        | What is not replayed                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `other-system` | a matrix variant, or a whole job, that runs on another operating system |
| `missing-tool` | a job that sets up a tool your machine does not have                    |
| `no-target`    | a job with a step that has no target                                    |
| `needs`        | a job that needs a job left out                                         |

A matrix over `ubuntu-latest`, `macos-latest` and `windows-latest` is replayed
on Linux for its Ubuntu variants. The other variants are listed; the job is
not dropped. A missing tool is listed with what to install, as in
`missing-tool (ruby 3.4.6)`.

When every CI job runs on another operating system, nothing can be measured
here. The command says so in one line that names the system, and exits with
code 3:

> every CI job of this repository runs on macOS; run smithers-ci on a Mac

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

Wall time holds what a CI machine spends on a commit once it is ready:
checking the commit out and running the commands. In normal and fast mode
that includes starting Smithers build and deciding what to run, once per
commit. It leaves out what only a replay does to its copy, such as writing
the target files there, which `apply` commits once. For every way it leaves
out what happens before a CI machine is ready: starting the machine, fetching
the repository over the network, installing tools and moving the cache.

Over all commits it gives the total wall time of each way, the speedup, the
number of mismatches and the number of flaky verdicts. The speedup is the
baseline wall time divided by the normal-mode wall time, both summed over
every commit. It lists each CI job that was not replayed with its reasons,
and each file the inventory could not read, so the speedup is never read as
covering them. Under `tool versions` it lists each tool your machine has at
another version than a job asks for:

```text
tool versions
tests.yml:test  asks for node 22.x; this machine has node 26.5.0
```

With fast mode, it also gives fast mode's selection metrics; see
[Normal mode and fast mode](modes.md#how-fast-mode-is-measured).

The report prints as text: the totals, then one line for each commit that
says whether each way passed, with its wall time. `--out` also writes it as an
HTML file with a row for each commit. `--json` prints it as JSON, which also
holds work time and the target counts.

## See also

- [Quickstart](../getting-started/quickstart.md)
- [The cache](cache.md)
- [Command reference](../reference/cli.md)
