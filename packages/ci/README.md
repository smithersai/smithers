# smithers-ci

Smart CI that only runs what changed.

This package holds the contracts every part of Smithers CI builds against.
Each part reads and writes these documents and never calls another part
directly, so the parts are built at the same time.

| #  | Contract           | Module                                                               | What it fixes                                                                                  |
| -- | ------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1  | Run record         | `RunRecord`                                                          | One run: each target's label, key, time and status, its rerun attempts, and why it was skipped |
| 2  | Plan               | `Plan`                                                               | The targets a change selects, with keys and dependencies                                       |
| 3  | Cache protocol     | [remote caching](../smithers/build/docs/workspace/remote-caching.md) | `/ac` and `/cas` over HTTP. Equal key means equal verdict                                      |
| 4  | CI inventory       | `Inventory`                                                          | What a repository's CI does today, as shell commands                                           |
| 5  | Replay report      | `ReplayReport`                                                       | Past commits run as the baseline, in normal mode and in fast mode, compared                    |
| 6  | Selection          | `Selection`                                                          | Fast mode's rows, scores, settings and metrics, as the Facebook paper defines them             |
| 7  | Command surface    | `Command`                                                            | The commands, flags and exit codes of `smithers-ci`                                            |
| 8  | Shards             | `Shard`                                                              | Which machine runs which target                                                                |
| 9  | Dependency closure | `Closure`                                                            | Every file a set of entry files reaches; one strategy per language                             |
| 10 | Parts              | `Parts`                                                              | The function each part exports, so the command-line program can call it                        |
| 11 | Target map         | `TargetMap`                                                          | Which target each CI step became, written among the generated files                            |

## Contract changes

Newest first. A part built before a change adopts it before it lands again.

**2026-11-17, fourth round** (found by the lead running the parts together on needlefish and eliza):

- **What is CI.** An inventory lists everything a repository can run; eliza's holds 1,897 jobs, among them
  `db:cloud:migrate` and `ios:device:deploy`. `Inventory.ci(inventory)` is the only thing the baseline, the generator
  and the replay run or turn into targets: jobs a push, pull request or merge group triggers, or else the root `ci`
  recipe, each with what it needs. Empty means the program exits `unsupported`.
- **Splitting a step.** New part `src/decompose` exports `split` (`Parts.Decompose`): a step that runs a task over a
  whole workspace becomes one step per package, with `Step.inputs` and `Step.from`. `ReplayParts` gains an optional
  `decompose`; without it the CI is run unsplit.
- The generator declares `Step.inputs` as a target's inputs when present, and writes one target map entry per split
  step, naming `Step.from`. The replay compares a step with `RunRecord.combine` of `TargetMap.labelsOf`.

**2026-11-17, third round** (asked for by the Zig, fast-mode and generator lanes):

- Every pure function in a contract is marked `@throws {never}`, so VibeLang code calls it directly.
- `Closure.directories` (optional): directories read whole; `isAffectedBy` counts any file under one. An entry may
  be a build step's name. A cache key built from a closure includes `packages`.
- `Parts.CloseEntries`: what a language's closure strategy exports as `close`. `Failure.part` gains `closure`.
- `Parts.BuildRows` takes the commit's plan as an optional third argument.
- `Selection.Row.at` (optional), `Selection.unreachable` (-1) for `graphDistance`, and `RunRecord.TargetResult.tests`
  (optional). `Selection.metrics` gives the same numbers in linear time.
- `TargetMap.maxJobs` (optional): a caller never runs more generated targets at once. The generator writes 1.
- `Command.applyRefuses` and `Command.applyIgnores`: when `apply` exits `unsupported`, and what it adds to `.gitignore`.

**2026-11-17, second round** (asked for by the inventory, replay, shard, docs and command-line lanes):

- `Parts.RunReplay` takes the parts as a second argument, `ReplayParts`. `ReplayRequest.settings` is optional;
  `Selection.defaultSettings` applies without it.
- `Parts.GenerateFiles` takes optional `GenerateOptions` (`cache`). The generator also returns the target map
  (contract 11) at `TargetMap.path`; the replay finds a step's target with `TargetMap.labelOf`.
- `Command`: exit code `failed` (4), `failureExitCodes`, `exitCodeHelp`, `syntax`, `documents`, `environment`.
- `Inventory`: a step runs as `Inventory.shell` then its command; `withVariant` fills `${{ matrix.<key> }}`;
  `Step.secretEnv` and `Inventory.unsupported` are optional; a job that fails `isRunnable` is never run.
- `Shard.assign` balances by measured duration. `shardOf` is the rule when nothing is measured.

## Rules

- A contract changes in one commit that also updates its example documents in
  `test/fixtures` and its tests. No part works around a contract.
- `run-record.rc18-workspace-targets.json` and `plan.generate-package.json`
  are recorded from real runs. The other example documents were written by
  hand to show the shape.
- A target that fast mode skips has `status: "skipped"` and
  `skipReason: "predicted-safe"`. It is never reported as passed and never
  written to a cache.
- A dependency closure with an import it could not follow is affected by
  every change.
- A secret appears in an inventory by name only.

## Where each part lives

| Directory       | Part                                                     |
| --------------- | -------------------------------------------------------- |
| `src/contract`  | The contracts. Changed only as the first rule says       |
| `src/inventory` | Reads a repository's CI into contract 4                  |
| `src/generate`  | Writes Smithers targets from contract 4                  |
| `src/replay`    | Runs past commits and writes contract 5                  |
| `src/report`    | Renders contract 5 for a terminal and as HTML            |
| `src/select`    | Fast mode: builds rows, scores them, measures the result |
| `src/decompose` | Splits a coarse CI step into per-package steps           |
| `src/closure`   | Contract 9, one strategy per language                    |
| `src/cli`       | The `smithers-ci` program                                |
