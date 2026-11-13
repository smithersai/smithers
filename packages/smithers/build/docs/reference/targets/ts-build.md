---
title: "TsBuild"
description: "Builds a JavaScript distribution for a TypeScript package with tsc -p or tsup."
---

Builds a JavaScript distribution for a TypeScript package with `tsc -p` or
`tsup`.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const lib = Smithers.TsBuild({
  packageManager,
  srcs: [Smithers.glob("src/**/*.ts")],
  entries: [Smithers.file("src/index.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  tool: { name: "tsc" },
  format: "dual",
  outDir: "dist",
  cwd: "packages/greeter"
})

export const Package = Smithers.Package({
  targets: { lib }
})
```

## Attributes

| Name             | Type                            | Default  | Description                                                                                                                                                         |
| ---------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packageManager` | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material.                                                                          |
| `srcs`           | `Array<Input.Declared>`         | required | Source declarations. Digested as key material.                                                                                                                      |
| `entries`        | `Array<Input.File>`             | required | Entry point declarations. Passed to `tsup`; key material only for `tsc`.                                                                                            |
| `deps`           | `Array<Target.Target>`          | required | Dependency targets.                                                                                                                                                 |
| `tsconfig`       | `Input.File`                    | required | The tsconfig the build uses.                                                                                                                                        |
| `tool`           | `TsBuild.Tool`                  | required | Which builder to run: `{ name: "tsc" }` or `{ name: "tsup", external }`. A discriminated union, so a declaration cannot carry a flag the selected tool never reads. |
| `format`         | `"esm" \| "cjs" \| "dual"`      | required | Output module format. Passed to `tsup`; key material only for `tsc`.                                                                                                |
| `outDir`         | `string`                        | required | Output directory, relative to `cwd`. Also the captured output path.                                                                                                 |
| `cwd`            | `string`                        | `"."`    | Workspace-relative directory the tool runs in.                                                                                                                      |

The `tsup` variant's `external` lists the packages left unbundled, forwarded
as `--external`. The `tsc` variant carries no flags: the tsconfig owns every
emit option, and `tsc` has no bundle to exclude a package from.

## Command

The argv is `PackageManager.exec` of the declared package manager. For `tsc`,
the tsconfig owns every emit option. With the pnpm declaration:

```text
pnpm exec tsc -p <tsconfig.path>
```

For `tsup`, the attributes map to flags:

```text
pnpm exec tsup <entries...> --format <esm|cjs|esm,cjs> --out-dir <outDir> [--external <name>]...
```

`format: "dual"` becomes `esm,cjs`.

## Inputs

Collected from the attrs: every declaration in `srcs`, plus `tsconfig`.

## Outputs

Success is `Outputs`:

```ts
{
  outputs: Array<{ path: string; fileCount: number; contentDigest: string }>
}
```

The plan ends with the shared output-capture step, which digests `outDir` after
the build. Capture is sequenced directly behind the producing step, so the
engine settles the build first. `outDir` is a required output: a build that exits
zero without creating it fails the target.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Outputs`        |
| Error   | `Exec.ExecError` |

## Status

|           |                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| Kinds     | `build`                                                                                                                     |
| Cacheable | Never |
| Executes  | Yes, through `ExecLive`                                                                                                     |

## See also

- [DtsBuild](dts-build.md) for declaration-only emit
- [Typecheck](typecheck.md) for checking without emit
- [ToolBuild](tool-build.md) for other toolchains
- [buildAndCheckPackage](standard-package.md), which emits a `TsBuild` `lib` target
