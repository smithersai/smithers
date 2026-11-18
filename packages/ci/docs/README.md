---
title: "Smithers CI"
description: "Fast CI for agents: smithers-ci reads the CI a repository has today, turns it into incremental Smithers build targets, and replays past commits to measure the difference."
---

Smithers CI makes a repository's CI run only what a change affects. Run it in a
repository:

```sh
bunx smithers-ci
```

It reads what your CI does today, turns each command into a
[Smithers build](../../smithers/build/docs/README.md) target with a content key,
replays your past commits, and prints how long each commit took your way and the
Smithers way. It writes nothing to the repository. When the report shows what
you want, `smithers-ci apply` writes the files that make it your CI.

## Two modes

- **Normal mode** runs every target a change affects and reuses a result only
  when its key matches. The replay checks its pass or fail against your CI's.
- **Fast mode** also skips targets a scorer judges safe to skip, and the replay
  counts every failure that skipping would have missed.

See [Normal mode and fast mode](concepts/modes.md).

## Read next

| Page                                           | What it covers                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| [Quickstart](getting-started/quickstart.md)    | The first run: what it reads, what it prints, what it never touches.   |
| [How it works](concepts/how-it-works.md)       | Inventory, targets, replay and report.                                 |
| [Normal mode and fast mode](concepts/modes.md) | What each mode runs, how fast mode scores targets, and how it is held. |
| [Splitting a step](concepts/splitting.md)      | How one step over a whole workspace becomes one step per package.      |
| [Fast mode](fast-mode.md)                      | What fast mode skips, what its three numbers mean, and their limits.   |
| [Its own targets](concepts/own-targets.md)     | What happens on a repository that already builds with Smithers build.  |
| [The cache](concepts/cache.md)                 | What is cached, when it is reused, hosting it, and pointing CI at it.  |
| [Repositories](about/repositories.md)          | What Smithers CI reads, and what it does not run.                      |
| [Command reference](reference/cli.md)          | Every command, flag and exit code.                                     |
| [The Zig strategy](strategies/zig.md)          | Which files a Zig build step reads, as the Zig toolchain reports it.   |

## Where the parts live

Smithers CI is one npm package, `smithers-ci`. Its parts read and write a small
set of documents (the inventory, the plan, the run record and the replay
report), described in the [package README](../README.md).
