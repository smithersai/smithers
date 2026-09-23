---
title: "PackageJson"
description: "Declares package.json in PACKAGE.ts and expands it into separate check, write, and model-refresh targets."
---

Examples importing `buildAndCheckPackage` use the [local helper defined here](standard-package.md). Create that file in your repository before using those examples.


Declares `package.json` in `PACKAGE.ts` and expands it into separate check, write,
and LLM-refresh targets.

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

export const template = Smithers.PackageJsonTemplate.make({
  license: "MIT",
  author: "Smithers",
  engines: { node: ">=26.4.0" },
  scripts: Smithers.PackageJsonTemplate.standardScripts
})

const standard = buildAndCheckPackage({ packageManager, cwd: "packages/widget" })

export const packageJson = Smithers.PackageJson({
  name: "@smthrs/widget",
  version: "0.1.0",
  template,
  description: Smithers.generated,
  keywords: Smithers.generated,
  scripts: { build: standard.lib, lint: standard.lint },
  publish: { entry: standard.lib }
})
```

The declaration above becomes `packageJsonCheck`, `packageJsonWrite`, and
`packageJsonRefresh`. A declaration named `manifest` would similarly become
`manifestCheck`, `manifestWrite`, and `manifestRefresh`.

## Declared fields

- `name` is required and validated as a lowercase npm package name.
- `version` is required and is a literal string for now. Version sourcing will
  become configurable separately.
- `license` is a common SPDX literal and defaults to `MIT`.
- `description` and `keywords` accept literals or `generated`.
- `scripts` maps script names to imported target objects. During workspace
  analysis, each target must resolve to a graph label and support `build`,
  `test`, `lint`, or `run`. The resulting command is
  `smithers-build <verb> <label>`.
- `publish.entry` names a build target. Its declared `entries`, `outDir`, and
  `format` derive `exports`, `main`, `module`, `types`, `files`, and
  `publishConfig`. Missing or unsupported output declarations fail analysis
  instead of producing guessed paths.
- `fields` passes through fields not modeled yet. Dependency and package-manager
  fields are rejected because the package manager owns them and they remain in
  the checked-in manifest.

## Templates and merge semantics

`PackageJsonTemplate.make` is an inert root `PACKAGE.ts` declaration for shared
fields such as license, author, engines, and the standard `test` and
`test:coverage` scripts. The package is deep-merged over the template:

- package values win;
- plain objects merge recursively, so scripts merge per key;
- arrays and scalar values replace wholesale;
- output follows the canonical package key order, with script names sorted by
  UTF-16 code unit.

## Sync targets

| Target suffix | Kind   | Cacheable | Effect                                                           |
| ------------- | ------ | --------- | ---------------------------------------------------------------- |
| `Check`       | `lint` | Yes       | Regenerates in memory and fails with a field-level drift report. |
| `Write`       | `run`  | No        | Rewrites the checked-in manifest.                                |
| `Refresh`     | `run`  | No        | Refreshes generated prose, caches it, and rewrites the manifest. |

The check target declares the checked-in manifest as an input. CI therefore
runs a cacheable, non-mutating comparison. Write and refresh are explicit
source-tree mutations and can never return a cache hit.

## Generated description and keywords

Generated values are keyed by a digest of the prompt version, README contents,
and source-file listing. A cached answer remains valid indefinitely; elapsed
time never refreshes it. Run the explicit refresh target to ask the configured
model again:

```sh
smithers-build run //packages/widget:packageJsonRefresh
```

Check and write never call a model. If no cached answer exists, they retain the
checked-in field. A cold CI checkout therefore remains offline and optimistic.

## Scaffolding

The root workspace exports `//:newPackage`:

```sh
smithers-build run //:newPackage --name @smthrs/widget
```

It creates `packages/widget/package.json`, `tsconfig.json`, `README.md`,
`src/index.ts`, and a test stub. It refuses an existing directory and writes no
`PACKAGE.ts`; the root `PackageDefaults` synthesizes the standard build, test, lint,
docs, and PackageJson targets.

## Publication and lint coherence

Generated manifests use the ordering expected by `SortPackageJson`, preserve
manager-owned dependency blocks, and derive the same publish access and
provenance consumed by `NpmPublish`. `PackageLint` validates the emitted
package surface. `JsrPublish` remains driven by its own JSR config and may share
the same build dependencies.

## See also

- [SortPackageJson](sort-package-json.md)
- [PackageLint](package-lint.md)
- [NpmPublish](npm-publish.md)
- [Default targets](../../extending/default-rules.md)
