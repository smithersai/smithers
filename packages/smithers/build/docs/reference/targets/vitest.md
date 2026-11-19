---
title: "Vitest"
description: "Runs a non-watch vitest run over a declared test set."
---

Runs a non-watch `vitest run` over a declared test set.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const test = Smithers.Vitest({
  packageManager,
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [Smithers.glob("src/**/*.ts")],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd: "packages/greeter"
})

export const Package = Smithers.Package({
  targets: { test }
})
```

## Attributes

| Name              | Type                            | Default  | Description                                                                                                                                                     |
| ----------------- | ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packageManager`  | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material.                                                                      |
| `tests`           | `Array<Input.Declared>`         | required | Test file declarations. Digested as key material.                                                                                                               |
| `sources`         | `Array<Input.Declared>`         | required | Source declarations, so a source edit re-keys the run.                                                                                                          |
| `deps`            | `Array<Target.Target>`          | required | Dependency targets, usually the package's `lib`.                                                                                                                |
| `config`          | `Input.File \| null`            | required | The Vitest config, or `null` to pass no `--config`.                                                                                                             |
| `environment`     | `string`                        | required | The Vitest environment, for example `node` or `jsdom`.                                                                                                          |
| `coverage`        | `boolean`                       | `true`   | Whether the run may compute coverage. `false` renders `--coverage.enabled=false`, which a config with coverage enabled needs on an engine with no V8 inspector. |
| `passWithNoTests` | `boolean`                       | required | Succeed when the suite matches no files.                                                                                                                        |
| `bail`            | `number`                        | none     | Stop once this many cases have failed, as `--bail`. The executor sets 1 on a confined attempt whose failure it discards.                                        |
| `cache`           | `false`                         | none     | `false` never reuses the result and runs the target as the workspace declares, with no confined attempt. Set it when the run must leave a report behind.                                                                                                              |
| `tools` | `Array<Reference.HostBin>` | none | The host programs the suite starts by name that its packages do not install, such as `S.Host.bin("zig")`. Each is keyed by the bytes it runs. See [Programs the suite starts](#programs-the-suite-starts). |
| `units` | `"target" \| "file"` | `"target"` | The unit of work. `"file"` makes each test file a unit that `smithers-build units` runs on its own. See [test units](../../concepts/test-units.md). |
| `cwd`             | `string`                        | `"."`    | Workspace-relative directory the runner starts in.                                                                                                              |

## Command

The argv is `PackageManager.exec` of the declared package manager. With the
pnpm declaration:

```text
pnpm exec vitest run [--config <config.path>] --environment <environment> [--coverage.enabled=false] [--bail=<bail>] [--passWithNoTests]
```

The target passes no file arguments. Vitest discovers test files itself; the
declared `tests` control the cache key.

With `units: "file"`, `smithers-build units` runs one test file per process and
adds to the same arguments:

```text
<test file> --reporter=default --reporter=blob --outputFile=<blob> [--coverage.thresholds=false --coverage.reporter=text-summary --coverage.reportsDirectory=<directory>]
```

and merges every unit with `--merge-reports=<blobs>`, which judges the coverage
thresholds. `test` and `ci` still run the target whole.

## Programs the suite starts

A suite that starts a program by name, such as a test that builds a fixture with
`zig` or traces a process with `strace`, declares it:

```ts
const test = S.Vitest({
  // ...
  tools: [S.Host.bin("zig"), S.Host.bin("strace")]
})
```

A host program is also named in the workspace's `S.Host({ bins })`.

- Each name is found on `PATH` when the run is planned. The key holds the bytes
  of the file it resolves to, through any link, and of the program a package
  manager's shim starts. A program replaced in place under the same name and
  version runs the suite again.
- The run finds each by its name in a directory that leads its `PATH`.
- A confined run is shown each declared program, the runtime and package
  manager it runs through, and the system's own programs. The runtime and the
  package manager are shown as their own files and links, not as the `PATH`
  directory they sit in, which holds other programs. A program
  that sits in a `PATH` directory is shown alone; one a link leads into its own
  installation, such as Zig's `lib` beside `zig`, is shown with that
  installation.
- Every other program on the host's `PATH` answers with
  `sandbox: <name> is not declared: declare it in tools` and exit status 127. A
  test that looks the program up does not skip: it fails, and the reason the
  result was not stored names the program.

## Inputs

Collected from the attrs: every declaration in `tests` and `sources`, plus
`config` when it is not `null`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------- |
| Kinds     | `test`                                                                                          |
| Cacheable | After a confined run proves its reads; see [Caching](../../workspace/caching.md#results-reused-with-evidence) |
| Executes  | Yes, through `ExecLive`                                                                         |

## See also

- [VitestCoverage](vitest-coverage.md) for coverage and thresholds
- [VitestWatch](vitest-watch.md) for an interactive session
- [buildAndCheckPackage](standard-package.md), which emits a `Vitest` `test` target
