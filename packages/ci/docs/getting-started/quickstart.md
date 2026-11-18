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

The baseline runs your CI's commands once per replayed commit, so the first
run takes a while. `--commits` sets how many commits to replay:

```sh
bunx smithers-ci --commits 5
```

## What it prints

The text report gives the totals: the baseline wall time, the normal-mode wall
time, the speedup (baseline wall time divided by normal-mode wall time, summed
over every commit), how many commits were replayed, and the number of
mismatches. Then it gives one line for each commit: the files it changed, and
whether each way passed, with its wall time. Under them it lists:

- every commit it did not replay because that commit had no CI it can run,
  with the reason;
- every mismatch: a target whose pass or fail in normal mode differs from the
  baseline, with its commit;
- every CI job it did not replay, with the reason, and every file it could not
  read.

`--json` also gives, for each commit and each way, its work time (the sum of
every target's own time) and how many targets were cache hits, ran, failed or
were skipped. The HTML page has a row for each commit with its times, `fail`
beside the time of a run that failed, and its mismatches.

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

Fast mode also skips targets a scorer judges safe to skip. To measure both
modes on the same commits:

```sh
bunx smithers-ci --mode both
```

Each commit then also gets a fast-mode entry, the total gives the fast-mode
wall time, and the report adds how well the skipping did. See
[Normal mode and fast mode](../concepts/modes.md).

## Exit codes

| Code | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| `0`  | The run finished.                                            |
| `1`  | A target's pass or fail in a mode differs from the baseline. |
| `2`  | The command line was wrong.                                  |
| `3`  | The repository uses something Smithers CI cannot run.        |
| `4`  | A step of the command could not finish.                      |

A mismatch is the result to look at first: it means a mode would have changed
what your CI reports. A target that failed and then passed when run again is
flaky: it counts as a pass, is counted apart, and is no mismatch.

## Make it your CI

When the report shows what you want:

```sh
bunx smithers-ci apply
```

`apply` writes the Smithers workspace, the target files and the CI workflow the
report was measured with, and adds the cache directory `.flows` to
`.gitignore`. It never replaces a file it did not generate: it names the file
and writes nothing. Review the files as you would any change, and commit them.

## Next

- [How it works](../concepts/how-it-works.md)
- [Command reference](../reference/cli.md)
