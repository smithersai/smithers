---
title: "Target catalog"
description: "Every target in @smthrs/targets, one page each, with attribute tables, declared inputs, channels, and execution status."
---

Every target in `@smthrs/targets`. Each page lists the target's attributes, its
declared inputs, its success and error channels, and whether it executes today.

Import a target by name from the package root:

```ts
import { Smithers } from "@smthrs/targets"
```

## Execution status

The CLI executor supplies the shared exec, generated-file write/check,
documentation-parity, filegroup, LLM-review,
package-manifest, output-capture, scaffold, install, and irreversible-exec
implementations. `NpmPublish` and `JsrPublish` are `run`-only roots with a verb
gate that also rejects dependency inclusion under other verbs. Their resolved
`dryRun` attribute defaults to `true`, appending `--dry-run`; `dryRun: false`
allows real publication. `--plan` never executes.

`Changesets.Version` applies versioning under `run` and checks it under `lint`.
`Changesets.Publish` is a separate `run`-only target whose outward-action gate
currently refuses publication. See [Changesets](changesets.md).

**Cacheable** is the target's own declaration. Under a declared
[Nix environment](../../concepts/environments.md) the planner overrides `Never`
for the external-tool targets whose only missing key material was the
toolchain: TsBuild, DtsBuild, Typecheck, Vitest, VitestCoverage, NodeTest,
EsLint, BiomeCheck, DepsLint, PackageLint, CargoTest, and CargoLint.

**Executes** means the target's plan runs through its declared CLI verb, either
as a root or as a dependency. **Plans only** means the target is
planned, queried, and graphed normally, but executing it fails on a missing
action implementation. No catalog target ends in `NotImplemented`; that machinery
exists for future additions and is unused. See
[Running targets](../../workspace/running-targets.md#what-executes).

## Build

| Target                         | Kinds   | Cacheable    | Status   | Summary                                                                        |
| ------------------------------ | ------- | ------------ | -------- | ------------------------------------------------------------------------------ |
| [TsBuild](ts-build.md)         | `build` | Never        | Executes | Builds a JavaScript distribution with `tsc -p` or `tsup`.                      |
| [DtsBuild](dts-build.md)       | `build` | Never        | Executes | Emits type declarations with `tsc --emitDeclarationOnly` or `tsup --dts-only`. |
| [Typecheck](typecheck.md)      | `build` | Never        | Executes | Checks a package with `tsc --noEmit` or TypeScript build mode.                 |
| [ToolBuild](tool-build.md)     | `build` | `cache` attr | Executes | Runs an arbitrary command for a non-TypeScript toolchain.                      |
| [TypedocDocs](typedoc-docs.md) | `build` | Never        | Executes | Generates API documentation with TypeDoc.                                      |
| [NodeBinary](node-binary.md)   | `build` | Never        | Executes | Runs one JavaScript program under the declared runtime, for its files.         |

## Test

| Target                               | Kinds  | Cacheable | Status   | Summary                                                     |
| ------------------------------------ | ------ | --------- | -------- | ----------------------------------------------------------- |
| [Vitest](vitest.md)                  | `test` | Never     | Executes | Runs `vitest run` over a declared test set.                 |
| [VitestCoverage](vitest-coverage.md) | `test` | Never     | Executes | Runs `vitest run` with coverage and thresholds.             |
| [VitestWatch](vitest-watch.md)       | `run`  | Never     | Executes | Runs an interactive `vitest watch` session.                 |
| [NodeTest](node-test.md)             | `test` | Never     | Executes | Runs one JavaScript program whose exit code is the verdict. |
| [CargoTest](cargo.md)                | `test` | Never     | Executes | Runs `cargo test` under the declared Rust toolchain.        |

## Lint

| Target                         | Kinds  | Cacheable | Status   | Summary                                                                               |
| ------------------------------ | ------ | --------- | -------- | ------------------------------------------------------------------------------------- |
| [EsLint](es-lint.md)           | `lint` | Never     | Executes | Runs ESLint over declared source sets with a flat config.                             |
| [BiomeCheck](biome-check.md)   | `lint` | Never     | Executes | Runs `biome check` and `biome format` without writing files.                          |
| [Dprint](dprint.md)            | `lint` | Never     | Executes | Checks formatting with `dprint check`, or rewrites it with `dprint fmt`.              |
| [DepsLint](deps-lint.md)       | `lint` | Never     | Executes | Checks dependency declarations with knip or depcheck.                                 |
| [PackageLint](package-lint.md) | `lint` | Never     | Executes | Checks the published package surface with publint and attw.                           |
| [LlmLint](llm-lint.md)         | `lint` | Never     | Executes | Reviews changed files with a model against a rubric, through the claude or codex CLI. |
| [CargoLint](cargo.md)          | `lint` | Never     | Executes | Runs `cargo fmt --check` or `cargo clippy` under the declared Rust toolchain.         |

## Generation

| Target                                    | Kinds           | Cacheable              | Status                  | Summary                                                                      |
| ----------------------------------------- | --------------- | ---------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| [SortPackageJson](sort-package-json.md)   | `build`, `lint` | Never                  | Executes                | Validates or rewrites `package.json` key ordering.                           |
| [PackageJson](package-json-gen.md)        | `lint` / `run`  | Check only             | Executes                | Expands a typed manifest declaration into check, write, and refresh targets. |
| [GithubCiGen](github-ci-gen.md)           | `build`, `lint` | Effective `check` mode | Executes                | Generates the GitHub Actions CI workflow from declared jobs and targets.     |
| [Owners.Codeowners](owners-codeowners.md) | `build`, `lint` | Never                  | Executes (build system) | Generates `.github/CODEOWNERS` from every package's `owners` declaration.    |
| [Owners.Tree](owners-tree.md)             | `build`, `lint` | Never                  | Executes (build system) | Generates the per-directory `OWNERS` tree in the landing-gate format.        |

## Documentation

| Target                       | Kinds  | Cacheable | Status   | Summary                                                |
| ---------------------------- | ------ | --------- | -------- | ------------------------------------------------------ |
| [DocsParity](docs-parity.md) | `docs` | Always    | Executes | Requires a substantive README beside a package's code. |
| [Markdown.CodeBlocks](markdown-code-blocks.md) | `build`, `test` | Always | Executes | Compiles a page's fenced code blocks; `title=` fences concatenate into files, `fragment` fences are skipped. |

`PackageJson` uses separate targets for checking and source-tree writes.
`GithubCiGen` maps its `lint` verb to the drift-check form. See [Verb-effective attrs](../../concepts/targets.md#verb-effective-attrs).

## Install, release, and processes

| Target                             | Kinds | Cacheable | Status                        | Summary                                                               |
| ---------------------------------- | ----- | --------- | ----------------------------- | --------------------------------------------------------------------- |
| [PnpmWorkspace](pnpm-workspace.md) | `run` | Never     | Executes                      | Runs the smithers-build install flow for a pnpm workspace.            |
| [NewPackage](new-package.md)       | `run` | Never     | Executes                      | Scaffolds one package named with the invocation's `--name` option.    |
| [Changesets.Version](changesets.md) | `run`, `lint` | Check only | Executes | Applies versioning or checks for drift. |
| [Changesets.Publish](changesets.md) | `run` | Never | Refuses at outward gate | Declares a release train publication; transport is not implemented. |
| [NpmPublish](npm-publish.md)       | `run` | Never     | Executes (dry-run by default) | Publishes a package to an npm registry.                               |
| [JsrPublish](jsr-publish.md)       | `run` | Never     | Executes (dry-run by default) | Publishes a package to JSR.                                           |
| [Clean](clean.md)                  | `run` | Never     | Executes                      | Deletes explicitly declared generated paths.                          |
| [Dev](dev.md)                      | `run` | Never     | Executes                      | Runs a long-lived development or watch command.                       |
| [ToolRun](tool-run.md)             | `run` | Never     | Executes                      | Runs one arbitrary external command for its irreversible side effect. |

## File sets

| Target                    | Kinds | Cacheable | Status                   | Summary                                                       |
| ------------------------- | ----- | --------- | ------------------------ | ------------------------------------------------------------- |
| [Filegroup](filegroup.md) | none  | Always    | Executes as a dependency | Names a set of files under one label, composing transitively. |

A group joins no verb, so it is never selected as a root and never performs work
under `build`, `test`, or `lint`. It is still addressable by label, listed by
`query`, and traversed by `deps(...)`.

## Macros

| Name                                                                     | Summary                                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [buildAndCheckPackage](standard-package.md)                                   | Expands one conventional TypeScript package into `lib`, `test`, and `lint`. |
| [PackageJsonTemplate](package-json-gen.md#templates-and-merge-semantics) | Holds inert workspace-wide manifest defaults.                               |

## Authoring surface

These modules are not targets. They are documented elsewhere.

| Module            | Documented in                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `Target`          | [Writing target definitions](../../extending/writing-targets.md), [Target definitions and targets](../../concepts/targets.md) |
| `Input`           | [Inputs](../../concepts/inputs.md)                                                                      |
| `Exec`            | [Actions and boundaries](../../concepts/actions-and-boundaries.md)                                      |
| `Workspace`       | [Workspace reference](../config.md)                                                                     |
| `PackageDefaults` | [Default targets](../../extending/default-rules.md)                                                     |

## Conventions shared by every tool-running target

- **`cwd`** is the workspace-relative directory the tool starts in. It defaults
  to `"."`, the workspace root. Package-level targets pass their own directory.
  [Dev](dev.md) declares `cwd` without a default, so it is required there.
  [Changesets](changesets.md), [NpmPublish](npm-publish.md),
  [JsrPublish](jsr-publish.md), and [PnpmWorkspace](pnpm-workspace.md) declare
  no `cwd` at all. `Changesets` runs at the workspace root, the publish targets
  run in the directory of their declared manifest, and `PnpmWorkspace` generates its file at the
  workspace root.
- **Tools resolve through `PackageManager.exec`** of the declared package
  manager, so the manager is declared key material rather than a hardcoded
  constant. `ToolBuild`, `Dev`, and the runtime-evaluated helper steps are the
  exceptions.
- **Paths in attrs resolve from `cwd` when the tool runs**, and from the
  declaring package when the planner digests them. A `//`-prefixed path resolves
  from the workspace root in both cases.
- **Success is `Exec.Result`**, `{exitCode, stdout, stderr}`, unless
  the target declares something richer. Producing build targets use `Outputs`.
- **Errors are `Exec.ExecError`**, `{argv, cwd, exitCode, stderr}`, with
  `exitCode: -1` when the spawn itself failed.
