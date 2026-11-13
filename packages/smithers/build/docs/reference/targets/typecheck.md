---
title: "Typecheck"
description: "Checks a package with tsc --noEmit or TypeScript build mode."
---

Checks a package with `tsc --noEmit` or TypeScript build mode.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const typecheck = Smithers.Typecheck({
  packageManager,
  srcs: [Smithers.glob("src/**/*.ts"), Smithers.glob("test/**/*.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd: "packages/greeter"
})

export const Package = Smithers.Package({
  targets: { typecheck }
})
```

## Attributes

| Name             | Type                            | Default  | Description                                                                                |
| ---------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `packageManager` | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material. |
| `srcs`           | `Array<Input.Declared>`         | required | Source declarations. Digested as key material.                                             |
| `deps`           | `Array<Target.Target>`          | required | Dependency targets.                                                                        |
| `tsconfig`       | `Input.File`                    | required | The tsconfig to check.                                                                     |
| `buildMode`      | `boolean`                       | required | Use `tsc -b` for project references instead of `tsc -p`.                                   |
| `incremental`    | `boolean`                       | required | Trust incremental build info.                                                              |
| `cwd`            | `string`                        | `"."`    | Workspace-relative directory `tsc` runs in.                                                |

## Command

The argv is `PackageManager.exec` of the declared package manager. Plain mode,
with the pnpm declaration:

```text
pnpm exec tsc -p <tsconfig.path> --noEmit [--incremental]
```

Build mode, for project references:

```text
pnpm exec tsc -b <tsconfig.path> [--force]
```

`--force` is added when `incremental` is false, so the check never trusts stale
build info.

## Inputs

Collected from the attrs: every declaration in `srcs`, plus `tsconfig`.

## Outputs

None. The target declares no output directories, so success carries only the run
summary.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------- |
| Kinds     | `build`                                                                                         |
| Cacheable | Never |
| Executes  | Yes, through `ExecLive`                                                                         |

## Notes

`buildAndCheckPackage` emits a `Typecheck` target as `check`, over the package's
`tsconfig.test.json`. Call `Typecheck` directly when a package needs a
different project or mode than the macro's convention.

## See also

- [TsBuild](ts-build.md)
- [DtsBuild](dts-build.md)
