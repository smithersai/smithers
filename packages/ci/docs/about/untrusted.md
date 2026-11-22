---
title: "A repository you do not trust"
description: "Measure Smithers CI on a repository whose code may not run on your machines: the replay runs in a Cloudflare Container and only its text results come back."
---

A replay runs the repository's own commands: its install, its build, its tests.
When that code is not yours to trust, run the replay in a Cloudflare Container
instead of on your machine. `scripts/box-replay.mjs` in the Smithers repository
does it in one command:

```sh
node packages/ci/scripts/box-replay.mjs https://github.com/tj/commander.js a5a7dc0 \
  --packs <release tarballs> --commits 4 --out <results>
```

It needs `cfbox` on the machine that runs it, or the program the `CFBOX`
variable names, and the release tarballs of the Smithers CI you want measured:

```sh
node .smithers/flows/release/pack-release.mjs <release tarballs> --built
```

## What runs where

| Where                | What                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your machine         | Copies the tarballs and `scripts/box-replay.sh` into `<results>/upload`, starts the box, and takes the results back. It never clones, reads or runs the repository.                                |
| The box              | Installs bubblewrap and strace, installs the tarballs with npm, clones the repository from its URL at the commit, and runs `smithers-ci replay --commits <n> --json` as a user without privileges. |
| Back on your machine | Only the named text files below, and only as plain files. The repository's code, its dependencies and what it builds stay in the box, which is deleted when the run ends.                          |

The box gets nothing of your machine: no variable, no credential, no cache. The
command refuses a flag that would carry one in (`--env`, `--env-pass`,
`--cache`, `--cache-key`, `--add`, `--with-deps`, `--via`), a repository given
as a path on your machine, a URL that is not `https`, and a URL with a user or
a password. The replay's own `--cache` is refused too: a shared cache hands the
repository's steps a token. Flags after `--` go to the replay, as in
`-- --jobs 1`.

`--dry-run` prints the `cfbox` command and starts nothing.

## One box for each job

A box has 20 GB of disk at most and lives a day at most. A CI too large for one
box is replayed one job to a box with `--job`, which this command passes to the
replay's [`--job`](../reference/cli.md#one-job); give it once for each job:

```sh
node packages/ci/scripts/box-replay.mjs https://github.com/elizaOS/eliza 78e44531 \
  --packs <release tarballs> --commits 2 --out <results> --job pr-validation.yml:source-checks \
  --job pr-validation.yml:sdk-owning
```

At most four boxes run at once. Each job's results are in `<results>/<n>`, and
the command prints a table of them: for each job its exit code, its baseline and
normal-mode seconds over the commits, the steps it reused and its mismatches.
Under the table it adds the seconds up as `job seconds, each job alone in a 4
vCPU box`. That sum is no speedup: each box fills its own cache, so a step two
jobs share is reused in neither, and the seconds of jobs that ran apart are no
replay's wall time.

## The results

In `<results>`:

| File                                    | What it holds                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `replay.json`                           | The [replay report](../reference/cli.md#output), as `--json` prints it.          |
| `report.html`                           | The same report as a page.                                                       |
| `replay.log`                            | What the replay wrote to standard error.                                         |
| `NOT-REPRODUCED.txt`                    | The jobs `smithers-ci apply` leaves out, each with why.                          |
| `exit`                                  | The replay's [exit code](../reference/cli.md#exit-codes).                        |
| `wall-seconds`                          | How long the replay took in the box.                                             |
| `box.txt`                               | The box's CPUs, memory, disk and kernel: compare times only between boxes alike. |
| `box.log`                               | What the box printed.                                                            |
| `setup.log`, `install.log`, `clone.log` | What installing and cloning printed.                                             |

The command prints the jobs replayed, the mismatches, the speedup and, for each
commit, how many steps were reused, with the box's size beside the times. It
exits with the replay's exit code.

## The box

`--cpu` picks the box: 1, 2 or 4 vCPUs (4 by default) with 6, 8 or 12 GiB of
memory and 12, 16 or 20 GB of disk. A box is smaller than a build server, so
compare a box's times only with another box's of the same size. The replay
leaves 5 GB of the disk free and stops before it fills, saying so in the
report's `stopped`; a repository whose jobs need more disk replays fewer jobs at
once with `-- --jobs 1`.

Each job of the replay runs under bubblewrap, as on a GitHub runner with the
workflow `apply` writes, and `smthrs-observe` records what each step reads:
the box gives a user without privileges its own namespaces, and the kernel
offers seccomp user notification.
