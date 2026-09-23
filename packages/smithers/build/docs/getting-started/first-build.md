---
title: "First build"
description: "Write a workspace declaration and one PACKAGE.ts, then run query, graph, plan, build, test, lint, ci, and install against them."
sidebar:
  order: 2
---

Examples importing `buildAndCheckPackage` use the [local helper defined here](../reference/targets/standard-package.md). Create that file in your repository before using those examples.

This tutorial writes a workspace declaration and one package, then runs the core
query, graph, build, test, lint, CI, and install paths. It assumes the layout
from [Install](install.md).

## 1. Declare the workspace

The workspace declaration names the repository, the cache directory, and the
toolchain every target runs against. It lives in `.smithers/WORKSPACE.ts`, and
it exports exactly one value named `Workspace`.

```ts
// .smithers/WORKSPACE.ts
import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")

export const runtime = S.Runtime.Node({ version: ">=26.4.0" })
export const packageManager = S.PackageManager.Pnpm({ version: "11.21.0", runtime })

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager,
  nodeModules: S.Npm.NodeModules({ packageJson })
})
```

A workspace whose tools come from a Nix closure declares that instead of, or
beside, the Node trio. See [Environments](../concepts/environments.md).

```ts
export const environment = S.Nix.Environment({ flake: S.file("//flake.nix") })
```

Nothing runs when the module is evaluated. Every declaration is inert data, and
every tool-running target resolves the runtime and the package manager from this
file at plan time, so switching either is one edit here.

## 2. Declare a package

A `PACKAGE.ts` exports one value named `Package`, whose `targets` map is what
gives each target its label. `buildAndCheckPackage` expands one conventional
TypeScript package into that map:

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
// packages/greeter/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = buildAndCheckPackage({
  deps: [],
  cwd: "packages/greeter"
})

export const Package = S.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
```

`cwd` is the workspace-relative directory every emitted tool runs in. The
macro's defaults follow one conventional layout: sources at `src/**/*.ts`, tests
at `test/**/*.test.ts`, `tsc -p tsconfig.json`, Vitest with the package's
`vitest.config.ts`, and ESLint with the package's `eslint.config.js`.

The map keys are the target names, so the labels are `//packages/greeter:lib`,
`//packages/greeter:check`, `//packages/greeter:test`, and one per remaining
key. A target left out of the map has no label and is not addressable: omission
is the only privacy mechanism.

## 3. Add an edge

Import another package's `Package` value and take the target off it.

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
// packages/app/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"
import { Package as greeter } from "../greeter/PACKAGE.ts"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = buildAndCheckPackage({
  deps: [greeter.lib],
  cwd: "packages/app"
})

export const Package = S.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
```

`//packages/app:lib` now depends on `//packages/greeter:lib`. No label string
appears anywhere. See [Dependencies](../concepts/dependencies.md).

## 4. List targets

```sh
smithers-build query //...
```

The result lists each discovered target with the definition it came from and
the verbs it participates in:

```text
query: //...
targets:
  - label: //packages/app:lib
    target: TsBuild
    kinds: [build]
  - label: //packages/greeter:lib
    target: TsBuild
    kinds: [build]
  ...
```

Output is [TOON](https://github.com/toon-format/toon) by default. Add `--json`
for JSON.

## 5. Inspect the graph

```sh
smithers-build graph //packages/app:lib
```

```text
//packages/app:lib (TsBuild)
└─ //packages/greeter:lib (TsBuild)
```

`--mermaid` renders the same graph as a Mermaid `flowchart LR`.

## 6. Print a plan without running it

```sh
smithers-build build //... --plan
```

The plan lists targets in dependency-first order with the expanded declared
inputs, the four key-material fields, and the sha256 content key. Nothing runs.

## 7. Execute

```sh
smithers-build build //...
smithers-build test //packages/greeter:test
smithers-build lint //packages/...
```

Each verb selects the targets whose definition declares that kind, plans their
transitive dependency closure, and executes it in dependency order with bounded
parallelism. One status line per target goes to standard error:

```text
//packages/greeter:lib  ran  1.4s
//packages/app:lib  ran  0.9s
2 targets: 0 hit, 2 ran, 0 failed, 0 skipped (2.3s)
```

Run it again and the cacheable targets report `hit`.

`ci` merges the build, test, and lint plans over one pattern and executes the
merged graph once:

```sh
smithers-build ci //...
```

## 8. Install dependencies

```sh
smithers-build install --workspace .
```

This runs the `Install` flow under the declared package manager's layer:
measure, fetch into `.flows/store/<manager>`, then reconcile `node_modules`.
Only pnpm has a live implementation today; the other managers fail with a typed
`unsupported` error. Install requires the default `.flows` cache-directory
setting and is not answered from the cross-run engine cache. See
[Install](../concepts/install.md).

## Next

- [Writing build files](../workspace/writing-build-files.md)
- [Running targets](../workspace/running-targets.md)
- [CLI reference](../reference/cli.md)
