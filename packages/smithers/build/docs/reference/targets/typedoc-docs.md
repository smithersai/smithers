---
title: "TypedocDocs"
description: "Generates API documentation with TypeDoc."
---

Generates API documentation with TypeDoc.

```ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

const docs = Smithers.TypedocDocs({
  packageManager,
  sources: [Smithers.glob("src/**/*.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  config: Smithers.file("//typedoc.json"),
  entryPoints: [Smithers.file("src/index.ts")],
  outDir: "docs/api",
  plugin: ["typedoc-plugin-markdown"],
  cwd: "packages/greeter"
})

export const Package = Smithers.Package({
  targets: { docs }
})
```

## Attributes

| Name             | Type                            | Default  | Description                                                                                |
| ---------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `packageManager` | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material. |
| `sources`        | `Array<Input.Declared>`         | required | Source declarations digested as key material.                                              |
| `deps`           | `Array<Target.Target>`          | required | Dependency targets.                                                                        |
| `tsconfig`       | `Input.File`                    | required | The tsconfig TypeDoc reads, passed as `--tsconfig`.                                        |
| `config`         | `Input.File \| null`            | required | A TypeDoc options file passed as `--options`, or `null`.                                   |
| `entryPoints`    | `Array<Input.File>`             | required | Entry point declarations passed as positional arguments.                                   |
| `outDir`         | `string`                        | required | Output directory passed as `--out`.                                                        |
| `plugin`         | `Array<string>`                 | required | Plugin package names, each passed as `--plugin`.                                           |
| `cwd`            | `string`                        | `"."`    | Workspace-relative directory the runner starts in and output capture reads from.           |

## Command

The argv is `PackageManager.exec` of the declared package manager. With the
pnpm declaration:

```text
pnpm exec typedoc --out <outDir> --tsconfig <tsconfig.path> \
  [--options <config.path>] [--plugin <name>]... <entryPoints...>
```

The run starts in `cwd`. Package-relative input paths stay relative to that
directory; workspace-rooted `//` inputs are rendered relative to `cwd`.
`outDir` is a relative output directory under `cwd`; it cannot use `//`.

## Inputs

Collected from the attrs: every declaration in `sources`, `tsconfig`, every
`entryPoints` declaration, and `config` when it is not `null`.

## Outputs

The output-capture action requires `outDir` to exist under `cwd` and records
its deterministic digest. A successful TypeDoc exit alone is insufficient.

## Channels

| Channel | Type                   |
| ------- | ---------------------- |
| Success | `ToolBuild.Outputs`    |
| Error   | `ToolBuild.BuildError` |

## Status

|           |                                                             |
| --------- | ----------------------------------------------------------- |
| Kinds     | `build`                                                     |
| Cacheable | Never; generated output restoration is not wired            |
| Executes  | Yes, through exec and output-capture action implementations |

## See also

- [TsBuild](ts-build.md)
- [ToolBuild](tool-build.md)
