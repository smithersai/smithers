---
title: "BiomeCheck"
description: "Runs Biome lint and format checks over a declared source set without writing files."
---

Runs Biome lint and format checks without writing files.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const lint = Smithers.BiomeCheck({
  packageManager,
  sources: [Smithers.glob("src/**/*.ts")],
  deps: [],
  config: Smithers.file("biome.json"),
  lint: true,
  format: true,
  cwd: "packages/greeter"
})

export const Package = Smithers.Package({
  targets: { lint }
})
```

## Attributes

| Name             | Type                            | Default  | Description                                                                                |
| ---------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `packageManager` | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material. |
| `sources`        | `Array<Input.Declared>`         | required | What to check. Reduced to path arguments; see below.                                       |
| `deps`           | `Array<Target.Target>`          | required | Dependency targets.                                                                        |
| `config`         | `Input.File`                    | required | The Biome configuration, passed as `--config-path`.                                        |
| `lint`           | `boolean`                       | required | Run `biome check`.                                                                         |
| `format`         | `boolean`                       | required | Run `biome format` in its default check mode.                                              |
| `cwd`            | `string`                        | `"."`    | Workspace-relative directory the tool runs in.                                             |

## Commands

Up to two runs, both from `cwd`. The argvs are `PackageManager.exec` of the
declared package manager. With the pnpm declaration:

```text
pnpm exec biome check --config-path=<config.path> <paths...>
pnpm exec biome format --config-path=<config.path> <paths...>
```

A disabled family contributes `null` to the result instead of a run.

Biome walks paths itself and does not expand glob patterns, so the source
declarations reduce to path arguments as follows:

| Declaration | Contributes                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `Glob`      | its static directory prefix, the leading segments before the first glob metacharacter, or `.` when there is none |
| `File`      | its `path`                                                                                                       |
| `GitDiff`   | nothing                                                                                                          |

Duplicates are removed. With no usable source, Biome checks `.`.

## Inputs

Collected from the attrs: every declaration in `sources`, plus `config`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `BiomeReport`    |
| Error   | `Exec.ExecError` |

```ts
BiomeReport = { check: Exec.Result | null, format: Exec.Result | null }
```

## Status

|           |                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------- |
| Kinds     | `lint`                                                                                          |
| Cacheable | Under a declared Nix environment; never otherwise, the executable toolchain is not key material |
| Executes  | Yes, through `ExecLive`                                                                         |

## See also

- [EsLint](es-lint.md) for the ESLint equivalent
- [SortPackageJson](sort-package-json.md)
