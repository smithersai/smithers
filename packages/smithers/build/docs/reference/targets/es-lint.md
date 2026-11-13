---
title: "EsLint"
description: "Runs ESLint over declared source sets with a flat config."
---

Runs ESLint over declared source sets with a flat config.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const lint = Smithers.EsLint({
  packageManager,
  sources: [Smithers.glob("src/**/*.ts")],
  deps: [],
  configs: [Smithers.file("eslint.config.js"), Smithers.file("//eslint.jsdoc.js")],
  maxWarnings: 0,
  fix: false,
  cwd: "packages/greeter"
})

export const Package = Smithers.Package({
  targets: { lint }
})
```

## Attributes

| Name             | Type                            | Default  | Description                                                                                              |
| ---------------- | ------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `packageManager` | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material.               |
| `sources`        | `Array<Input.Declared>`         | required | What to lint. Globs pass through to ESLint as patterns.                                                  |
| `deps`           | `Array<Target.Target>`          | required | Dependency targets. Usually empty: linting sources needs nothing built.                                  |
| `configs`        | `Array<Input.File>`             | required | Flat configs. The first is passed as `--config`; the rest are key material for files the config imports. |
| `maxWarnings`    | `number`                        | required | The warning budget, passed as `--max-warnings`.                                                          |
| `fix`            | `boolean`                       | required | Apply autofixes. The target remains non-cacheable in either mode.                                        |
| `cwd`            | `string`                        | `"."`    | Workspace-relative directory the tool runs in.                                                           |

## Command

The argv is `PackageManager.exec` of the declared package manager. With the
pnpm declaration:

```text
pnpm exec eslint [--config <configs[0].path>] --max-warnings <maxWarnings> [--fix] <patterns...>
```

ESLint expands glob patterns itself, so the source declarations reduce to
arguments as follows:

| Declaration | Contributes            |
| ----------- | ---------------------- |
| `Glob`      | its `pattern` verbatim |
| `File`      | its `path`             |
| `GitDiff`   | nothing                |

## Inputs

Collected from the attrs: every declaration in `sources`, plus every entry in
`configs`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------- |
| Kinds     | `lint`                                                                                          |
| Cacheable | Never |
| Executes  | Yes, through `ExecLive`                                                                         |

## Notes

`buildAndCheckPackage` lints the source glob only, not tests. Its flat config declares
no coverage for test files, and ESLint 9 fails on a pattern whose matches are all
unconfigured. A package whose config does cover tests can pass both globs, as
`packages/greeter/PACKAGE.ts` does.

## See also

- [BiomeCheck](biome-check.md) for the Biome equivalent
- [buildAndCheckPackage](standard-package.md), which emits an `EsLint` `lint` target
