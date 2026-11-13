---
title: "DepsLint"
description: "Checks missing, unused, and undeclared dependencies with knip or depcheck."
---

Checks missing, unused, and undeclared dependencies with knip or depcheck.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager, runtime } from "../../PACKAGE.ts"

const dependencyPolicy = Smithers.DepsLint({
  runtime,
  packageManager,
  packageJson: Smithers.file("package.json"),
  sources: [Smithers.glob("src/**/*.ts"), Smithers.glob("test/**/*.ts")],
  deps: [lib],
  tool: "knip",
  ignoreDependencies: ["@effect/platform-node"],
  ignoreBinaries: [],
  cwd: "packages/app"
})

export const Package = Smithers.Package({
  targets: { dependencyPolicy }
})
```

## Attributes

| Name                 | Type                            | Default  | Description                                                                                  |
| -------------------- | ------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `runtime`            | `Runtime.Runtime`               | required | The declared JavaScript runtime the inline program runs under.                               |
| `packageManager`     | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material.   |
| `packageJson`        | `Input.File`                    | required | The manifest being checked. Both tools read it from `cwd`; this declaration is key material. |
| `sources`            | `Array<Input.Declared>`         | required | Source declarations. Key material.                                                           |
| `deps`               | `Array<Target.Target>`          | required | Dependency targets.                                                                          |
| `tool`               | `"knip" \| "depcheck"`          | required | Which checker to run.                                                                        |
| `ignoreDependencies` | `Array<string>`                 | required | Dependencies to ignore.                                                                      |
| `ignoreBinaries`     | `Array<string>`                 | required | Binaries to ignore.                                                                          |
| `cwd`                | `string`                        | `"."`    | Workspace-relative directory the tool runs in.                                               |

## Commands

The checker argvs are `PackageManager.exec` of the declared package manager, and
the inline config writer is `Runtime.evaluate` of the declared runtime. The
spellings below use the pnpm and Node declarations.

**depcheck.** Both ignore lists are merged, deduplicated, and forwarded as one
flag:

```text
pnpm exec depcheck [--ignores=<a,b,c>]
```

**knip with no ignores.** knip runs under its own config discovery:

```text
pnpm exec knip --dependencies
```

**knip with ignores.** knip accepts ignores only through configuration, so the
plan first writes a derived config, then runs knip against it. Two exec steps,
ordered by the `after` field:

```text
node -e <write program> <configPath> <configJson>      # from the workspace root
pnpm exec knip --dependencies --config <path relative to cwd> # from cwd
```

The generated config contains only the non-empty lists, with keys in a fixed
order so equal attrs always produce equal JSON:

```json
{ "ignoreBinaries": ["..."], "ignoreDependencies": ["..."] }
```

Its file name carries a 32-bit FNV-1a fingerprint of that JSON, so two targets
with different ignore sets sharing one `cwd` never race on one path. Passing
`--config` replaces any ambient knip configuration.

## The cache-directory token

The generated config is written under the resolved workspace cache directory. The
plan emits the constant token `{smthrs:cache-directory}` in the path, and
`ExecLive` substitutes the validated host directory immediately before spawn. The
real path therefore never enters attrs, an action payload, or a step key. See
[Configuration](../../workspace/configuration.md).

## Inputs

Collected from the attrs: `packageJson`, plus every declaration in `sources`.

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

## See also

- [PackageLint](package-lint.md) for the published surface
- [Workspace reference](../config.md)
