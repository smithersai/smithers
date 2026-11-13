---
title: "DtsBuild"
description: "Emits TypeScript declarations with tsc --emitDeclarationOnly or tsup --dts-only."
---

Emits TypeScript declarations with `tsc --emitDeclarationOnly` or
`tsup --dts-only`.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const types = Smithers.DtsBuild({
  packageManager,
  srcs: [Smithers.glob("src/**/*.ts")],
  entries: [Smithers.file("src/index.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.build.json"),
  tool: { name: "tsc", declarationMap: true },
  outDir: "dist",
  cwd: "packages/greeter"
})

export const Package = Smithers.Package({
  targets: { types }
})
```

## Attributes

| Name       | Type                    | Default  | Description                                                                                                                                                               |
| ---------- | ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `srcs`     | `Array<Input.Declared>` | required | Source declarations. Digested as key material.                                                                                                                            |
| `entries`  | `Array<Input.File>`     | required | Entry point declarations. Passed to `tsup`; key material only for `tsc`.                                                                                                  |
| `deps`     | `Array<Target.Target>`  | required | Dependency targets.                                                                                                                                                       |
| `tsconfig` | `Input.File`            | required | The tsconfig the emit uses.                                                                                                                                               |
| `tool`     | `DtsBuild.Tool`         | required | Which emitter to run: `{ name: "tsc", declarationMap }` or `{ name: "tsup" }`. A discriminated union, so a declaration cannot carry a flag the selected tool never reads. |
| `outDir`   | `string`                | required | Captured output directory, relative to `cwd`.                                                                                                                             |
| `cwd`      | `string`                | `"."`    | Workspace-relative directory the tool runs in.                                                                                                                            |

The `tsc` variant's `declarationMap` declares whether the emit carries
`.d.ts.map` files. The `tsup` variant carries no map policy, because tsup's
`--dts-only` emits no declaration maps at all.

## Command

For `tsc`, the variant's `declarationMap` is forced on the command line so the
emitted tree matches the declared policy whatever the tsconfig says. The
tsconfig still owns the destination, and `outDir` remains the declared capture
path:

```text
pnpm exec tsc -p <tsconfig.path> --declaration --emitDeclarationOnly --declarationMap <true|false>
```

For `tsup`:

```text
pnpm exec tsup <entries...> --dts-only --out-dir <outDir>
```

tsup emits no declaration maps, which is why its variant has no
`declarationMap` to ignore.

## Inputs

Collected from the attrs: every declaration in `srcs`, plus `tsconfig`.

## Outputs

Success is `Outputs`, the same shape [TsBuild](ts-build.md#outputs) produces. The
plan ends with the shared output-capture step over `outDir`.

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

- [TsBuild](ts-build.md) for the JavaScript distribution
- [Typecheck](typecheck.md) for checking without emit
