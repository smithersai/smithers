---
name: smithers-maintenance
description: Work on Smithers workspace graph, generated documentation, benchmark or eval evidence, or durable flow authoring in this repository.
---

# Smithers maintenance

Use the owning source and current docs on the revision being changed. The source CLI (`makeCli()` in `packages/smithers/src/Cli.ts`) is the CLI syntax contract; the installed release can be stale. The 1.0 CLI separates target graph commands (`smthrs targets`, `show target`, `build|test|lint|docs|review|ci`) from durable flow commands (`smthrs flow list|plan|start`, `smthrs runs ...`). A flow start receipt does not prove completion; inspect its run and action receipts.

- **Graph or root files:** read [CONTRIBUTING.md](../../../CONTRIBUTING.md), especially root-file and target-index generation. `PACKAGE.ts` declares targets; generated companions and the whole declaration-set index have explicit checks. Use `pnpm run target-index` when that contract calls for regeneration. The tree splits into `apps/` and `packages/`, never by language: a Rust crate lives under `packages/` beside its consumer (for example `packages/smithers/flows/jj-wasm`), so never add a top-level folder per language, such as a crates folder.
- **Build/install/cache:** read [build](../../../packages/smithers/build/README.md), [workspace remote caching](../../../packages/smithers/build/docs/workspace/smithers-cloud-cache.md), and [cache trust](../../../packages/smithers/build/infra/CACHE-TRUST.md). The install flow currently supports pnpm only; Bun can still run target tools. Install actions use expected filesystem boundaries and do not enter the shared engine cache. The target `/ac` cache differs from engine step-cache/artifacts; hosted and self-hosted cache implementations need matching route, bound, and credential behavior.
- **Type checking:** every `Typecheck` target, package `check` script, and `Markdown.CodeBlocks` target runs `vibelang`, VibeLang's compiler: TypeScript 7's checker, which also reads the `.vibe` source of the workspace packages a package imports, each `.vibe` file with its own package's VibeLang settings (VibeLang D278). TypeScript 7 rejects some code TypeScript 5.9 accepted; fix the code, not the gate. `typescript` 5.9 stays installed for typescript-eslint and editors. TypeScript 7 ignores tsconfig `plugins`, so `@effect/language-service` reports only in a TypeScript 5 editor; `tsc` never ran it either, because it is not patched in. In `.vibe` files VibeLang's EK4801-EK4825 cover its rules.
- **VibeLang sources in builds and bundles:** a workspace package's exports name its source, so a `.vibe` module reaches every dependent, and tsc and plain bundlers cannot read it. `packages/repo-targets/scripts/build-library.mjs` picks the compiler per package (`packageCompiler`): vibelang when the package's `src`, or a linked dependency's `src`, holds `.vibe`; tsc otherwise. `buildLibrary`, the four hand-written build scripts, and `check-api-baseline.mjs` use that choice, and a package with its own `.vibe` sources takes its CommonJS from vibelang's ESM. Every bundler that bundles workspace sources takes the VibeLang plugin, rooted at the bundled app or package so each `.vibe` module compiles with its own package's tsconfig: `vibelang-vite` in Vite configs (apps/mvp, apps/app, apps/site), `vibelang-unplugin/esbuild` in esbuild scripts (browser-check, build-tui, build-views, model-host, the coding host, the design mock), `vibelang-unplugin/bun` in Bun.build (TUI binaries). An Alchemy Worker evaluates its own props, so its `build` takes `vibelang-unplugin/deferred` through `apps/mvp/infra/WorkerBuild.ts`; a static plugin import there would bundle the compiler into the Worker. Packing requires `.vibe` modules' ESM, declarations and CommonJS, and a package that ships `src/**/*.ts` also lists `src/**/*.vibe` in `files`.
- **Relative specifiers when converting to `.vibe`:** TypeScript's declaration emit copies a relative specifier as written and VibeLang does the same (VIP-27), so rewriting a written `./<file>.js` changes the published `.d.ts`: keep it. A `.vibe` importer of a converted module writes `./<file>.vibe`, which declaration emit prints in its TypeScript spelling; `./<file>.ts` there fails with TS2307.
- **Tests that load VibeLang (`.vibe`) source:** a workspace package exports its source, so a suite that imports a migrated package loads `.vibe` modules. Every `vitest.config.ts` runs `vibelang-vite` with the package's test tsconfig, collects `*.test.vibe` beside `*.test.ts`, and counts `.vibe` files in its coverage globs; a `.vibe` module of another workspace package compiles with that package's own tsconfig. The CLI loads its own loader (see VibeLang source in Node below). A suite whose tests start Node on other source, such as `node -e`, sets `register: true` on the plugin, which puts `vibelang/register` in the `NODE_OPTIONS` its processes inherit; a child spawned with `NODE_OPTIONS` cleared needs `--import vibelang/register` itself. A package that imports `@effect/vitest` must resolve the same vitest copy as its runner (one `vite` version), or `describe` fails reading `config`. `node --test` on source needs `--import vibelang/register`. Bun loads `.vibe` through the `vibelang/bun` preload in the `bunfig.toml` of the directory Bun starts in, a package or the repository root (top level for `bun run`, `[test]` for `bun test`); `bun test` never discovers `*.test.vibe`, so a Bun suite imports `.vibe` modules from `.test.ts` files. `BuildAndCheckTypeScriptPackage`'s default source and test globs name `.{ts,vibe}`, so its targets are keyed on `.vibe` files.
- **Counting SQL statements and rows in a test:** provide `Statement.CurrentTransformer` (`effect/unstable/sql/Statement`) around the effect under test; `self.compile()` gives `[text, params]`. Re-run only SELECT/WITH text with `sql.unsafe(text, params)` under `Effect.provideService(Statement.CurrentTransformer, undefined)` to count rows, then return `self`. Example: `packages/smithers/control/test/SqlControlRuntime.test.ts`, "global watch bounds SQL inventory".
- **Source scanners and VibeLang:** a tool that reads sources treats `.vibe` as it treats `.ts`: VibeLang's imports, exports, type arguments and calls are TypeScript syntax, so `packages/repo-targets/src/ImportAnalysis.ts` parses a `.vibe` file as TypeScript, and every extension list in a scanner names `.vibe` (ImportRules, the dependency-boundary, test-pin, egress and fault-skip gates, LLM review batching, `ReviewJsdocAgainstCode`, `SdkRules`' Jev globs, the import-closure resolver, the CLI's implementation fingerprint, the public export audit, the site's published-links gate). Every package's `circular` target runs the one guard, `packages/repo-targets/scripts/circular.mjs` (`CircularImports`), which reads the module graph the VibeLang compiler resolves, so a cycle through `.vibe` modules fails; see the [repo-targets README](../../../packages/repo-targets/README.md#circular-imports). A script that imports CLI source in-process calls `installEffectResolution` first, which installs `vibelang/register`.
- **Documentation:** Author library documentation in each package's `docs/` directory; it ships with the npm package. Run `pnpm docs:check` to verify tarball contents. Main-site projections use `pnpm --filter @smithers/site run sync:docs`.
- **Docs gates in a fresh clone:** after `pnpm install --frozen-lockfile`, build the `smithers-jj-export` helper (command under Bun host below) before `pnpm docs:sync`, which otherwise fails with "smithers-jj-export is missing". A single-file `vitest run <file>` exits 1 on the package's 100% coverage threshold even when every test passes; the full package suite is the gate.
- **Benchmarks or performance claims:** read [.smithers/flows/bench/README.md](../../../.smithers/flows/bench/README.md). Distinguish the deterministic PR gate from scheduled observed timings, review candidate baselines, and retain methods and limitations with any claim.
- **Evals:** read the owning suite's README, including [agent](../../../packages/smithers/agent/regression/README.md) and [seeded review](../../../.smithers/flows/review/seeded-bugs/README.md). Keep offline deterministic gates and deliberate baseline updates separate from live model measurements and spending.
- **Flows:** read [@smthrs/flow](../../../packages/smithers/flows/flow/README.md) and [CLI reference](../../../packages/smithers/docs/reference/cli/README.md). A file flow at `.smithers/flows/<name>/flow.ts` or `flow.vibe` (mvp.md M-49) default-exports a tagged `Flow.make` from `@smthrs/flow`. Export its action implementations as the optional named `layer` (`Declared.toLayer`, `AgentAction.layer`, or `Layer.mergeAll`); the registry composes it against the local host platform and agent services. Export implementations directly; the host owns `Action.Implementations`. Acquire extra dependencies during layer construction so missing services are refused at load. Use stable `Node.capture` callbacks for canonical persisted composition and matching `implementationVersion` declarations/registrations for sealed idempotent actions. New authoring uses Effect Schema, not retired JSX/Zod task examples. A decision inside a flow (classify, filter, rank, route, yes/no over items) asks Jev through `Classifier.make` and the host `Evaluator`, as one request with one question per item, never through an LLM seat; see [jev-check](../../../.smithers/flows/coding/jev-check.ts).
- **Plans:** read [plan](../../../packages/smithers/flows/plan/README.md) and [plan-store](../../../packages/smithers/flows/plan-store/README.md). Node payloads are persisted as plaintext in `node_json` and approval cards without redaction; keep credentials out and resolve them at dispatch. Persisted plans are verified on write and read, and append uses an immutable-history compare-and-swap over the approved base and running prefix.
- **Generated or untrusted flow declarations:** read [core planning rules](../../../packages/smithers/flows/core/README.md). `Graph.build` executes bodies and planning callbacks with the caller's process authority; capability/effect metadata does not sandbox that code. Translate validated data into nodes with trusted code, or plan untrusted code in an externally isolated process.
- **Runtime or persistence:** read [flows runtime](../../../packages/smithers/flows/README.md), [engine](../../../packages/smithers/flows/engine/README.md), and [engine-store](../../../packages/smithers/flows/engine-store/README.md). `@smthrs/flow` declares behavior, the engine makes decisions, and the storage seam changes where state lives. Node and Bun use distinct native host/SQL adapters over the same SQLite migrations, journal, stores, cache, and recovery. Run migrations before SQL-backed services and use one writer for journal/state transitions; demonstrate cross-runtime recovery and cancellation. Browser bundling alone does not establish durable browser execution.
- **Journal and ownership fencing:** read [journal](../../../packages/smithers/flows/journal/README.md) and [run-store](../../../packages/smithers/flows/run-store/README.md). Ownership is arbitrated by the journal's injectable `Consensus` strategy (`SqlConsensus` over `flows_consensus_leases` by default, `Consensus.layerLocal` in-process); fenced durable emissions join its `guard`, so the run must be claimed and activated through it, and the journal and run store must share one strategy instance. `RunStore` mirrors the outcome on `flows_runs`, so a fixture that forges ownership in SQL writes both. `emitDurableUnfenced` is only for genuinely ownerless admission or repair, never a bypass for `fence_lost`. An expired lease alone does not authorize takeover; `LivenessEvidence` must be current, and an unknown probe counts as alive.
- **Step cache migrations:** read [step-cache](../../../packages/smithers/flows/step-cache/README.md). The earlier 1.0 RC migration 2002 identity is accepted explicitly; preserve its ledger and cached results during upgrade. An unknown migration identity remains a failure, not a reason to delete a runtime database.
- **Time travel:** read [time-travel](../../../packages/smithers/flows/time-travel/README.md) before changing fork, rewind, or their receipts. A durable fork reuses completed prefix attempts by their original action identities and gives new work child-scoped keys; rewind archives future waits and refuses crossed irreversible effects or live descendants. Test recovery after an interrupted mutation.
- **Sync:** read [sync](../../../packages/smithers/flows/sync/README.md) before changing cursors, subscriptions, or gateway mounts. Persist applied cursor progress with consumer state; change feeds are hints and a re-list is authoritative. Preserve rewind generation handling: `lineage_changed` requires rebuilding the projection. The native gateway serves branch presence at `POST /branch` when its authenticated runtime bridge is configured; branch commands and share-link bootstrap remain unserved on that mount, and `Branch.WatchRoster` returns `unsupported`.
- **Artifacts:** read [artifact storage](../../../packages/smithers/flows/artifacts/README.md). Its filesystem backend needs trusted host filesystem semantics; kernel-guarded filesystem access cannot substitute for them. Treat deletion as explicit and keep engine-store responsible for liveness/reachability.
- **Browser host:** read [platform-browser](../../../packages/smithers/flows/platform-browser/README.md). Its bash, filesystem, and jj views must share one volume, and a mounted filesystem is durable across a reload only after the mount's `sync()`. The durable flow engine runs in one dedicated worker per origin, the leader tab's, chosen with a Web Lock, and keeps its step record in SQLite on OPFS (`BrowserRuntime`, `BrowserEngine`); `apps/mvp`'s agent runs on it. Do not infer browser durability from a successful build or import.
- **Bun host:** read [platform-bun](../../../packages/smithers/flows/platform-bun/README.md) before changing its filesystem or process adapters. Its trusted filesystem boundary runs the native `smithers-jj-export` helper (build with `cargo build --locked --release -p smithers-ffi --bin smithers-jj-export` or set an absolute `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY`); `PATH` is never searched. Bun's host bundle is not the browser adapter.
- **VibeLang source in Node:** a workspace package's exports name its source, and a migrated package's source is `.vibe`, which Node loads only through `vibelang/register`. Every Node process that runs source must install it before the first `.vibe` import: `installEffectResolution` installs it (so `packages/smithers/bin/smithers.mjs`, `node src/bin.ts`, `smithers-build`, flows, declaration graphs, and scripts that import CLI source in-process get it), the workspace runtime's `imports: ["vibelang/register"]` in `.smithers/WORKSPACE.ts` preloads it for every `NodeTest` and `NodeBinary` target, and a script runs as `node --import vibelang/register file.ts`. Keep `packages/smithers/src/bin.ts`'s static imports out of migrated packages: they load before `installEffectResolution` runs. Action children receive no `NODE_OPTIONS`, so an action's argv must carry the flag. Compiles are cached on disk (`VIBELANG_CACHE_DIR`, `VIBELANG_DISABLE_CACHE=1`, `VIBELANG_REGISTER_DEBUG=1` to see hits); a type error stops the import with the diagnostics, which the CLI prints.
- **Node host:** read [platform-node](../../../packages/smithers/flows/platform-node/README.md) before changing containment or process recovery. Confined operations require the `smithers-jj-export` helper built with the Rust toolchain `rust-toolchain.toml` pins; a missing helper refuses them. `ProcessLedger.layerMemory` cannot recover escaped children after a host crash, and permission checks belong around the host service bundle.

For app work, read [apps/mvp/AGENTS.md](../../../apps/mvp/AGENTS.md) and [the rulings](../../../apps/mvp/docs/rulings.md); the old stack (`apps/app`, `apps/server`, `packages/backend`) was removed on 2026-10-21 and is readable with `jj file show -r 78407fce59dd <path>`. For TUI changes, read [apps/tui/AGENTS.md](../../../apps/tui/AGENTS.md) and its linked README. Treat issue state as a separate receipt from code status.

- **Repository automation:** a repository action a person or agent runs (release steps, landing, docs sync, benchmarks, checks) is a typed flow in the repository flows directory whose action runs its module through `.smithers/flows/automation/run-module.ts`; start it with `smthrs flow start <name> --data '<json>' --wait`. Code that serves one package lives with that package (`packages/repo-targets/contracts` holds repository build-graph and workflow contracts). Never add a top-level scripts folder (#4094).
- **Bootstrap landing helper:** `pnpm commit` runs `.smithers/flows/land/commit.mjs`, the module behind the `land` flow, directly so a fix still lands when `smthrs` on `main` is broken. Every authorized `pnpm commit --push` invocation must pass repeatable `--test "<command>"` flags. Commands run before VCS mutation with Bash pipefail. For an explicit exception, use `--no-test "<reason>"`; the helper records `Landing-Tests` in the commit. Require exit zero and `LANDED <sha>`, emitted only after fetching remote main and verifying ancestry. Push output alone is not a landing receipt.

## Parallel lane identities

Before rebasing a lane that adds decisions or Postgres migrations, fetch main
and, under the existing `~/smithers-builders/main-push.lock`, run
`node .smithers/flows/land/numbering.mjs prepare main@origin`. It allocates
colliding decisions and all incoming migrations below the published high-water
mark, rewriting only lane-added reference lines. Never renumber a migration
already on main. `node .smithers/flows/land/numbering.mjs check` rejects duplicate
numbers and unregistered migrations without an install. Add new migration tests
in separate files; existing migration tests and ledger identities stay intact.
See [parallel agents](../../../docs/devx/parallel-agents.md).

## Source-only parallel workspaces

Use `node .smithers/flows/land/workspace.mjs` from the invoking workspace:

- `create ~/smithers-builders/ws-<lane> <lane>`: a full source checkout on
  immutable `main@origin`, with no install. Never parent a lane on another
  workspace's mutable working-copy commit.
- `sync`: fetch, allocate incoming numbers before rebase, rebase the private
  lane, and repair known generated migration/schema sections. Ordinary conflicts
  stop the command. Run only in your own workspace.
- `recover`: preserve dirty source files and deletion metadata under the
  invoking `.jj/agent-recovery/`, integrate its recorded working-copy operation,
  run jj's supported stale recovery, and replay only the saved delta. It never
  overlays a stale full tree. A conflicting delta stays visible and the saved
  bytes remain available. Do not remove an unresolved safeguard.
- `land --message "<gitmoji conventional message>" --test "<remote command>"`:
  serialize with the same `~/smithers-builders/main-push.lock` legacy lanes use,
  sync, regenerate/check the target index on the mini (cfbox on capacity timeout), run explicit commands,
  reject conflicts, advance main by ancestry, push, verify, and print
  `LANDED <full id>`. The full affected run and its receipt precede FIFO admission.
  A FIFO lease spans sync, preparation, receipt checking, bounded validation and push;
  queued landers hold no farm slot. Publication re-fetches main and refuses a
  changed validation base or source, and an expired or reclaimed ticket cannot push.
  Before bounded validation, a newer main keeps the receipt unless intervening
  affected sets overlap; the refusal names the overlapping commit and targets.
  `--validated "<existing receipt>"` records previously run
  checks when rerunning is unavailable; it does not claim fresh execution.
- `land --require path[=content] ...`: require a file/content predicate on
  fetched main. This fails promptly rather than waiting on a rewritten commit id.
- A land touching `apps/mvp` runs all four `pnpm typecheck` projects on the farm,
  under its FIFO lease and even with `--validated`. A type error or a farm with no
  answer refuses it.
- Every land first runs the tests its change affects on the farm, before any
  FIFO ticket: the index's test targets the change reaches, the tests of every
  workspace package depending on it and, when it reaches apps/mvp, apps/mvp's
  whole Vitest suite in six shards, each in its own cfbox `pg` box. `--validated` doesn't skip it. A run
  with fewer suites than the affected set is incomplete and permits landing with
  the stage recorded in the land log and proxy inbox;
  a failure that passes on main refuses it. Docs and generated-index edits only
  select their explicit readers. Unchanged zero-test files are compared on the
  parent and reported. App gates queue separately with at most seven pg jobs,
  a 30-minute whole-gate wall budget starting before metadata inspection and
  including metadata, admission and cleanup, and no mini fallback. See docs/devx/parallel-agents.md, "The land's affected tests".
- `land --no-review-needed "<reason>"`: land a commit the review gate refuses,
  recording who and why in the land log and the proxy inbox. It refuses where
  that inbox can't be written. See "Review receipts" below.
- `remove`: forget and delete only a tool-owned workspace whose source is
  already on remote main. Unpublished edits, unresolved safeguards, and ignored
  personal files (including installs) prevent removal. The source and tool state
  are deleted together. Never run it on the main checkout or someone else's lane.

`SMITHERS_CO_AUTHOR` supplies your own co-author trailer when the tool describes
a change; it never assigns a different agent as author.

`SMITHERS_LOCK_TIMEOUT_MS` bounds admission (default one hour).
`SMITHERS_LOCK_MAX_HOLD_MS` bounds a holder (default fifteen minutes).
`SMITHERS_LOCK_STALE_MS` bounds a missing heartbeat (default one minute), with
`SMITHERS_LOCK_HEARTBEAT_MS` refreshing every five seconds. Waiters reclaim
expired or dead tickets, logging why; unknown legacy mkdir owners remain untouched.
Atomic legacy acquisition also requires Python 3 (standard library only): its
exclusive rename publishes the prepared owner directory without replacing an
existing empty mkdir lock. Remote publication requires a stop receipt before
reclamation; a remote deadline alone never proves termination.
`SMITHERS_LAND_LOCK` is an
explicit override for independent repositories/tests; all lanes of this repo
keep the shared default. `SMITHERS_MINI_RUN` selects the farm client (default
`~/.smithers-lead/scratchpad-mirror/mini-run`). No test command or install is
invented on the MacBook. Existing manual landings continue to work.
Target-index admission sets `MINI_RUN_WAIT_SECONDS=0`. Exit 7 or a failed
`CAPACITY_TIMEOUT` selects `SMITHERS_CFBOX` (default `~/.vibe-orch/bin/cfbox`),
which receives only jj-listed source. `SMITHERS_CFBOX_VIA` selects an upload
relay; cfbox caching is disabled in relay mode.

This is bootstrap automation, like `commit.mjs`: it must recover a source-only
checkout even when the installed CLI or durable host cannot load. It does not
introduce a workflow engine, background retry service, or product action.

## Review receipts

A lane's statement that Astra found nothing is not a review. `land` and
`pnpm commit --push` refuse any commit that touches a path in
`.smithers/flows/land/review-required.txt` unless a receipt shows Codex Astra
passed that exact diff. Run the review from your workspace after your last
edit; a hand-written receipt does not pass:

```sh
node .smithers/flows/land/review.mjs --rev @ --prompt-file <what to check>
node .smithers/flows/land/review.mjs --rev 'main@origin..@' --prompt-file <what to check>
```

Exit 0 is PASS, 2 is FAIL, 1 is no verdict and no receipt. Add
`--model gpt-6.1-sol` when Astra is unavailable. Set
`SMITHERS_REVIEW_CODEX_HOME` to the Codex account to bill (then `CODEX_HOME`,
then `~/.smithers/accounts/codex-2`). Read the
[parallel-agents note](../../../docs/devx/parallel-agents.md#review-receipts)
for what a receipt proves and what a follow-up fix costs.

## Farm bootstrap clients

Versioned sources: `.smithers/flows/land/farm/`. Install with
`node .smithers/flows/land/farm/install.mjs`; it atomically replaces the seven
client/helper files beside existing state and preserves private
`farm-config.json`. Use `MINI_RUN_SRC=$PWD` or `LAT_RUN_SRC=$PWD` for your own
source workspace. Private host aliases/endpoints stay outside the repository.
See the [farm README](../../../.smithers/flows/land/farm/README.md) for admission,
execution and cleanup contracts. Disk preflight failures require ownership and
capacity investigation; never prune another lane's data or reset its runtime.
Mini artifacts download only with `MINI_RUN_ARTIFACTS=1`.

## Workspace installs and generated files

- **A fresh jj workspace needs its own install.** Run `pnpm install --frozen-lockfile --prefer-offline` in it. A `node_modules` symlinked from another checkout resolves every `@smthrs/*` import to that checkout's packages, so probes, typechecks and A/B runs silently test its code.
- **TS2307 after a rebase** ("Cannot find module `@smthrs/<pkg>/<export>`") in a workspace that installed before its base gained a workspace dependency is stale links, not a broken export. Rerun the install there before reporting it.
- **`bun install`** (run to refresh `bun.lock`) rewrites `node_modules` symlinks into `node_modules/.bun/<pkg>`, and pnpm then reports "Already up to date" without relinking. Reinstall with pnpm afterwards.
- **Lockfiles move with `package.json`.** Any `package.json` edit refreshes `pnpm-lock.yaml` and `bun.lock` (`pnpm install --lockfile-only`, `bun install --lockfile-only`) in the same change. pnpm records a member's peer specifiers in its importer entry, so a new `peerDependency` left out fails every frozen install before a test runs.
- **Target index.** A `PACKAGE.ts` edit or a new source file under `packages/` re-keys `.smithers/target-index.json`. Regenerate it in the same change with `pnpm run target-index` from a workspace-local install (never `build --write`), or the Drift workflow goes red. A new `.smithers/flows/**/*.test.ts` also needs its runner in `.smithers/flows/PACKAGE.ts`, or `//.smithers/flows:testCoverage` goes red.
- **`smithers-jj-export` helper.** `AtomicFileSystem.syncDirectory ... Operation not supported (os error 45)` means the helper binary is older than the source. Rebuild it in your workspace; never point `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` at another checkout's build.
- **Testing a host without jj.** `NodeJj` spawns nothing at build; the first `Jj` operation probes `jj --version`, so a test expecting a construction-time `JjError` calls an operation. Strip jj from `PATH` by removing entries that hold an executable `jj`; Homebrew's `/opt/homebrew/bin` also holds `node` and `timeout`, so call those by absolute path.

## Lint, CI and release gates

- `pnpm check` and package `check` scripts don't run lint. Before landing a cross-package change run `pnpm -r --no-bail --no-sort --if-present run lint` (25 lint scripts were red under a green typecheck).
- dprint has no root config: each package has its own `dprint.json`, so run it from the package's directory. "No files found" or "File ignored" means nothing was checked.
- apps/mvp's typecheck gate is `pnpm typecheck` (app, worker, infra and evals). `vibelang -p tsconfig.json` alone let ES2023 APIs onto main.
- `.github/workflows/ci.yml` is generated by the `ci` target in the root `PACKAGE.ts` and drift-checked by `//:ci`, a step of the job it configures. Never hand-edit it: set the target's `mode` to `"write"`, build `//:ci`, set it back. `release.yml` is not generated.
- `ci.yml`'s concurrency group stays per ref. Per-commit groups (#2071) queued 20 to 40 main runs and none finished.
- The macOS and Windows package suites are advisory (`matrix.advisory`, `continue-on-error`): their failures can't fail the run.
- A fix that widens a repo-wide gate's scan runs that gate repo-wide before landing; green in its own package, one such fix found 80 violations in 8 packages.
- A generator gate that passes locally and fails in a clean checkout is reading an input that was never committed.
- `//:docsDrift` and `//packages/repo-targets:conflictMarkers` refuse locally with "the write-set guard cannot restore the gitignored tree" above 50,000 gitignored entries; `.artifacts` and `docs/reviews` are the usual bulk.
- A gate's colour is not evidence until you know it ran. A step skipped because an earlier step failed reads like a pass: read each step's conclusion with `gh run view <id> --json jobs`.
- `.smithers/flows/release/cut-release.mjs` ends with `lane-checks.mjs docs-all` and `//...:fmt`, which stop the cut on reds other lanes left on main. Run both before starting it.
- A local `build-release.mjs` and `pack-release.mjs` pack has no native helper. Set `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` to run flows from its tarballs.
- A Rust edit under `packages/smithers/flows/jj-wasm` changes `flows_jj.wasm`. Rebuild it with that package's `build-wasm.mjs`, or the release gate's byte comparison fails.
- The changelog check counts commits since the last tag, so every new commit makes it stale. Regenerate right before a release run with `generate-changelog.mjs --to origin/main`, never a local HEAD. The cut commit uses the `release:` type.
- A cut is ready only when `release.yml`'s dry run is green (`gh workflow run release.yml -f releaseTag=<tag> -f sourceRef=<sha> -F dryRun=true`): a lane's local "release gates pass" covered 8 of 30+ gates and rc.18 failed 23.

## Test traps

- `packages/smithers/test/EndToEnd.test.ts` is one sequential story (init through gc). A `-t` filter empties `runId`; run the whole file with a 15 to 25 minute bound.
- build-cli tests false-red in a shell that exports `*_API_KEY` or `*_TOKEN` values: the output redactor rewrites them inside digests. Rerun under `env -i HOME="$HOME" PATH="$PATH" TMPDIR="$TMPDIR" TERM=dumb` before blaming a change.
- `smthrs test` gives a child only `Exec.inheritedEnvironmentNames` plus the target's declared env, so a live-credential test run through it skips its live turn and passes. Run live-credential tests directly.
- A CI-only failure at about 4,010 ms in a bun test that polls real loopback sockets is the helper's own 4 s deadline on two-core runners. Raise the helper's ceiling to 30 s and the test's timeout to 60 s; fake timers don't apply to socket latency.
- Under fleet load (load average near 60) every wall-clock-bounded test can go red, and platform-bun's real-process tests (`index`, `LeaderExit`, `BunHostContainment`) flake above about 25. Rerun the file alone, compare user+sys with real time, and prove a red pre-existing by source swap; never raise a reviewed timeout.
- Vitest rejects `--poolOptions.*` and `--minWorkers` on the CLI. Use `--maxConcurrency=1 --no-file-parallelism`.
- `@vitest/coverage-v8` remaps a module Node loaded natively in a test worker (tsx `tsImport`, build-cli's `PACKAGE.ts` loader, `vibelang/register`) against Vite's transform of the same file; that coverage is noise.
- A package nested under `packages/smithers/ui` names its suite directory `<pkg>/test/`, not `<pkg>/tests/`: ui's `bun test tests` substring-matches nested directories. Bun coverage drops a `?fresh` query import; use `--isolate`.
- bun suites that register happy-dom per file depend on readdir order. Preload through bunfig: evaluate the shared module graph, then register happy-dom. React `onChange` needs focus, input and keyup events dispatched.
- `Bun.build` leaves an unresolvable dynamic `import()` external and still reports success. Pair a bundle-content assertion with a failing control.
- A bun script run from `/tmp` resolves bare imports from `~/.bun/install/cache`, not the repo. Run probes inside the package.
- `@effect/vitest`'s `it.effect` provides `TestClock`, so `Effect.sleep` and `Effect.timeout` never fire; hang protection races a wall-clock `setTimeout` through `Effect.callback`. `TestClock` also hangs `FlowEngine.layerMemory` runs, and a fast `TestClock` lapses the survivor's own lease in engine-store reclaim tests on PostgreSQL.
- Bun's fetch retries a PUT once when a reused keep-alive connection is reset.
- Effect's `FetchHttpClient.Fetch` caches `globalThis.fetch` on first read, so `vi.stubGlobal("fetch")` after the first request in a file is ignored. Use a loopback server.
- Editing `packages/smithers/agent/harness/src/internal/cellPrompt.ts` changes `request.system[0]` of every recorded call: re-record every `RecordedModel` fixture, or replay dies with `UnscriptedModelError`.
- Two processes writing one SQLite memory database both persist even with `busy_timeout 0`, because `WriteRetry` absorbs `SQLITE_BUSY`. A concurrent-writer test can't prove a busy-timeout fix.
- Stryker runs out of tree on these vitest/ESM/Effect packages. Under pnpm, `plugins` must be the absolute path of `@stryker-mutator/vitest-runner/dist/src/index.js`; never add Stryker as a repo dependency.

## Effect, engine and journal traps

- `Effect.acquireRelease` registers its finalizer only after `acquire` succeeds; a multi-step acquire leaks what it built before failing. One resource per acquire.
- `Layer.provide(SomeDefaultLayer)` under a layer that expects the ambient service silently replaces the host's wiring. It swapped a proxy-aware `HttpClient` for undici's default, and sandbox egress bypassed the proxy.
- A layer's `ROut` is contravariant: annotating `Layer<never, …>` or inferring `ReadonlyArray<L>` from mixed layers erases provided services. Use a const tuple parameter and `Layer.mergeAll`.
- `Stream.updateContext` doesn't reach the effect `Stream.unwrap` runs at start. Remove or replace a service with `Effect.updateContext` on the consuming effect, and assert it took.
- `@effect/platform-node` and `-bun` depend on `@effect/platform-node-shared` with a caret range, so a consumer pinned to one Effect version can resolve an adapter that demands a newer one. Pin the adapter as an explicit dependency: `overrides` fixes npm, not pnpm.
- An engine-store failure placed in an action's typed `Fail` channel is decoded by the action's error schema and surfaces as "SchemaError: Expected never". Engine refusals go on the defect channel as encoded tagged fields without `message`.
- `Redaction.redact` in `@smthrs/journal` is the durable write path, not a log filter; any pass-through shortcut writes credentials into `payload_json`. It also redacts payload keys by name: a key ending in `token`, `session` or `signature` comes back `[REDACTED]`, so don't use one for data a reader needs.
- Redaction regexes: an unbounded prefix before a required literal is quadratic (11 s on a 400 kB line), and Bun's JavaScriptCore interprets any regex with a lookbehind, 30 to 70 times slower than V8. Prefilter with a literal search.
- `child_process.spawn` throws synchronously for an `ENOTDIR` cwd (Bun and Node), while a missing cwd is an async `ENOENT` indistinguishable from a missing executable. Check the cwd first and route both through one typed error.
- The bash flow's output cut happens in the bounded capture of `packages/smithers/agent/std/src/internal/Exec.ts` (`maxCaptureBytes`), which `Bash.ts` only configures.
- `control.agent.*` trace records: a new tag emitted mid-frame shifts the ordinals `traceIdentity` hashes, so a resumed run republishes its prefix; add the tag to `AgentSession`'s `unordered` set. `model-requested.messages` holds only what that call added.
- A journal-decoded step failure prints `Error [<tag>]` and keeps only name, message and cause.
- An object `idempotencyKey` is not scoped by the action name, so a renamed step reuses the old result. Put the step tag in the object (`{ step: tag, input }`).
- Sealed-host file flows: BusyBox `find` never runs `-exec … {} +` inside `\( … \)` (chain at top level), the `proc:spawn` capability resource is the rendered command and is capped at 4096 characters (send long programs on stdin), and file flows bind only with an absolute `SMITHERS_TEST_CWD`.
- A module loaded twice under different tsx namespaces has two copies of its module state, so identity-keyed `WeakMap`s miss silently. Probe with a load counter.
- ChatGPT-backend prompt caching needs both the `prompt_cache_key` body field and the `session-id` header, or later frames cache 0%. It caches in 1024-token blocks, so small runs top out near 80 to 90% with no client defect.
- Jev answers from its instructions and state only and never reads a question's id. `Classifier.make` callers name the item in every instruction; a shared instruction reads the same for each item. Judged reviews need `AI_GATEWAY_API_KEY`; a missing key fails typed rather than falling back.

## UI packages and sites

- A new heavy renderer gets its own package imported from its root, like `@smthrs/repo-view` and `@smthrs/terminal-frame` (rulings SDK-13), never a `@smthrs/ui` dependency or an `./adapters/*` subpath.
- `@pierre/diffs` `File` emits `onPostRender` on mount, highlight and theme changes, not when only `selectedLines` changes: key the frame on the anchor to rerun scroll-to-line. With a cold shared highlighter it paints nothing until grammar and theme load, so a plain-first state needs its own `<pre>`; the highlighter is process-global, so `disposeHighlighter()` races other suites in one bun process.
- The SMITHERS ASCII wordmark has hand-kept copies in `packages/smithers/ui/src/wordmark/Wordmark.tsx` and `apps/site/scripts/generate-project-copy.mjs`. Edit both and diff them.
- Lengthening the widest row of `apps/tui/README.md`'s key table makes dprint re-pad about 45 rows; stay within the current width.
- Site recordings (`apps/site/tapes`): a vhs `Type` string can't contain `\"`, so use backtick strings; `Output` resolves from vhs's cwd, not the tape. The CLI's `--quiet` also swallows stdout JSON, and a Markdown flow needs `proc:spawn:git *`, because `proc:spawn:git` matches only the bare word.
