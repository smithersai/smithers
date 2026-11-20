---
title: "Quickstart"
description: "Run smithers-ci in a repository: what it reads, what it prints, and what it never touches."
---

## Run it

In any directory of a Git repository:

```sh
bunx smithers-ci
```

With no command, `smithers-ci` does four things:

1. Reads what the repository's CI does today: its GitHub Actions workflows,
   Justfile, Makefile, `package.json` scripts or Turborepo configuration.
2. Turns each CI command into a Smithers build target. It keeps these in
   memory; it does not write them.
3. Replays the last 20 commits in a copy of the repository: once as your CI
   runs them today (the baseline), and once in normal mode.
4. Prints the report.

Smithers CI records the files each CI command reads, so a command runs again
only when one of them changes. On x86_64 or aarch64 Linux 5.19 or newer it
needs nothing more. In a Docker container, run it with `--cap-add SYS_PTRACE`:
Docker's default profile refuses the recorder a call it needs without that
capability. On other Linux hosts, or in a container you cannot change, install
`strace` first (`sudo apt-get install strace`). Where nothing can record, on
macOS or on Linux without `strace`, a command that names no inputs runs on
every commit, and the replay says so on standard error, and why.

Your CI starts each run with the caches the run before it left, and so does the
replay. Before the first commit it counts, each way runs once at the commit
before it. That first run is in no number; the report gives its time. `--cold`
skips it and counts from an empty cache.

The baseline runs your CI's commands once per replayed commit, so the command
takes a while. `--commits` sets how many commits to replay:

```sh
bunx smithers-ci --commits 5
```

A partial or shallow clone works too. In a clone made with
`git clone --filter=blob:none`, the replay fetches the files the replayed
commits need from the clone's remote, says how many, and leaves your clone as it
was. In a shallow clone, such as the one `actions/checkout` makes, it replays
the commits the clone holds, says how many that is, and prints the
`git fetch --deepen` command that gets the rest.

## What it needs on your machine

The replay runs your CI's commands here, with the tools you have. It downloads
no toolchain.

- A job that sets up a tool you do not have is left out, and the report names
  the tool to install.
- A tool you have at another version than a job asks for is used, and the
  report gives both versions.
- A job for another operating system is left out. When every job is, the
  command names the system in one line and exits with code 3.
- A job that cannot pass here, because it needs Docker, a service or a
  credential, is left out too. A job that fails the first run, and fails again
  at the newest commit, is listed as failing on this machine, with the first
  line of its error and the commits, and runs at no commit. The numbers cover
  the jobs that passed. `smithers-ci apply` still writes every job: it passes on
  your runners. `--no-trial` leaves no job out.
- Each job gets a checkout, a home directory and a temporary directory of its
  own, empty of anything another job wrote, as it gets a machine of its own in
  your CI. Your repository and your home are never written.

[Setup actions](../concepts/how-it-works.md#setup-actions) has the rules.

A step that stops working fails in minutes. When a step's processes use no CPU
and print nothing for 10 minutes, the replay stops it and reports `it made no
progress for 10 minutes`. A step that waits that long on purpose needs a higher
limit: `--stall-minutes 30`.

## What it prints

The text report gives the totals: the baseline wall time, the normal-mode wall
time, the speedup (baseline wall time divided by normal-mode wall time), how
many commits were replayed, and the number of mismatches. The times and the
speedup cover the commits where your CI passed and the jobs that can pass here.
When they leave some out, the speedup says what it covers:
`6.0× faster over 4 of 5 commits and 3 of 5 jobs`. When your CI failed at every
commit, the report prints no speedup. A line gives the time of each way's first
run, which is in no other number:
`the first run, with an empty cache, took 4m 10s as the baseline and 5m 02s in normal mode; it happens once and is in none of these times`.
A line gives the CPU time each way's steps used, which on a busy machine says
more than the time on the clock. Smithers CI starts once for each commit; when
normal mode took longer than your CI and that start is more than a twentieth
of your CI's time for a commit, a line gives both times:
`your CI takes 5.8s for a commit and Smithers CI takes 3.2s to start, so only a commit that reuses results is faster here`.
The speedup counts every start all the same. Then it gives one line for each
commit: the files it changed, and whether each way passed, with its wall
time. Under them it lists:

- every commit it did not replay because that commit had no CI it can run,
  with the reason;
- every step that failed, with its commit, the ways it failed in, its exit code
  and the line of its output that says what failed, or
  `` `golangci-lint` is not installed on this machine `` when its program is
  missing. A value shaped like a credential is withheld;
- every step normal mode ran and did not reuse, with its command, the reason,
  and how many commits it ran at for that reason. A reason is a file the step
  read that those commits changed, or, after `never reused`, what keeps the
  step's result from ever being used again. A step that lacks a lockfile says
  what to commit:

  ```text
  steps not reused
  2 of 2 commits  ci.yml:test:1 (4 variants)  cargo build --verbose  never reused: it opened a network connection (cargo to 8.8.8.8 port 53), with no Cargo.lock to say what it fetches; commit Cargo.lock and this step and the 2 after it can be reused
  1 of 2 commits  ci.yml:rustfmt: Check formatting  cargo fmt --all -- --check  src/lib.rs changed
  ```

- every mismatch: a target whose pass or fail in normal mode differs from the
  baseline, with its commit;
- every CI job it did not replay, with the reason, and every file it could not
  read;
- every tool your machine has at another version than a job asks for.

`--json` also gives, for each commit and each way, its CPU time, its work time
(the sum of every target's own time), how many targets were cache hits, ran, failed or
were skipped, each failed step's name, exit code, command and the line that
says what failed, and each step that was not reused with its reason. The HTML page has a line for each commit with its times, `fail` beside
the time of a run that failed, its mismatches and its failed steps.

To keep a copy or feed it to another program:

```sh
bunx smithers-ci --out report.html
bunx smithers-ci --json
```

`--out` also writes the report as an HTML file. `--json` prints the report as
JSON instead of text.

## What it does not touch

- **Your repository.** Every replayed run happens in a copy. The command writes
  no file, commit or branch to the repository you run it in. The one
  exception is the file `--out` names, when you point it inside the
  repository; the report's last line then names it.
- **Your uncommitted changes.** A replay runs commits. Changes you have not
  committed are not replayed, and the command says so on standard error.
- **Your CI.** Nothing changes until you run `smithers-ci apply`.
- **Your secrets.** It records a secret your CI uses by name only, never its
  value.

## Try fast mode

Fast mode also skips what the model that predicts which tests a change cannot
break says is safe to skip. Give the command a way to reach that model: set
`AI_GATEWAY_API_KEY`, run `claude auth login` with `ANTHROPIC_API_KEY` unset, or
run `codex login` with `SMITHERS_OPENAI_AUTH=chatgpt`. Then measure both modes
on the same commits:

```sh
bunx smithers-ci --mode both
```

Each commit then also gets a fast-mode entry, the total gives the fast-mode
wall time, and the report adds how well the skipping did: test recall, change
recall and selection rate with the counts behind them, how many questions the
model answered and how long that took, and every target fast mode skipped with
the reason. See [Normal mode and fast mode](../concepts/modes.md).

The command asks the model one small question before it copies or runs
anything. When the model cannot answer, the command exits `4` at once and says
what is missing and how to supply it.

When the model stops answering during the replay, your time is not lost. The
baseline and normal mode finish for every commit, the report prints in full and
says fast mode was not measured and why, and the command exits `4`.

## Exit codes

| Code | Meaning                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| `0`  | The run finished.                                                                                                             |
| `1`  | A target's pass or fail in a mode differs from the baseline, or `apply --check` found a file `apply` would change.            |
| `2`  | The command line was wrong.                                                                                                   |
| `3`  | The directory is not a Git repository with a commit, its CI cannot be replayed here, or its CI does not pass on this machine. |
| `4`  | A step of the command could not finish.                                                                                       |

Code `3` also means your CI does not pass on this machine: no job passed the
first run or the run after it, so there is nothing to measure. The
program prints no speedup. It prints the first failure, with the step, its
command, its exit code and the line of its output that says what failed:

```text
smithers-ci: replay: this repository's CI does not pass on this machine, so there is no speedup to measure. No job passed at adbc881.
First failure at adbc881:
  step     test.yml:lint:1
  command  golangci-lint run ./...
  exit     127
  error    `golangci-lint` is not installed on this machine
```

Install what is missing and run it again.

A mismatch is the result to look at first: it means a mode would have changed
what your CI reports. A target that failed and then passed when run again is
flaky: it counts as a pass, is counted apart, and is no mismatch.

## Make it your CI

When the report shows what you want:

```sh
bunx smithers-ci apply
```

`apply` writes the CI the report was measured with:

| File                                | What it holds                                                          |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `.github/workflows/smithers-ci.yml` | The workflow GitHub runs                                               |
| `.smithers/WORKSPACE.smithers`      | Every step of your CI, as Smithers build reads it                      |
| `.smithers/.npmignore`              | One line that keeps `.smithers/` out of the package `npm pack` builds  |
| `.smithers/ci/legs.txt`             | Which machine runs which step, when steps need different tool versions |
| `.smithers/ci/NOT-REPRODUCED.txt`   | What your CI does that the new workflow does not, when there is any    |

It changes no other file. The cache is kept outside your checkout, so there is
nothing to add to `.gitignore`, and a step of yours that checks for a clean
tree passes as it does today.

Nothing is written at the repository's root or beside your sources, and no
file `apply` writes is one your own tools read as theirs. `tsc`, ESLint,
Prettier, Biome, dprint, Vitest, Jest, Mocha, `node --test`, knip, cspell and
`npm pack` give the same result with these files as without them. The workflow
is the one file whose place GitHub fixes. It is written as the YAML rules of
ESLint, Prettier, Biome and yamllint accept it, and it tells Prettier and Biome
to leave it as written. yamllint with its default rules exits `0` with one
warning, for the key `on`, which GitHub's format fixes.

`apply` never replaces a file it did not generate: it names the file and writes
nothing. Review the files as you would any change, and commit them.

### When your repository changes

The generated files list your packages and the files each step of your CI
reads. A new package, or a new test file outside the files a step lists, is in
none of them until you run `apply` again. So the files are generated again
whenever the repository's shape changes, and the workflow makes sure of it:
its first step after setting up Node runs `smithers-ci apply --check`. That
command writes nothing; it compares the files in the commit with what `apply`
would write for that commit. When they differ, the step fails before any of
your CI runs, and names each file and the command that fixes it:

```text
.smithers/WORKSPACE.smithers is out of date: run smithers-ci apply
```

Run `bunx smithers-ci apply`, then commit the files it changed. A pull request
that adds a package fails this way until then, so a test in the new package is
never left out of a run that passes. A generated file you edit by hand fails
the same way: `apply` would write it back. Run the check yourself before you
push:

```sh
bunx smithers-ci apply --check
```

It exits `0` and prints `smithers-ci: the generated files are up to date` when
`apply` would change nothing. If you gave `apply` a `--cache` URL, give the
check the same one; the workflow does.

### When one of your tools reads a generated file

A tool told to read every file, dot directories included, reads the files
above. `cspell --dot` is one.

The replay finds it before `apply` does. It runs your steps once more on your
newest commit with the files `apply` writes in it: the same message, author,
date and place in the history, and each step is given that commit.
A step that passes in your CI and fails there is a mismatch, and the report
says why under it:

```text
3f2a1c9  normal  //:ci.yml-lint-1  pass → fail
  cspell read .smithers/WORKSPACE.smithers, which Smithers CI wrote. Add .smithers to "ignorePaths" in the cspell configuration.
```

Add the path to that tool's ignore list and run the report again. A step that
fails there without naming a file, such as one that counts the files at your
root, is listed the same way, with the files `apply` writes.

That run is one more run of your steps at one commit. Its time is on a line
of its own in the report and in none of the totals, and such a mismatch takes
no speedup away: the speedup is measured on your files as they are. To leave
the run out:

```bash
bunx smithers-ci --no-apply-check
```

No tool reads the cache: it is never in your checkout
(see [Where the cache is on a machine](../concepts/cache.md#where-the-cache-is-on-a-machine)).

## Next

- [How it works](../concepts/how-it-works.md)
- [Command reference](../reference/cli.md)
