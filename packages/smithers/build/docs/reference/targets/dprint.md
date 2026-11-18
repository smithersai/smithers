---
title: "Dprint"
description: "Checks formatting with dprint check, or rewrites it with dprint fmt."
---

Checks formatting with `dprint check`, or rewrites it with `dprint fmt`.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const fmt = Smithers.Dprint({
  packageManager,
  sources: [Smithers.glob("src/**/*.ts"), Smithers.glob("test/**/*.ts")],
  deps: [],
  config: Smithers.file("dprint.json"),
  fix: false,
  cwd: "packages/greeter"
})

export const Package = Smithers.Package({
  targets: { fmt }
})
```

## Attributes

| Name             | Type                            | Default  | Description                                                                                                     |
| ---------------- | ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `packageManager` | `PackageManager.PackageManager` | optional | The declared package manager the tool runs through; its name and version are key material.                      |
| `sources`        | `Array<Input.Declared>`         | required | Declared key material only. dprint discovers what to format from its configuration, not from these declarations. |
| `deps`           | `Array<Target.Target>`          | required | Dependency targets. Usually empty: formatting sources needs nothing built.                                      |
| `config`         | `Input.File`                    | required | The dprint configuration file, passed as `--config`. It decides which files are formatted.                      |
| `fix`            | `boolean`                       | required | `false` runs `dprint check`; `true` runs `dprint fmt` and rewrites files.                                        |
| `cwd`            | `string`                        | `"."`    | Workspace-relative directory the tool runs in.                                                                  |

## Command

The argv is `PackageManager.exec` of the declared package manager. With the
pnpm declaration:

```text
pnpm exec dprint <check|fmt> --config <config.path>
```

Unlike [EsLint](es-lint.md), no source paths reach the argv. `sources`
contributes nothing to the command line; it exists so that a formatting
verdict depends on the digests of the files it covers.

## Inputs

Collected from the attrs: every declaration in `sources`, plus `config`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------- |
| Kinds     | `lint`                                                                                          |
| Cacheable | Never, the external dprint toolchain is not complete key material                               |
| Executes  | Yes, through `ExecLive`                                                                         |

## Notes

The configuration decides the file set, so a package whose `dprint.json`
includes `**/*.md` formats its documentation as well as its sources. That is
the repository default, which means an unformatted docs page fails the
package's `lint` script, not the documentation site's build.

Declare in `sources` every file the configuration covers. A file dprint
formats but no declaration names is invisible to the key, so a change to it
would reuse an earlier verdict.

`buildAndCheckPackage` emits this as the `fmt` target over `src/**/*.ts` and
`test/**/*.ts` with `fix: false`, so the graph checks formatting and never
rewrites it. Run the rewrite yourself with the package's own tooling, or
declare a second target with `fix: true`.

## See also

- [EsLint](es-lint.md), the lint target that is reused after a confined run
- [BiomeCheck](biome-check.md), which formats and lints in one tool
- [buildAndCheckPackage](standard-package.md), which emits a `Dprint` `fmt` target
