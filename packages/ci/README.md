# smithers-ci

Fast CI for agents.

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

**2026-11-18, eleventh round** (optional additions by the needlefish lane, for a step that runs `zig build`):

- `Step.tools` (optional): the programs the step starts that the machine provides, by name. The generator names them
  in the step's target (`S.Host.bin`) and in the workspace's `S.Host`: their bytes are in the target's key, and a
  target held to its inputs can start them.
- `Step.sealed` (optional): the step's `inputs` are all it reads, whatever ran before it in its working tree. Its
  target stays held to them after any step, and each target that runs before it fails when it changed one of them.
- `Inventory.toolCache` (`.flows/tools`): where a tool a step starts keeps its own cache between runs. A step names
  a directory under it in its `env`; the generated workflow then saves it with the results.

**2026-11-18, tenth round** (the independent review's 31 findings, fixed by the replay, apply and generate lanes):

- **Contract 4, which jobs run.** `blockers` adds a `secret` entry for each step that receives a secret, so a `Ci`
  never holds such a step. New features `releaseTrigger` and `writePermission`, neither in `harmless`. The importer
  writes `release-trigger` only when a push limited to `tags` is the workflow's one change trigger.
- **Contract 4, what a replay leaves out.** `Host` and `hostOf` moved here from the generator, with the feature
  `otherSystem`. `noTarget` names a job with a step that has no target. `noCommand`: `notReplayed` lists a CI job whose
  every step was a host action. `notRead(inventory)` is `unsupported` without the `smithersBuild` entry.
  `uncommittedChanges` is the feature of a working tree that differs from its commit.
- **Contract 4, how steps run.** `stepTimeoutHours` (6) limits a baseline step and a generated target. `treeOf(job)`
  and `treeOrder(jobs)` name a shared working tree and its order, and **`Inventory.ci` returns the jobs of one shared
  tree in the order they run**: `ci: build test` gives `build`, then `test`. A part that relied on a `Ci` keeping
  inventory order for Justfile recipes or `package.json` scripts sees a different order.
- **Contract 4, what steps and tools declare.** `Step.outputs` (optional): the paths and globs a step writes. A step
  after it in one working tree stays narrowed only when every earlier step has `inputs` and `outputs`.
  `Toolchain.version` may hold `${{ matrix.<key> }}`, which `expand` fills per variant. `Toolchain.job` (optional)
  is the id of the job whose step sets the tool up, and `Toolchain.action` (optional) is that step's `uses` value;
  without `job` the tool is the repository's.
- **Contract 5.** `flaky`, `notRead` and `notReplayedCommits` are optional keys of the report. In a `Mismatch`, `pass`
  and `flaky` agree, and a split step is a mismatch when the mode never reported one of its targets.
- **Contract 1.** `Attempt`: a failed target reruns up to the limit the program sets (two) or until it passes.
- **Contract 7.** `flags.cache.help` says a cache URL holds no user name or password. `exitCodeHelp.mismatch` says a
  flaky target does not make the exit code 1. The comment on `applyRefuses` says `apply` checks every path before it
  writes any; the one on `applyIgnores` says `apply` prints what it adds.
- **Contract 10.** `RunReplay` reads each commit's inventory from that commit's tree. The newest commit's CI must be
  replayable; an older commit whose CI is not is listed in `notReplayedCommits`.
- **Open (owner: `src/decompose`).** The splitter fills no `Step.outputs` until a Smithers build target can declare an
  installed tree as an output and a confined step can write.

**2026-11-17, ninth round** (asked for by the native lane):

- `--targets` (`Command.flags.targets`) names Smithers build patterns to replay, on `smithers-ci` and `replay`. The
  program parses it and passes `ReplayRequest.targets`. On a repository with no workspace of its own, a replay given
  `targets` fails `unsupported` (exit 3); it never ignores the flag.
- `ReplayReport.targets` holds the patterns replayed, present only when the repository's own targets were replayed.
  The native lane may edit `src/report` to show it above the speedup.
- `Inventory.smithersBuild` and `Inventory.ownWorkspace(inventory)` name a repository that already builds with
  Smithers build. `Command.applyRefuses` is now the two workspace files; `apply` refuses when either exists and never
  writes over a build file it did not generate.

**2026-11-17, eighth round** (the replay runs split steps):

- `Inventory.withSteps(ci, steps)` returns a `Ci` with the steps of each job replaced. `split` uses it in place of
  asserting the type; `Inventory.ci` must not be called on its own result.
- `TargetMap.labelOf` is removed. `labelsOf` is the one accessor: one label, or several for a split step.
- The replay calls `parts.decompose` before `parts.files`. The baseline runs the unsplit steps; a split step is
  compared, under its own id, with `RunRecord.combine` of the verdicts of its targets.
- `Inventory.refusal(inventory)` words every "nothing of this CI can be run" answer; `apply` and the replay use it.
- The replay says what it runs through the `Progress` service of `src/replay` (silent unless provided).

**2026-11-17, seventh round** (asked for by the splitter and replay lanes):

- `Step.inputs` are globs as Smithers build's `glob` reads them. **A target that declares its step's inputs runs
  under Smithers build's enforced read sandbox**: an undeclared read then fails the target instead of passing
  stale. A step with inputs still gets `sandbox: "none"` when its target declares no inputs, and then declares the
  whole repository: a step a later step relies on (it always runs and its result is never reused), a step that
  follows another step in its working tree (until that step has `outputs`, tenth round), and every step when
  `PACKAGE.ts` would pass 1 MiB.
- Contract 2's comment now says what `smthrs ci --plan` really prints; the replay's `planOfPrinted` converts it.
- Not adopted yet: a flag that names a repository's own wrapper script as standing for `turbo`. It waits until a
  repository's CI passes the sixth-round rule and only the wrapper stops a split.
- `land.sh` now refuses a push whose lockfile no longer installs: three commits reached `main` with a broken
  `pnpm-lock.yaml` from concurrent rebases.

**2026-11-17, sixth round** (found by the lead reading eliza's 15 CI jobs: one posts to the GitHub API, most read
`$RUNNER_TEMP` or `$GITHUB_OUTPUT`, and none of that was stopping a run):

- **A job that cannot be reproduced is never run.** `Inventory.isRunnable` is now: the job has a step and no
  blocker. A blocker is any unsupported feature outside `Inventory.harmless` (`host-action`, `trigger-filter`).
  The importer writes `host-action` for checkout, toolchain setup, cache and upload-artifact steps, and `uses` for
  every other action.
- **`Inventory.Ci` is a branded type that only `Inventory.ci` returns.** `GenerateFiles` and `Decompose` accept
  nothing else. If your code no longer compiles, call `Inventory.ci(inventory)` and delete your own rule for which
  jobs run. The replay runs the baseline from the same value.
- A job is left out together with every job that needs it (reason `needs`). In a `Ci`, every job has a step and
  every need names a job in it: a need on a job that only groups others becomes a need on the jobs it groups. The
  replay (`src/replay`) uses it and no longer has a rule of its own.
- `ReplayReport.notReplayed` lists each CI job left out with its reasons (`Inventory.notReplayed(inventory)` at the
  newest commit). The replay fills it; the report shows it above the speedup. With every job left out, the program
  exits `unsupported` and prints the list.

**2026-11-17, fifth round** (asked for by the program's lane):

- **Fast mode's judge is the judge `smthrs` binds:** `NodeControl.layerSeatEvaluator(process.env)` from
  `@smthrs/cli`. It is Jev with `AI_GATEWAY_API_KEY`, else the model the machine is signed in to. `Command.environment`
  lists the key. The program adds no variable of its own for the model, and `smithers-ci` depends on `@smthrs/cli`,
  which it also needs to run `smthrs`.
- Fast mode's ledger and the judge's flow steps stay in memory for one run. The default command writes nothing
  outside its temporary copies.

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
| `src/apply`     | Checks every generated path before anything is written   |
| `src/native`    | Replays a repository that already builds with Smithers   |
| `src/cli`       | The `smithers-ci` program                                |
