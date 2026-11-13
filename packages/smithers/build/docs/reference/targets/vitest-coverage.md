---
title: "VitestCoverage"
description: "Runs vitest run with coverage enabled, and declares the report directory as an output."
---

Runs `vitest run` with coverage enabled and declares the report directory.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const coverage = Smithers.VitestCoverage({
  packageManager,
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [Smithers.glob("src/**/*.ts")],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  provider: "v8",
  reportsDirectory: "coverage",
  thresholds: { branches: 80, functions: 80, lines: 80, statements: 80 },
  cwd: "packages/greeter"
})

export const Package = Smithers.Package({
  targets: { coverage }
})
```

## Attributes

| Name               | Type                                       | Default  | Description                                                                                |
| ------------------ | ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------ |
| `packageManager`   | `PackageManager.PackageManager`            | required | The declared package manager the tool runs through; its name and version are key material. |
| `tests`            | `Array<Input.Declared>`                    | required | Test file declarations.                                                                    |
| `sources`          | `Array<Input.Declared>`                    | required | Source declarations.                                                                       |
| `deps`             | `Array<Target.Target>`                     | required | Dependency targets.                                                                        |
| `config`           | `Input.File \| null`                       | required | The Vitest config, or `null` to pass no `--config`.                                        |
| `provider`         | `"v8" \| "istanbul"`                       | required | Coverage provider.                                                                         |
| `reportsDirectory` | `string`                                   | required | Where coverage reports are written, relative to `cwd`.                                     |
| `thresholds`       | `{branches, functions, lines, statements}` | required | Minimum coverage percentages. All four are numbers and all four are required.              |
| `cwd`              | `string`                                   | `"."`    | Workspace-relative directory the runner starts in.                                         |

## Command

The argv is `PackageManager.exec` of the declared package manager. With the
pnpm declaration:

```text
pnpm exec vitest run [--config <config.path>] \
  --coverage.enabled=true \
  --coverage.provider=<provider> \
  --coverage.reportsDirectory=<reportsDirectory> \
  --coverage.thresholds.branches=<n> \
  --coverage.thresholds.functions=<n> \
  --coverage.thresholds.lines=<n> \
  --coverage.thresholds.statements=<n>
```

## Inputs

Collected from the attrs: every declaration in `tests` and `sources`, plus
`config` when it is not `null`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `CoverageReport` |
| Error   | `Exec.ExecError` |

```ts
CoverageReport = { run: Exec.Result, reportsDirectory: string }
```

The success value carries `reportsDirectory` so a downstream target can consume
the written reports.

## Status

|           |                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------- |
| Kinds     | `test`                                                                                          |
| Cacheable | Never |
| Executes  | Yes, through `ExecLive`                                                                         |

## See also

- [Vitest](vitest.md)
- [VitestWatch](vitest-watch.md)
