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

| Feature            | The job                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `secret`           | has a step that receives a secret                                              |
| `release-trigger`  | is in a workflow that only a pushed tag starts                                 |
| `write-permission` | may write outside its checkout (`permissions: ... write`)                      |
| `changes-machine`  | changes the machine it runs on; see [Your machine](#your-machine)              |
| `docker`           | has a step that runs `docker`, `podman` or `nerdctl`; `--allow-docker` runs it |
| `services`         | needs service containers, which only GitHub starts                             |
| `container`        | runs inside a container, which only GitHub starts                              |
| any other feature  | except `host-action`, `trigger-filter` and `condition-false`, which are safe   |

A GitHub Actions step runs as it does on a runner: its `${{ }}` and `if:` are
evaluated, it is given the runner's variables, and what it writes to
`GITHUB_ENV`, `GITHUB_PATH` and `GITHUB_OUTPUT` reaches the steps after it. A
step whose `if:` is false for the event a replay stands for
(`condition-false`) is left out, as its CI leaves it out. See
[GitHub Actions workflows](github-actions.md).

A workflow limited to some branches or paths (`trigger-filter`) is run for
every change: more often than its CI runs it, never less.

One kind of secret does not stop a job: the credentials of a remote build
cache, in `TURBO_TOKEN`, `TURBO_TEAM`, `NX_CLOUD_ACCESS_TOKEN`,
`GRADLE_ENTERPRISE_ACCESS_KEY`, `DEVELOCITY_ACCESS_KEY` or
`CACHIX_AUTH_TOKEN`. GitHub gives a pull request from a fork no secret, so
there the variable is empty and the job runs without that cache. Smithers CI
reads the job as that run: the variable is empty and no secret is passed. The
report says so, because your CI with its remote cache is faster than the
baseline measured without it:

```text
TURBO_TEAM, TURBO_TOKEN left empty: the baseline ran without the remote cache they open
```

## 2. Targets

Smithers CI turns the inventory into a Smithers build workspace: target files
and a CI workflow. It builds these as text and writes nothing; only
`smithers-ci apply` writes them. Everything but the workflow goes under
`.smithers/`, in files your own type checker, linter and formatter do not read
as theirs: see [Make it your CI](../getting-started/quickstart.md#make-it-your-ci).

A target has a content key. The key changes when anything the target reads
changes, so an unchanged target is a cache hit instead of a rerun. For one
change, the plan is the set of targets the change selects, each with its key
and its dependencies.

### A job is a machine

On GitHub every job starts on a machine of its own: a fresh checkout, an empty
home directory, an empty temporary directory, and nothing another job did. A
job can rely on that. One job edits a file that another job checks, or two
jobs each run `mkdir ~/.config/tool` with no `-p`. Both pass in your CI, and
both would fail in one shared tree with one home.

So the targets of a job run on a machine of that job's own. Smithers build
makes it when the first of them has to run and removes it when the run ends:

| A job gets            | What it holds when the job's first step starts                                 |
| --------------------- | ------------------------------------------------------------------------------ |
| A checkout            | The commit's files and a `.git` of its own. No `node_modules`, no build output |
| A home directory      | Nothing of yours and nothing another job wrote                                 |
| A temporary directory | Nothing. It is the job's `/tmp`, and `TMPDIR` names it                         |
| Your tools            | The ones on `PATH`, as they are installed on the machine                       |

The steps of one job share its checkout, its home and its temporary directory,
in order, as they share a runner. No other job sees what they write. A matrix
makes one job for each variant, so each variant has a machine of its own.

A job's machine is at the same paths at every commit, in the baseline and in
each mode, as every job on GitHub runs in `/home/runner`: its home, its
checkout and its temporary directory. A tool that writes a path into what
`actions/cache` keeps, as pre-commit writes where it cloned each hook, finds
that path again when a later commit's job restores the cache.

It is the same in a replay, in the workflow `apply` writes, and when you run
`smthrs ci '//...'` yourself: the checkout you run it in is left as it was.

A job whose steps all reuse their results gets no machine: nothing of it runs,
so nothing is copied. A job with one step to run gets a checkout, what its
reused steps left is put back there, and the step runs.

Each job runs its own steps, and each step is told its own job. Two jobs that
both start with `npm ci` each install, as they do in your CI, and each keeps
its install for its own later steps. A tool that keeps a cache under its user's home, as Zig, Go, npm and
Cargo do, fills it again in every job that runs, as it does on a new CI
machine. What your CI keeps from one run to the next it keeps through
`actions/cache`, and so does a replay: see [Caches](github-actions.md#caches).

A job's `/tmp` is its own on Linux, where the machine has bubblewrap and lets
a program make a mount of its own: a job that writes `/tmp/build` never meets
another job's. The workflow `apply` writes never lets two jobs share a
`/tmp`. On a Linux runner it installs bubblewrap, and each job has its own. A
macOS runner has no such mount, so each job is a runner job of its own there,
as in your CI. A runner that still gives no private `/tmp` runs one job and
fails the others, with the reason, where a job would otherwise find what
another left. In a replay on macOS, and on a Linux machine with no
bubblewrap, jobs share the computer's `/tmp`: the baseline and each mode
alike, so the two still agree. `TMPDIR` is still each job's own.

Jobs run one after another: they share the computer's ports, so two jobs that
each start a server on the same port both pass. A job that is only one step
confined to the files it reads cannot write the checkout and needs no machine,
and any number of such steps run together. Two such jobs that run the same
step run it once.

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

A step that asks git about the commit, as `git describe` and `pre-commit` do,
read `.git`, which every commit changes, so it runs at every commit. `cargo
build`, `cargo test` and `cargo doc` open `.git` only to list a package's
files, so what cargo itself reads there is not counted; a build script or a
test that reads `.git` is counted as any step is.

The steps of a job follow each other in one checkout: an install leaves a
tree, a build leaves its files, and the step after reads them. Each step is
recorded the same way, and what each step left is kept with its record. A
commit that changes nothing a job's steps read runs no step of it: no install,
no build, no test, in a fresh checkout too. When one step has to run, what the
steps before it left is put back first, and they do not run. The files are put
back with new times, by one rule: every file put back is newer than what was in
the checkout before it, none is in the future, files of one step keep their
order, and a later step's files are never older than the earlier step's files
they were built from. So a later `make` finds what an earlier step built up to
date. One thing is lost: the gaps between a long step's files are not kept.

| Commit changes             | `npm ci` | `npm run lint` | `npm test` |
| -------------------------- | -------- | -------------- | ---------- |
| Only docs                  | hit      | hit            | hit        |
| A file only the tests read | hit      | hit            | runs       |
| The lint configuration     | hit      | runs           | hit        |
| `package-lock.json`        | runs     | runs           | runs       |

A step that reached the network, or a program outside its own run, stores
nothing and runs every time: what those answered is on no list. For a day
after such a run the step runs without the recording, which costs time and
would store nothing. An install
that fetches exactly what a lockfile pins is the exception, because the
lockfile it read fixes what it fetches: `npm ci`, `pnpm install
--frozen-lockfile`, `yarn install --immutable`, `bun install
--frozen-lockfile`, `uv sync --locked`, `uv run --locked`, `pip install --require-hashes`, `go mod
download` and `cargo fetch --locked` are stored like any other step. So is a
`cargo` or `go` build or test that downloads what `Cargo.lock` or `go.sum`
pins and leaves that file as it was. `npm install`, `pip install -r
requirements.txt`, and `cargo build` in a repository with no `Cargo.lock`
pick a version when they run, so they run every time. A step that restores or saves a cache, such as
`actions/cache`, also runs every time: what it keeps lives from one run to the
next, and the record of a run does not hold it. Recording
needs Linux with `strace`, which the generated workflow installs on its
runners. On any other system such a step runs on every change, as it does in
the repository's CI today, and a replay says once on standard error that this
machine cannot record what a step reads, and why.

Each step runs under the tool versions its job sets up, so a matrix over Node
18 and 20 tests both. Steps that need different versions run on separate
machines of the generated workflow, and a result made under one version is
never reused for another. A step does not wait for a job that runs under other
versions: both run, and the workflow fails when either fails.

### A runner's variables

A GitHub runner gives every step the commit and the run's id, number and
attempt, and each is another at every commit. Smithers CI gives them to every
step too, so a test that reads `GITHUB_SHA` finds it. A step's result is reused
at another commit only when its run did not use one of them. No trace shows a
program reading a variable, so a run counts as having used one when any of
these holds:

| What shows it                                                                | Example                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------ |
| The variable's name in the step's script                                     | `echo "$GITHUB_SHA"`                       |
| Its name in a file of your repository the step read that git does not ignore | A test that reads `process.env.GITHUB_SHA` |
| Its value in what the step printed                                           | `env`, a tool that logs the commit         |
| Its value in a file the step wrote and left                                  | A version file, a report naming the commit |
| Its value in the arguments of a program the step started                     | `git show` with the commit                 |

Such a step runs again at every commit. Every other step is reused while the
files it read are unchanged.

Your workflow files under `.github/workflows/` are read as data: GitHub runs
them, the step does not. A step that reads a workflow naming `GITHUB_RUN_ID`, as
a check of your CI's own pins does, is still reused, and runs again when a
workflow file it read changes.

A tool that only holds a variable's name in its own code does not make its
step run again: Bun, Vitest and Playwright each hold `GITHUB_SHA`. When such a
tool writes the commit into a report, the commit is in the report, and the step
runs again. A commit is also looked for by its first seven characters. A value
shorter than six characters, such as the attempt `1`, is found by its name
alone.

One thing shows nothing: a program that puts a variable's name together from
pieces and uses the value only to decide something, without printing or
writing it. Name the variable in the step's script and the step runs at every
commit.

The event file is a file. A step that opens it has read it, and runs again when
it is another.

A step held to its own files, such as the tests of one package, is not traced:
it can read no other file of your repository. It runs again at every commit
when its script or one of those files names one of the variables, or
`GITHUB_EVENT_PATH`. Any other held step is reused at another commit, from a
shared cache too.

Where reads are not recorded, on macOS or without `strace`, nothing says
whether a step used a variable, so every step that is not held to its files
runs again at every commit.

A command of a Justfile, a Makefile or a package script is started by no
runner. It is given the commit and the run's numbers only when it names one,
as `$GITHUB_SHA`, and then it runs again at every commit.

## 3. Replay

The replay runs past commits, 20 unless `--commits` says otherwise, and
measures each one up to three ways. Each commit runs its own CI: the inventory
and the targets are made again from that commit's own files, so a commit that
renamed a script is replayed with the name it had. A commit that had no CI, or
none that can be run on this machine, is not replayed and the report lists it.

| Way      | What runs                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| Baseline | The repository's CI as it is today.                                                                                  |
| Normal   | Only the targets the change affects, with the cache.                                                                 |
| Fast     | Normal mode, minus the targets the model predicts the change cannot break. Only with `--mode fast` or `--mode both`. |

Every run happens in a copy. The replay never changes the repository it reads.
A copy holds the commit's files and nothing else: the cache, the files Smithers
CI generates and its records are kept beside the copy, never in it. A step
that lists its checkout, with `git status --ignored`, `git clean -n`, `find`
or `ls`, sees what a fresh clone holds, in the baseline and in each mode.
The steps run once more on the newest commit with the files `apply` writes
in it, the commit you push after `apply`: a step that fails only there is a mismatch, and
the report says why, naming the tool and the file when a tool of yours read
one of them as its own. The run's time is on a line of its own and in no
total; `--no-apply-check` leaves the run out.
`--jobs` caps how many jobs run at once, the same in the baseline and in each
mode, so the times compare like with like. The default is this machine's core
count divided by 4, at least 1: a GitHub runner gives each job 4 cores, so each
job here gets what it gets there, and a test with a time limit is not slowed by
the jobs beside it.

### The first run

A CI run starts with what the run before it kept on purpose: what its jobs
saved with `actions/cache` or a setup action's own cache, and the results a
later commit reuses. A replay that counted its first commit from nothing would
measure the one run that fills them. So before the first counted commit, each
way runs once at the commit before the oldest replayed one, in a home of its
own. A job's home is empty at every run, as on a new CI machine, so a cache a
tool keeps there is not carried over: see
[A job is a machine](#a-job-is-a-machine).

- The baseline's first run fills what its jobs save for a later run.
- Normal mode's and fast mode's first runs fill the same, and the cache of
  results a later commit reuses.
- A step that fails in a mode's first run stops nothing: the cache holds what
  passed.

No first run is in a commit's time or in the speedup. The report gives the time
of each on one line:

```text
the first run, with an empty cache, took 4m 10s as the baseline and 5m 02s in normal mode; it happens once and is in none of these times
```

`--cold` skips the first run and counts from an empty cache. When the oldest
replayed commit is the repository's first, or the commit before it has no CI
that runs on this machine, there is nothing to run first: the replay starts
with an empty cache and the report says so.

### Jobs that cannot pass here

A repository often has a job that cannot pass on the machine you measure on: it
needs Docker, a service, a credential or another system. One such job must not
cost you the whole measurement. The baseline's first run finds them.

- A job that passes is replayed.
- A job that fails is run once more, at the newest commit, in a home no counted
  run reads. If it passes there, it was flaky or broken at that one commit, and
  it is replayed. If it fails again, it runs at no commit, in no way. The report
  lists it as failing on this machine, with the step that failed, its exit code,
  the line of its output that says what failed and the commits it failed at, and every job that
  needs it as left out with it. In a matrix job, this holds for each variant.
- In a Justfile, Makefile or `package.json`, where jobs share one working tree,
  the jobs after a failed one run again without it, as they will in the replay.
- When no job passes, there is nothing to measure: the command prints the first
  failure and exits `3`.
- When half or more of the jobs that could run here are left out, a speedup over
  the rest would not be your CI's. The command prints no report: it lists each
  job it left out with why, and exits `3`.

A job that is left out is compared in no way: a fault of Smithers CI in that job
would not show. So the headline always says how much of your CI the number
covers, such as `over 3 of 5 jobs`, each job left out is listed with what
failed, and `--no-trial` compares every job as it is.

A job is tried at the first commit the replay runs, with what a CI has there.
So a job that needs what an earlier commit's run saved with `actions/cache`
passes when the replay ran that commit.

With `--cold`, or when there is nothing to run first, the baseline runs once more
to find these jobs: at the oldest replayed commit, in a home and a store of its
own, which warm nothing a counted run reads. The report gives the time this run
took, and that time is in no other number.

A job that passes the first run and fails at a later commit is an ordinary failed
baseline at that commit. `apply` still writes every job, because a job that cannot
pass on your machine passes on your runners. `--no-trial` leaves no job out: every
job runs at every commit, in the baseline and in each mode, and is compared.

### Steps that stop making progress

A step can wait forever for something that will never come, such as a pipe
nobody writes. When a step's whole process tree uses less than one hundredth of a
CPU core and prints nothing for 10 minutes, the replay stops it, and it fails with
`it made no progress for 10 minutes`. This holds in the baseline, as a target and
for every install. A target is stopped through the processes it waits in, so the
targets beside it keep their results. A stopped step is not run again.

CPU time comes from `/proc` on Linux and from `ps` on macOS, never from the clock
alone: when they cannot be read, no step is stopped this way. A step that waits
longer on purpose needs `--stall-minutes` set above its wait.

### What a step can reach

A step is a command from a past commit, and someone else may have written it.
Every step runs under the same rules, in the baseline and as a target. So does
every install the replay runs, and every `git` the program itself runs in a
copy a step has written: a step can leave a command in that copy's
`.git/config`, and git would run it.

**Its own home.** `HOME` and the cache directory are directories the replay
makes and removes. Nothing of your home is in them: no `.npmrc`, no
`.gitconfig`, no token. Your tools stay reachable through `PATH`.

Every job of every commit starts with a checkout, a home and a temporary
directory nothing wrote to, in the baseline and in each mode: see
[A job is a machine](#a-job-is-a-machine). The baseline makes them for every
job. A mode makes them for the jobs it runs. A tool that keeps a cache in its
user's home, as Zig, Go, npm and Cargo do, so fills it again in every job
that runs, at every commit, as it does in your CI. The speedup never compares
a baseline that filled a cache with a mode that found it full: neither finds
one.

**Its own variables.** A step of a GitHub Actions workflow gets every variable a
runner sets: see [what a step is given](github-actions.md#what-a-step-is-given).
A step gets a short list of the machine's variables,
such as `PATH`, then the step's own `env`, end of file on standard input, and
a limit of six hours. It gets no other variable of yours: no token, no
`SSH_AUTH_SOCK` and no `DOCKER_HOST`.

Nor can it read one from the program. A step runs beside `smithers-ci` as you,
and a process can read what another process of yours was started with. So
`smithers-ci` starts again with only that short list before it does anything
else, and what it starts gets the short list too. The two tokens the program
uses itself, the cache's and the model's, stay in its memory. The cache's
token goes to the part that talks to the cache through a pipe, never through a
variable or a command line, and it is in no file the replay writes. When fast
mode asks a model that is a program of its own, as Claude Code is on a machine
signed in to it, that program also gets the
[variables that choose and reach the model](../reference/cli.md#environment),
and no other variable of yours.

A step also starts with no open file of the program's: only its standard
input, output and error.

**No push.** Every `git` a step starts refuses to push. A `pre-push` hook,
set through git's environment and in the step's home, stops the push before
anything is sent, so `git remote add`, `git remote set-url` and a hooks
directory of the repository's own do not undo it. That `git` has no credential
helper and never asks for a password. A copy fetches from the repository's
remote and has no remote to push to.

**No container daemon.** Whoever talks to a Docker or Podman daemon can have
it mount any file of your machine, so a step does not reach one:

- A job with a step that runs `docker`, `docker compose`, `docker-compose`,
  `podman` or `nerdctl` is not replayed. The report lists it with what it runs
  and the flag that replays it:

  ```text
  test.yml:lic-headers  runs docker, and a container daemon can reach every file of this machine; pass --allow-docker to replay it
  ```

- A step that starts one of those programs by name, for example from a script
  the job calls, starts a stand-in first on its `PATH`. It prints one line and
  exits 1:

  > smithers-ci does not run docker without --allow-docker: compose up -d

  The step fails the same way in the baseline and as a target, so it is never
  a mismatch.
- In the jail, the daemons' sockets are empty: `/var/run/docker.sock`,
  `/run/docker.sock`, `docker.sock` and `podman/podman.sock` in your session's
  runtime directory, and the socket your `DOCKER_HOST` names.

`--allow-docker` turns all three off: the jobs that run those programs are
replayed, their steps start your `docker`, get your `DOCKER_HOST` and reach
the sockets. A step that reaches a daemon can do what the daemon can: read
your home directory, your keys and every repository on the disk, and write
them, whatever the jail holds. Use it only for a history you trust.

A job with `services` or `container` is never replayed, with or without the
flag. GitHub starts those containers itself and there is no command that
stands for them, so the job stays in your CI as it is.

**A jail.** On Linux with
[bubblewrap](https://github.com/containers/bubblewrap) installed, a step can
write three places: its copy of the repository, its home and a temporary
directory of its own, which it finds at `/tmp` and at `TMPDIR`. Every other
file of the machine is read-only, so a push to a repository on the same disk
fails.

Your home directory is empty for it. What a step finds there is what it has a
use for, each read-only: the tools on your `PATH` that are installed under it,
such as Node under nvm or Rust under rustup; the files `smithers-ci` itself
runs from; and your repository. Nothing else is there: no directory of
settings, no shell history, no file a program keeps a token in, whatever its
name. A tool that looks for its versions under `HOME`, as rustup, asdf and
mise do, finds them under the step's own. A program on your `PATH` that starts
a tool kept in another directory of your home does not find it there: the step
fails, and its failure names the directory to put on `PATH`.

Also empty are the homes of the machine's other users and of root, the mail
and the scheduled commands of its users, the secrets a container platform
mounts under `/run/secrets`, the stores of the container daemons, the
machine's own temporary files, and your session's runtime directory under
`/run/user`, where key agents listen. A credential of your home that is a link
to another place is empty there too.

A step sees no
process but its own, and the kernel gives it none of the keys it holds for
your session, such as a Kerberos ticket. The step's processes end when the
step does. The network stays open, as it is in your CI.

A socket with a name and no file, an abstract socket, is in no directory, so
no jail of files hides it. An older D-Bus session bus listens on one and takes
whoever connects for you. On Linux 6.12 and later, with perl installed, the
kernel refuses a step every such socket it did not make itself.

What a step can do depends on the machine:

| A step                                                   | Linux with bubblewrap | Linux without it | macOS |
| -------------------------------------------------------- | --------------------- | ---------------- | ----- |
| sees your home directory as its `HOME`                   | no                    | no               | no    |
| gets a token, an SSH agent or `DOCKER_HOST` from you     | no                    | no               | no    |
| reads a variable of yours from `smithers-ci`             | no                    | no               | no    |
| pushes with `git push`                                   | no                    | no               | no    |
| starts `docker` or `podman` by name                      | no                    | no               | no    |
| starts `sudo`, `su` or `doas` by name                    | no                    | no               | no    |
| writes its copy, its home and its temporary directory    | yes                   | yes              | yes   |
| reaches the network                                      | yes                   | yes              | yes   |
| reads the other files of the machine                     | yes                   | yes              | yes   |
| writes any other file, such as a repository beside it    | no                    | yes              | yes   |
| reads a file of your home that is not a tool             | no                    | yes              | yes   |
| talks to a container daemon's socket by its path         | no                    | yes              | yes   |
| leaves a process running after it ends                   | no                    | yes              | yes   |
| sees your other programs and what they were started with | no                    | yes              | yes   |
| reads the keys the Linux kernel holds for your session   | no                    | yes              | no    |
| connects to an abstract socket of one of your programs   | no, from Linux 6.12   | yes              | no    |

On macOS, and on Linux without bubblewrap, there is no jail. `smithers-ci`
says so once on standard error and names what to install. The first six lines of the table
still hold there. They stop a step that does what CI steps ordinarily do; they
do not stop one written to get around them. Replay there only a history you
trust.

The hook and the stand-ins are not what stops a determined step. `git push
--no-verify` skips the hook, a step can start `/usr/bin/docker` by its path,
and a tool can publish over HTTPS with a token it carries itself. What stops
those is the home and the jail: the step finds no credential of yours to push
or publish with, no daemon socket to talk to, and cannot write a repository on
your disk. A token committed to the repository is the repository's own, and a
step can use it. A daemon that listens on a network port is reached over the
network, which stays open. So is the metadata service of a cloud machine, at
`169.254.169.254`, which gives the machine's own credentials to any program on
it. And so, on a kernel older than Linux 6.12 or a machine without perl, is a
program of yours that listens on a socket with no file, as an X11 display
does: such a socket belongs to the network, not to a directory.

A refused push fails its step in the baseline and as a target alike, so it is
never a mismatch. The report lists the step as failed, with the line git
printed:

> smithers-ci: a replayed step may not push; nothing was sent

A target runs the tools your CI runs. Every program on your `PATH` is there by
name, wherever it is installed: Node under nvm, fnm, Volta, asdf or mise, Bun
under `~/.bun`, Zig unpacked in your home directory. A target reads those
tools and nothing else of your home directory, and it runs again when a tool
its step names changes. A step whose tool is not installed fails with one
line that names the tool.

In the baseline, a GitHub Actions job runs in a fresh checkout of its own.
The recipes of one Justfile, the rules of one Makefile, and the scripts of one
`package.json` run one after another in one checkout, in the order the `ci`
recipe or rule lists them, and stop at the first failure.

Five things are left out and listed in the report:

| Feature           | What is not replayed                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `other-system`    | a matrix variant, or a whole job, that runs on another operating system |
| `missing-tool`    | a job that sets up a tool your machine does not have                    |
| `changes-machine` | a job with a step that would change your machine                        |
| `no-target`       | a job with a step that has no target                                    |
| `needs`           | a job that needs a job left out                                         |

A matrix over `ubuntu-latest`, `macos-latest` and `windows-latest` is replayed
on Linux for its Ubuntu variants. The other variants are listed; the job is
not dropped. A missing tool is listed with what to install, as in
`needs ruby 3.4.6, which this machine does not have`. The command reference
lists [every reason and its sentence](../reference/cli.md#why-a-job-is-not-replayed).

When every CI job runs on another operating system, nothing can be measured
here. The command says so in one line that names the system, and exits with
code 3:

> every CI job of this repository runs on macOS; run smithers-ci on a Mac

### Your machine

A replay installs nothing on your machine, starts no service and never runs
`sudo`. A job with a step that would is not replayed. The report lists it as
`changes-machine`, with what the job does:

```text
linux.yml:build  changes-machine (runs sudo install, sudo gpg and sudo tee; installs zsh and fish with apt-get)
```

| A step that runs                                  | Commands                                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| a command as another user                         | `sudo`, `su`, `doas`                                                                                                                                 |
| a system package manager, to change what is on it | `apt`, `apt-get`, `aptitude`, `dpkg`, `rpm`, `dnf`, `yum`, `microdnf`, `apk`, `pacman`, `zypper`, `brew`, `port`, `choco`, `winget`, `scoop`, `snap` |
| a service manager, to change what runs            | `systemctl`, `service`, `launchctl`                                                                                                                  |
| an install that writes outside the step's home    | the commands below                                                                                                                                   |

| Command                                                          | What it writes                | Replayed                                                 |
| ---------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `npm install -g`, `npm link`                                     | npm's directory beside Node   | never                                                    |
| `corepack enable`                                                | `pnpm` and `yarn` beside Node | never                                                    |
| `gem install`                                                    | Ruby's own directory of gems  | with `--user-install`, `--install-dir` or `GEM_HOME` set |
| `pip install --break-system-packages`, `uv pip install --system` | the system's Python           | never                                                    |

`cargo install`, `go install`, `pnpm add -g`, `bun add -g`, `deno install -g`
and `yarn global add` write under the home directory, which is the step's own,
so they are replayed and leave nothing behind. A plain `pip install` is replayed
too. It writes where the `python` on your `PATH` keeps its packages, so start
the replay with a virtual environment active when that Python matters to you.

**Packages you already have.** A step that does nothing but install named
packages does not stop its job when every one of them is on your machine. The
replay asks the package manager (`dpkg -s`, `rpm -q`, `brew list`, `pacman -Q`,
`apk info -e`), skips the step in the baseline and in every mode, and replays
the job. With a package missing, the report says what to install:

```text
ci.yml:build  changes-machine (install fish with apt-get to replay this job)
```

**A script that asks first.** A script written for machines with and without
`sudo` asks before it uses it, and ends when the answer is no:

```sh
if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null; then
  echo "no sudo here; the lock timeout stays as it is"
  exit 0
fi
printf 'DPkg::Lock::Timeout "600";\n' | sudo tee /etc/apt/apt.conf.d/99-lock-timeout
```

In a replay the answer is always no, so the script ends at its `exit` and the
rest never runs. The step is replayed, and does what it does on a machine with
no `sudo`.

Smithers CI reads this one shape and nothing looser, so no script is taken for
safe that is not:

- The script starts with the `if`. Only comments and `set` with the flags
  `e`, `u`, `x` and `o pipefail` come before it.
- The test is `! sudo -n true`, alone or after `! command -v sudo ||`, with
  its output sent to `/dev/null` or not. `sudo -n -v` and
  `sudo --non-interactive true` ask the same.
- The branch prints with `echo` and ends with `exit`, each on a line of its
  own, and the `fi` ends its line.
- No line of it holds a variable, a substitution or a backslash.

A script that asks in any other way is read as written, and its `sudo` leaves
the job out. So are all steps of a job when one of them names `PATH`,
`GITHUB_PATH` or `BASH_ENV`: it could find another `sudo` than the stand-in.

Any other use of `sudo` leaves the job out, whatever is installed.
`smithers-ci apply` leaves these jobs in your CI as they are: what a job
installs on its machine is in no cache.

**Scripts.** A step can call `sudo` from a script the inventory does not read.
Every step the replay starts finds stand-ins for `sudo`, `su` and `doas` first
on its `PATH`. Each prints one line and exits 1:

> smithers-ci does not run sudo: apt-get install zsh

The step fails in the baseline and in each mode, so it is no mismatch. A script
that starts the real program by its full path does not reach a stand-in, and
neither does a step held to its inputs. In the jail, and in a step held to its
inputs on Linux, `sudo` cannot gain any privilege and fails with its own message.

**Root.** Run as root, a step needs no `sudo`, and every file of the machine is
in its reach. `smithers-ci` and `smithers-ci replay` refuse to run as root and
exit `2`. In a throwaway container, `--allow-root` lets them run.

### Verdicts

A failed target runs once more, unless it was stopped for making no progress.
`--reruns` sets another number, and `--reruns 0` turns it off. A target that
fails with the exit code and the first line of error it failed with at the
commit before, or in the first run, is not run again: twice the same is
broken, not flaky. The report says how many steps ran again and what that took,
which is in no other time. Its attempts give a target's verdict:

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

A report where normal mode's result differs from your CI's at any commit has no
speedup: a mode that gives another result has not measured your CI. The report
leads with the number of mismatches, says there is no speedup and what to do,
and lists each mismatch with its commit. A step that fails only with the files
`apply` writes committed is listed too, with its reason, and takes no speedup
away: on your files as they are, normal mode gave your CI's result.

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
commit. It leaves out what only a replay does, such as writing the file that
lists your steps for Smithers build, which `apply` commits once. For every way it leaves
out what happens before a CI machine is ready: starting the machine, fetching
the repository over the network, installing tools and moving the cache. It
also leaves out removing what a job left when its last step ended: a CI
machine is thrown away and removes nothing.

Under `--json`, each commit's normal mode says where its wall time went
(`parts`): the checkout, the start of Smithers build, deciding what to run,
each step's command, reading what the command read, keeping what it left and
storing its record, each added up over the steps, with the CPU time of each
part on Linux.

Beside the wall time of each way, the report gives the CPU time its steps
used, every process they started included, for the same run the wall time
covers. On a busy machine the wall time says how long you waited, and the CPU
time how much work was done:

```text
the steps used 26m 10s of CPU time as the baseline and 4m 02s in normal mode (6.5× less)
```

A step's CPU time does not reach the program that started it, so the replay
reads the step's processes while it runs and counts each process under the
step for itself. On Linux it reads the processes under each step four times a
second. On macOS, and on a Linux kernel that does not list the processes a
process started, it reads every process of the machine every two seconds.
What a step uses after the last reading is not seen: at most a quarter of a
second of each process on Linux, and up to two seconds elsewhere, which is
most of a step that takes a second. A process that leaves its step where no
jail holds it is not counted. On a machine whose processes cannot be read,
the report has no CPU time.

Every step that failed in a way is named, with its exit code and the first line
of its error output. When the step wrote no error, a line of what it printed
stands in. When its program is missing, the report says `` `docker` is not
installed on this machine ``. A value shaped like a credential is withheld, by
the rule the inventory uses.

Over the commits where the baseline passed it gives the total wall time of each
way and the speedup: the baseline wall time divided by the normal-mode wall
time. A failed baseline stops at its failure, so its time says nothing about
your CI. Such a commit is shown with its failure and left out of these numbers,
and the report says how many commits they cover, and how many jobs:
`over 4 of 5 commits and 3 of 5 jobs`. It also gives the number of mismatches and
the number of flaky verdicts over every commit. With a mismatch of normal mode,
these numbers cover no commit and no speedup is printed.

When no job passes the first run or the run after it, or, with `--no-trial`, no
step passes in the baseline of any commit, your CI does not pass on this machine and there is
nothing to measure. The command prints the first failure, prints no speedup and
exits with code 3.

It lists each CI job that was not replayed with its reasons,
and each file the inventory could not read, so the speedup is never read as
covering them. Under `tool versions` it lists each tool your machine has at
another version than a job asks for:

```text
tool versions
tests.yml:test  asks for node 22.x; this machine has node 26.5.0
```

Under `steps not reused` it lists each step normal mode ran: how many commits
it ran at, its name, its command, and the reason. The matrix variants of one
step that ran for one reason are one line:

```text
steps not reused
2 of 2 commits  ci.yml:test:1 (4 variants)  cargo build --verbose  never reused: it opened a network connection (cargo to 8.8.8.8 port 53), with no Cargo.lock to say what it fetches; commit Cargo.lock and this step and the 2 after it can be reused
1 of 2 commits  ci.yml:test:2 (4 variants)  cargo doc --verbose  src/lib.rs changed
1 of 2 commits  ci.yml:rustfmt: Check formatting  cargo fmt --all -- --check  src/lib.rs changed
```

A reason that names a file is a file the step read, changed by those commits.
`never reused` marks a step whose result is not kept at all, so it runs at
every commit, and the line says what it did. When what it lacks is a lockfile,
the line ends with what to do: which file to commit, and how many steps after
it in its job can then be reused with it. For `npm install` it says to commit
`package-lock.json` and install with `npm ci`. When `uv` opened the connection,
as `uvx` and `uv run` without `--locked` do, it says to commit `uv.lock` and
run the step with `uv run --locked`.

With fast mode, it also gives fast mode's selection metrics; see
[Normal mode and fast mode](modes.md#how-fast-mode-is-measured).

The report prints as text: the totals, one line for each commit that says
whether each way passed, with its wall time, the failed steps, and the steps
not reused. `--out` also writes it as an HTML file with a line for each
commit. `--json` prints it as JSON, which also holds work time, the target
counts, each failed step's command, and for each commit the steps normal mode
did not reuse with their reasons.

## See also

- [Quickstart](../getting-started/quickstart.md)
- [The cache](cache.md)
- [Command reference](../reference/cli.md)
