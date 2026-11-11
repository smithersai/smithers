---
title: "Run CI on other machines"
description: "Declare machines with S.Remotes, run ci --remote to split one run across them, read the merged results, and know what a run ships and what it does not support yet."
sidebar:
  order: 4
---

`ci --remote <name>` runs one CI selection on several machines from one
coordinator. It splits the selected roots across the machines a workspace
declares, runs one part on each at the same time, and merges their results
into one summary. No machine needs a runner script of its own.

## Declare the machines

The machines are an `S.Remotes` entry in the workspace declaration:

```ts
import { Smithers as S } from "@smthrs/targets"

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({ directory: ".flows" }),
  remotes: S.Remotes({
    boxes: S.Remote.Command({
      machines: [["ssh", "ci-1"], ["ssh", "ci-2"], ["docker", "exec", "-i", "ci"]],
      workdir: "/var/tmp/smthrs-ci",
      setup: ["pnpm install --frozen-lockfile"]
    })
  })
  // the rest of the declaration
})
```

| Option     | Required | Meaning                                                                                                                                                                  |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `machines` | yes      | One argv prefix per machine, as `@smthrs/sandbox`'s `CommandSandbox` takes it: `["ssh", "<host>"]`, `["docker", "exec", "-i", "<container>"]`, or `[]` for this machine. |
| `workdir`  | yes      | An absolute directory on each machine. Every run works in a fresh subdirectory of it per part and removes it after reading the results.                                  |
| `setup`    | no       | Shell commands run in order in the shipped tree before the targets, such as the dependency install. Default: none.                                                       |
| `cli`      | no       | The words that start the CLI on the machine. Default: `["npx", "--no", "smthrs"]`, the workspace's own installed CLI, which `setup` installs.                            |

A run has one part per machine. `S.Remote.Command` refuses an unknown option,
an empty `machines`, a relative `workdir`, and an empty `setup` command or
`cli` word.

## Run it

```sh
smthrs ci //... --remote boxes --timings last-run.json --results-file this-run.json
```

The coordinator:

1. Plans the selection locally, as `ci` always does.
2. Splits the plan's roots across the machines by the durations `--timings`
   measured, exactly as [`--shard`](../cli.md#shards) splits them.
3. Lists the workspace's files, packs them into one tar archive, and sends it to
   every machine that has roots.
4. On each machine, unpacks the tree, runs `setup`, then runs
   `<cli> ci <its roots> --results-file <file>` and reads that file back.
5. Merges the parts into one summary in the local plan's order and writes it to
   its own `--results-file`.

Each machine's output arrives as it prints, every line prefixed with its
machine, such as `machine 2: //:lint  ran  1.2s`. A machine runs with
`--audience human --ui plain`, and gets the coordinator's `--no-cache`,
`--cache-dir`, `--jobs` and `--fail-fast`.

A dependency two parts need runs on both machines. A label several machines
report keeps its worst status (`failed`, then `cancelled`, `skipped`, `ran`,
`hit`) and its longest duration, and the counts and `ok` are recomputed from
the merged rows. The coordinator's results file is a valid `--timings` file, so
each run can weigh the next one's split.

`--plan` prints the merged plan plus `remote.machines`, the roots each machine
would run, and contacts no machine.

## When a machine is lost

A machine is lost when its transport fails, or when it writes no readable
results file that reports every root it was given (a `ci` that fails before
planning writes an empty one). The coordinator runs that part once more, on a fresh session in a
fresh directory, through the flow engine's retry policy. A second loss reports
each of the part's roots `failed` with
`machine <n> was lost: <reason>`; the other machines' results still stand. A
`setup` command that exits non-zero is not a loss: the part's roots fail with
the command and its exit code, and the part is not run again.

Interrupting the coordinator ends every machine's command and closes every
session.

## Limits

- **The tree is sent whole.** Each run packs every file the workspace owns,
  holds the archive in memory, and sends it to each machine. The listing
  applies `.gitignore` and never includes `.git`, `.jj`, `node_modules`, or the
  cache directory. Nothing is synced incrementally.
- **File transfer is buffered whole.** `Session.writeFile` and
  `Session.readFile` hold a file in memory on every provider; see
  [`@smthrs/sandbox` limits](../../../../flows/sandbox/docs/limits.md).
- **Machines need the toolchain.** A machine needs `/bin/sh`, `base64`, `tar`,
  and whatever its targets run. Use `setup` for what the tree does not carry,
  such as the dependency install.
- **Output is text.** A machine's output is streamed as text lines; only the
  results file returns bytes exactly.
- **The coordinator sends no credentials.** A machine runs with its own
  environment. Give each machine its own `SMITHERS_CACHE_URL` and token to
  share a [remote cache](./share-a-remote-cache.md), which is what lets a
  shared dependency run once instead of on every machine.
- **No failure diagnostics come back.** A machine's results file carries each
  label's status, not its diagnostics; read those in the streamed output.
  That is why `--remote` refuses `--known-red` for now: there is no failure
  diagnostic to fingerprint.
- `--remote` and `--shard` are exclusive. `--remote` names an `S.Remotes`
  entry; an undeclared name is refused with the declared names listed.
