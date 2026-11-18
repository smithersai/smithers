# smithers-ci

Smart CI that only runs what changed.

This package holds the contracts every part of Smithers CI builds against.
Each part reads and writes these documents and never calls another part
directly, so the parts are built at the same time.

| # | Contract           | Module                                                               | What it fixes                                                                                  |
| - | ------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1 | Run record         | `RunRecord`                                                          | One run: each target's label, key, time and status, its rerun attempts, and why it was skipped |
| 2 | Plan               | `Plan`                                                               | The targets a change selects, with keys and dependencies                                       |
| 3 | Cache protocol     | [remote caching](../smithers/build/docs/workspace/remote-caching.md) | `/ac` and `/cas` over HTTP. Equal key means equal verdict                                      |
| 4 | CI inventory       | `Inventory`                                                          | What a repository's CI does today, as shell commands                                           |
| 5 | Replay report      | `ReplayReport`                                                       | Past commits run as the baseline, in normal mode and in fast mode, compared                    |
| 6 | Selection          | `Selection`                                                          | Fast mode's rows, scores, settings and metrics, as the Facebook paper defines them             |
| 7 | Command surface    | `Command`                                                            | The commands, flags and exit codes of `smithers-ci`                                            |
| 8 | Shards             | `Shard`                                                              | Which machine runs which target                                                                |
| 9 | Dependency closure | `Closure`                                                            | Every file a set of entry files reaches; one strategy per language                             |

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
| `src/cli`       | The `smithers-ci` program                                |
