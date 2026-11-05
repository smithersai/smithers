# Retained-scope campaign (#2290)

This is lane preparation, not a completed testing campaign. Start with
[report.html](report.html), [policy.json](policy.json), [inventory.json](inventory.json),
[matrix.json](matrix.json), [handoffs.json](handoffs.json) and [ledger.json](ledger.json).
No package cell is marked passed without a qualifying receipt. Implementation fixes
belong to the existing owners; B31 changes only this directory.

The source of truth is the current rulings and B31 batch. Removed Go/backend and
old app targets, their credits/desktop regressions, and obsolete mythical/Cloud
landing requirements are historical. The read-only issue snapshot retains the
folded acceptance so retained SDK cases cannot disappear during reconciliation.

## Inventory and required matrix

`inventory.json` indexes per-surface `surfaces/*.json` and sorted `inputs/*.json`
shards. Discovery uses the shared workspace-membership reader, the declared target
index, non-fixture Cargo manifests and `jj file list`. It assigns files to the
longest member path; package names such as `evals` never exclude their source.
Source directories and public entry-point neighbors stay in the conservative
denominator, including shipped src/test helpers and their implementation dependencies.
Every manifest executable requires CLI and installed-consumer E2E evidence.
Every tracked input is hashed as bytes, including transitive package/config/test
inputs. This directory is excluded from the product fingerprint to avoid recursive
snapshot hashes. `sourceBaseCommit` is the common ancestor of the lane and fetched main, stable
across campaign-only commits; `sourceSha256` binds
receipts to the actual tree, including dirty source.

Each surface retains production files, public exports, package scripts, declared
targets (including exclusive/host constraints), configurations with complete raw
coverage configuration, ignored cases, platform paths and production areas. The
production list is a conservative denominator candidate, not executed coverage.
This intentionally exposes UI, Worker, child-process and platform paths the configured
collector may omit. Raw lexical ignore scanning is a discovery aid, not a complete
semantic lint; owner review must reconcile dynamic ignores and host-specific paths.
Generated target-index content is read-only and may itself drift from PACKAGE.ts;
both are hashed. A configuration or build succeeding never proves feature behavior.

All surfaces require unit, independent integration, local and live real E2E,
bounded and long fuzz, and local and live benchmark evidence, in that order.
Tooling packages without product code still need owner qualification; an empty
production list cannot silently pass unit coverage. Missing entry points stay open.
The matrix is the required roster, not a statement that every command exists today.
Find actual candidate commands in each surface's scripts/targets/test paths, then
record the precise standalone invocation in the receipt. Shared production areas
must be reconciled individually; a broad suite name is insufficient evidence.

## Commands

Run repository actions through the typed durable flow (library catalog:
`@smthrs/flow`, `@smthrs/plan`, host Effect services, existing `automation/run-module.ts`):

```sh
smthrs flow start test/coverage-campaign --data '{"mode":"snapshot"}' --wait
smthrs flow start test/coverage-campaign --data '{"mode":"status"}' --wait
smthrs flow start test/coverage-campaign --data '{"mode":"gate"}' --wait
```

A source-only bootstrap can invoke `node .smithers/flows/test/coverage-campaign/main.mjs <mode>`.
Snapshot regenerates inventory shards and the roster; it does not run tests or
record a pass. Status inspects current source and artifacts and reports gaps. Gate
exits nonzero until every required cell qualifies. A stale snapshot, malformed
ledger, missing/corrupt artifact or escaping symlink refuses qualification. These
commands do not run arbitrary receipt commands or access a credential value.

On the lane, prepend the required environment/cwd prefix to shell commands.
Focused campaign verification runs directly:

```sh
node --import vibelang/register --test --test-concurrency=1 --experimental-test-coverage \
  --test-coverage-include='.smithers/flows/test/coverage-campaign/campaign.mjs' \
  --test-coverage-include='.smithers/flows/test/coverage-campaign/io.mjs' \
  --test-coverage-include='.smithers/flows/test/coverage-campaign/main.mjs' \
  --test-coverage-include='.smithers/flows/test/coverage-campaign/report.mjs' \
  --test-coverage-lines=100 --test-coverage-branches=100 --test-coverage-functions=100 \
  .smithers/flows/test/coverage-campaign/*.test.mjs
```

The CLI and flow smoke tests share the checked-in snapshot output, so test files
run serially. Assertions and owner concurrency gates are unchanged.

The inventory, IO, report and bootstrap modules have native Node line/branch/function measurement;
Node's report does not separately measure statements. The typed flow has separate real in-memory-engine execution/replay/refusal evidence;
the real CLI host also needs its native-helper prerequisite. Bootstrap CLI behavior
is tested with actual child processes. These
focused results do not establish package-wide coverage. No owner gate is reduced.

Every whole-package suite, MVP four-project typecheck, or database job uses
`~/lanes/bin/run-heavy` with a fresh frozen install if dispatched to a box. Examples:

```sh
~/lanes/bin/run-heavy /home/lane/sm/ws-sm-b31 -- 'pnpm install --frozen-lockfile && cd apps/mvp && pnpm typecheck'
~/lanes/bin/run-heavy --image pg /home/lane/sm/ws-sm-b31 -- 'pnpm install --frozen-lockfile && cd apps/mvp && MVP_TEST_STACK=external pnpm test'
```

The second is a recipe, not an executed result. Local/live E2E and benchmarks need
real authorized dependencies and sessions; variable names only belong in receipts.
Never bypass app error watchers or failing owner gates. Native, child-process,
browser reload/OPFS, installed-consumer and Windows qualification stay separate.

## Ledger contract

Append immutable run records to `ledger.json.receipts`; never replace a failed run
with its rerun. The latest result for a cell determines current qualification;
a later success resolves an earlier failed run without deleting it. Duplicate run
ids and invalid active records fail qualification. A record has `id`, `surface`, `tier`, `environment`, full 40-character
`commit`, current `sourceSha256`, `command: {cwd, argv}`, `runtime: {version, platform,
arch}`, ISO `startedAt`/`finishedAt`, `exitCode`, `outcome`, `tests: {passed, failed,
skipped, todo}`, `limitations` and `artifacts: [{path, kind, sha256}]`. Paths resolve
under this directory and are checked against real bytes. Supply raw logs and machine
reports, not a hand-written statement that a tool passed.

Unit adds `coverage: {metrics: {statements, branches, functions, lines}, denominator,
exclusions, childProcesses}`. Each metric is `{total, covered}`; every production file
must be in the denominator, every supported dimension complete, and exclusions
prevent whole-surface qualification. Integration adds `independent: true` and
`dependencies: "real"`. E2E adds real dependencies, all inventoried `boundaries` and
`recovery: ["failure", "reload", "cancellation"]`. Fuzz adds `fuzz: {tool, seed, runs,
budgetMs, shrinking: true, replay: [argv], counterexamples: [...]}`. Benchmark adds
real dependencies and `benchmark: {method, correctness: true, samples: [numbers],
baseline, baselineReview}`; baseline review and raw useful-work checks are mandatory.

The verifier checks structural integrity and source/artifact binding. It cannot
authenticate a producer or derive assertions/coverage semantics from arbitrary logs.
Reviewers must compare machine reports to claimed counters, denominators, platform
and source, including transitive child processes. Do not use a synthetic receipt to
claim a feature works. Test fixtures are confined to `.test.mjs` and never enter
the ledger. New bugs get a real regression, owner implementation and exact-source
Astra then Fable reviews; no review or landing receipt is inferred from local green.

`observations.json` and `evidence/` retain campaign verification and ancillary gates.
They deliberately do not qualify unit/integration/E2E/fuzz/benchmark cells. Owner-
reported reds are labeled in `handoffs.json`; B31 never presents them as freshly
executed. Owner acknowledgement, publication and landing are separate receipts.
