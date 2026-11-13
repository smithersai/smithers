---
title: "VitestWatch"
description: "Runs an interactive vitest watch session under the run verb."
---

Runs an interactive `vitest watch` session.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const testWatch = Smithers.VitestWatch({
  packageManager,
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [Smithers.glob("src/**/*.ts")],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  cwd: "packages/greeter"
})

export const Package = Smithers.Package({
  targets: { testWatch }
})
```

## Attributes

| Name             | Type                            | Default       | Description                                                                                |
| ---------------- | ------------------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| `packageManager` | `PackageManager.PackageManager` | required      | The declared package manager the tool runs through; its name and version are key material. |
| `tests`          | `Array<Input.Declared>`         | required      | Test file declarations. Startup key material only.                                         |
| `sources`        | `Array<Input.Declared>`         | required      | Source declarations. Startup key material only.                                            |
| `deps`           | `Array<Target.Target>`          | required      | Dependency targets.                                                                        |
| `config`         | `Input.File \| null`            | required      | The Vitest config, or `null` to pass no `--config`.                                        |
| `environment`    | `string`                        | required      | The Vitest environment.                                                                    |
| `cwd`            | `string`                        | `"."`         | Workspace-relative directory the runner starts in.                                         |
| `timeoutMs`      | `number \| "unbounded"`         | `"unbounded"` | Optional maximum session duration in milliseconds.                                         |

## Command

The argv is `PackageManager.exec` of the declared package manager. With the
pnpm declaration:

```text
pnpm exec vitest watch [--config <config.path>] --environment <environment>
```

The spawn is a pass-through. The node succeeds when the session exits cleanly,
and interrupting the fiber kills the process. There is no session deadline by
default. Set `timeoutMs` explicitly to bound a session.

## Inputs

Collected from the attrs: every declaration in `tests` and `sources`, plus
`config` when it is not `null`. They describe startup invalidation only; a watch
session re-runs tests itself.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                                        |
| --------- | ------------------------------------------------------ |
| Kinds     | `run`                                                  |
| Cacheable | Never; it is a long-lived process                      |
| Executes  | Yes, through `ExecLive`, as a `run` root or dependency |

Invoke it explicitly with `smithers-build run <label>`. The session holds its
concurrency slot until it exits. Do not put a watch target in a dependency chain
that `build`, `test`, `lint`, or `ci` reaches.

## See also

- [Vitest](vitest.md)
- [Dev](dev.md) for any other long-lived process
- [Running targets](../../workspace/running-targets.md)
