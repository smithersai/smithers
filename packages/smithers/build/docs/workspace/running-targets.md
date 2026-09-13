---
title: "Running targets"
description: "How a verb selects targets, plans their dependency closure, and executes it, and what each verb covers."
---

A verb selects targets, plans their transitive dependency closure, and executes
it. Targets carry no per-command shell scripts.

```sh
smithers-build install --workspace .
smithers-build build //packages/...
smithers-build test //packages/greeter:test
smithers-build lint //packages/greeter:lint
smithers-build docs //...
smithers-build run //:newPackage --name @scope/widget
smithers-build ci //...
```

For every flag, output field, and exit code, see
[the CLI reference](../reference/cli.md).

## Verb selection

Each target declares its `kinds`. A verb selects matching roots and always adds
their dependencies, regardless of the dependencies' own kinds.

| Verb      | Root selection                            | Executes             |
| --------- | ----------------------------------------- | -------------------- |
| `build`   | kind includes `build`                     | Yes, unless `--plan` |
| `test`    | kind includes `test`                      | Yes, unless `--plan` |
| `lint`    | kind includes `lint`                      | Yes, unless `--plan` |
| `docs`    | kind includes `docs`                      | Yes, unless `--plan` |
| `run`     | kind includes `run`                       | Yes, unless `--plan` |
| `ci`      | lint, build, test, and docs plans, merged | Yes, unless `--plan` |
| `install` | the `Install` flow, not a label pattern   | Yes                  |
| `query`   | every target the expression matches       | No                   |
| `graph`   | every target the pattern matches          | No                   |

An exact label that does not participate in the requested verb fails with
`target selected by <pattern> does not support the <verb> verb`. A recursive
pattern that selects nothing for one verb returns an empty graph. `ci` tolerates
a per-kind refusal as long as at least one of lint, build, test, or docs accepts the
pattern.

`run` is intentionally outside `ci`: it selects operational targets such as
cleaning, watch processes, source generation, and release actions. `ci` includes
`docs` checks but plans with `unattended: true`, which excludes agent-backed
writers such as [Docs.Page](../reference/targets/docs-page.md). The `docs` verb
can run those writers directly.

## What executes

The executor gives each target its own in-memory runtime and provides:

- pnpm install actions;
- process execution and output capture;
- filegroup expansion and declared-output verification;
- generated-file writes/checks and package-manifest synchronization;
- GitHub workflow and documentation checks;
- LLM review and package scaffolding.

The runtime also supplies `ExecIrreversibleLive`. `NpmPublish` and `JsrPublish`
are selected only by `run`; their verb gate also rejects dependency inclusion
under other verbs. Both default the resolved `dryRun` attribute to `true`,
which appends `--dry-run`. With `dryRun: false`, execution can publish to the
registry. `--plan` remains non-executing.

| Target                                                         | Root verb       | Executes today                                                     |
| -------------------------------------------------------------- | --------------- | ------------------------------------------------------------------ |
| `TsBuild`, `DtsBuild`, `Typecheck`, `ToolBuild`, `TypedocDocs` | `build`         | Yes                                                                |
| `Vitest`, `VitestCoverage`                                     | `test`          | Yes                                                                |
| `EsLint`, `BiomeCheck`, `DepsLint`, `PackageLint`              | `lint`          | Yes                                                                |
| `LlmLint`                                                      | `review`        | Yes; skips where the engine CLI is absent                          |
| `SortPackageJson`                                              | `build`, `lint` | Yes                                                                |
| `PackageJsonCheck`                                             | `lint`          | Yes                                                                |
| `PackageJsonWrite`, `PackageJsonRefresh`                       | `run`           | Yes; mutates the source manifest                                   |
| `GithubCiGen`                                                  | `build`, `lint` | Yes; CI selects its checking form                                  |
| `DocsParity`                                                   | `docs`          | Yes                                                                |
| `NewPackage`                                                   | `run`           | Yes; requires `--name` and creates a package                       |
| `PnpmWorkspace`                                                | `run`           | Yes                                                                |
| `Clean`, `Dev`, `VitestWatch`                                  | `run`           | Yes; the watch processes hold their execution slot                 |
| `Changesets.Version`                                           | `run`, `lint`   | Yes; `run` writes, `lint` checks in a scratch copy                 |
| `Changesets.Publish`                                           | `run`           | Refuses at the outward-action gate; publication is not implemented |
| `NpmPublish`, `JsrPublish`                                     | `run`           | Yes; `--dry-run` by default, real publication with `dryRun: false` |

An `LlmLint` target now runs through `LlmReviewLive`; it is no longer a
plan-only declaration. It is the only target under the `review` verb, and it is
gated to it: `lint`, `build`, `test`, `docs`, and the aggregate `ci` never plan
one, over any pattern or through any dependency edge. A review expands its
`changes` git diff at PLAN time and then calls a model, so an unattended run on
a checkout without the base revision would fail the whole plan, and one without
the engine binary could not run at all. Ask for them by name
(`smithers-build review '//...'`); a host with no engine CLI reports the target
skipped, with a notice naming the executable, and stays green. Release
mutations remain separately gated.

## Verb-effective attributes

A target that declares several kinds may execute a different form under each one.
`GithubCiGen` maps `lint` to drift checking. Package manifests use distinct
check, write, and refresh targets.

The planner resolves attributes, declared inputs, cacheability, and therefore
content keys per verb. `ci` plans lint first, then build, test, and docs, and
keeps the first occurrence when merging by label. A generator shared by build and lint
therefore contributes its non-mutating check form to CI.

See [Verb-effective attrs](../concepts/targets.md#verb-effective-attrs).

## Execution semantics

- **Order and concurrency.** Dependencies precede dependents. At most `--jobs`
  targets run at once; the default is host available parallelism. Invalid job
  counts are refused.
- **Keep going.** A failed target blocks only its dependent cone. Unrelated
  targets continue. An internal scheduler fault stops new dispatch and waits
  for work already in flight.
- **Cache.** A cacheable target consults its content key. A validated green hit
  skips execution; a validated green run is stored. `--no-cache` bypasses reads
  and still writes.
- **Input stability.** Declared inputs are re-expanded before cache admission
  and after execution. A changed path set or digest fails the target under the
  original plan rather than publishing stale work.
- **Output integrity.** Declared outputs must exist and match the returned
  manifest before either a run or a cache hit is reported green.
- **Working directory.** The process-wide `cwd` is never changed. Every action
  resolves and validates its own directory under the canonical workspace root.
- **Runtime isolation.** Each target gets a fresh runtime because targets made
  from one target share a flow tag.

## Output

One line per settled target goes to standard error, followed by a summary:

```text
//packages/greeter:lib  hit  2ms
//packages/app:lib  ran  3.1s
//packages/app:test  failed  0.4s  {"_tag":"smithers-build/ExecError", ...}
//packages/app:lib  skipped  0ms  dependency //packages/app:test did not succeed
4 targets: 1 hit, 1 ran, 1 failed, 1 skipped (3.6s)
```

The structured result on standard output reports the verb, pattern, jobs,
duration, counts, verdict, and one report per target.

## Planning only

`--plan` prints the inert dependency-first plan, expanded declared inputs, key
material, and SHA-256 content key without executing. `query` and `graph` are
always non-executing.

```sh
smithers-build build //... --plan
smithers-build docs //... --plan
smithers-build run //:clean --plan
smithers-build ci //... --plan
```

The planner does not consult the cache, so its `cacheLookup` remains
`"not-wired"` and `wouldRun` remains `true`; the executor performs the real
lookup.

## Installing dependencies

`smithers-build install` takes no label. It executes the one-round install flow
under the pnpm layer and returns the canonical workspace, manager, recorded
nodes, and link manifest.

The declared store is fixed at `.flows/store/pnpm`. If `--cache-dir` or the
root `Workspace` declaration selects another directory, install refuses rather
than declaring one path and writing another. Other verbs support custom cache
directories.

See [Install](../concepts/install.md).

## Next

- [Querying](querying.md)
- [Caching](caching.md)
- [CLI reference](../reference/cli.md)
