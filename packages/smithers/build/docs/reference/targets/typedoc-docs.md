---
title: "TypedocDocs"
description: "Generates API documentation with TypeDoc."
---

Generates API documentation with TypeDoc.

```ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=26.4.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

const docs = Smithers.TypedocDocs({
  packageManager,
  sources: [Smithers.glob("packages/*/src/**/*.ts")],
  deps: [],
  tsconfig: Smithers.file("//tsconfig.json"),
  config: Smithers.file("//typedoc.json"),
  entryPoints: [Smithers.file("//packages/greeter/src/index.ts")],
  outDir: "//docs/api",
  plugin: ["typedoc-plugin-markdown"]
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

There is no `cwd` attribute. The run always happens at the workspace root.

## Command

The argv is `PackageManager.exec` of the declared package manager. With the
pnpm declaration:

```text
pnpm exec typedoc --out <outDir> --tsconfig <tsconfig.path> \
  [--options <config.path>] [--plugin <name>]... <entryPoints...>
```

Because the run happens at the workspace root, a leading `//` is stripped from
`outDir`, `tsconfig.path`, `config.path`, and every entry point before it reaches
argv. Write workspace-rooted paths and they resolve correctly.

## Inputs

Collected from the attrs: every declaration in `sources`, plus `tsconfig`, plus
`config` when it is not `null`.

## Outputs

None captured. The target declares no output paths, so success carries only the run
summary. `outDir` is key material and a command-line argument.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                                  |
| --------- | ------------------------------------------------ |
| Kinds     | `build`                                          |
| Cacheable | Never; generated output restoration is not wired |
| Executes  | Yes, through `ExecLive`                          |

## See also

- [TsBuild](ts-build.md)
- [ToolBuild](tool-build.md)
