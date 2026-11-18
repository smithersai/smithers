---
title: "Command reference"
description: "Every smithers-ci command, flag and exit code."
---

```text
smithers-ci [command] [flags]
```

Run it with `bunx smithers-ci` in the root of a Git repository.

The three tables on this page are checked against the command surface in
`src/contract/Command.ts` by `test/docs.test.ts`: a command, flag, default or
exit code that one has and the other lacks fails the package's tests.

## Commands

| Command                 | What it does                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `smithers-ci`           | Measure today's CI, replay past commits, and print the speedup. Writes nothing to the repository. |
| `smithers-ci apply`     | Write the Smithers workspace, target files and CI workflow the report was measured with.          |
| `smithers-ci inventory` | Print what the repository's CI does today.                                                        |
| `smithers-ci replay`    | Replay past commits and print the replay report.                                                  |

`apply` is the only command that writes to the repository.

## Flags

| Flag        | Commands                                                     | Default  | What it does                                               |
| ----------- | ------------------------------------------------------------ | -------- | ---------------------------------------------------------- |
| `--commits` | `smithers-ci`, `smithers-ci replay`                          | `20`     | How many past commits to replay.                           |
| `--mode`    | `smithers-ci`, `smithers-ci replay`                          | `normal` | normal, fast, or both.                                     |
| `--jobs`    | `smithers-ci`, `smithers-ci replay`                          | none     | Most targets to run at once; the default is the machine's. |
| `--cache`   | `smithers-ci`, `smithers-ci replay`, `smithers-ci apply`     | none     | URL of a shared cache.                                     |
| `--out`     | `smithers-ci`, `smithers-ci replay`                          | none     | Also write the report as an HTML file here.                |
| `--json`    | `smithers-ci`, `smithers-ci inventory`, `smithers-ci replay` | `false`  | Print the document as JSON.                                |

`--mode fast` and `--mode both` add fast mode to the replay; see
[Normal mode and fast mode](../concepts/modes.md). `--cache` is described in
[The shared cache](../concepts/shared-cache.md). With `--json`, `inventory`
prints the inventory and the other two commands print the replay report.

## Exit codes

| Code | Name          | Meaning                                                                  |
| ---- | ------------- | ------------------------------------------------------------------------ |
| `0`  | `ok`          | The command finished.                                                    |
| `1`  | `mismatch`    | A replayed target's verdict in a mode differs from its baseline verdict. |
| `2`  | `usage`       | The command line was wrong: an unknown command or flag, or a bad value.  |
| `3`  | `unsupported` | The repository uses something Smithers CI cannot run yet.                |

A mismatch is defined in [How it works](../concepts/how-it-works.md#3-replay).
