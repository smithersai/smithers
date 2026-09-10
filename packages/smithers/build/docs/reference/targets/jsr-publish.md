---
title: "JsrPublish"
description: "Publishes a package to JSR."
---

Publishes a package to JSR.

```ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

const publishJsr = Smithers.JsrPublish({
  packageManager,
  config: Smithers.file("//packages/greeter/jsr.json"),
  sources: [Smithers.glob("//packages/greeter/src/**/*.ts")],
  deps: [publish],
  package: "@smthrs/flow",
  cliVersion: "0.13.4",
  allowDirty: false,
  dryRun: true
})

export const Package = Smithers.Package({
  targets: { publishJsr }
})
```

## Attributes

| Name             | Type                            | Default  | Description                                                                                |
| ---------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `packageManager` | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material. |
| `config`         | `Input.File`                    | required | The JSR config. Its directory is where `jsr publish` runs.                                 |
| `sources`        | `Array<Input.Declared>`         | required | Source declarations digested as key material.                                              |
| `deps`           | `Array<Target.Target>`          | required | Dependency targets, usually the npm publish target.                                        |
| `package`        | `string`                        | required | The published identity. Key material only; jsr reads the name from the config file.        |
| `cliVersion`     | `string`                        | required | One exact `jsr` CLI release, run as `jsr@<cliVersion>`. Ranges and dist-tags are refused.  |
| `allowDirty`     | `boolean`                       | required | Append `--allow-dirty`.                                                                    |
| `dryRun`         | `boolean`                       | `true`   | Append `--dry-run`. A real publish is always an explicit opt-out.                          |

There is no `cwd`. The publish directory is `Input.declaredDirectory` of
`config.path`: a `//` path yields its workspace-relative directory, and a
package-relative path resolves from the declaring package directory.

## Command

Through the irreversible exec action, because publication changes external
registry state. The argv is `PackageManager.dlx` of the declared package
manager. `cliVersion` pins the release `dlx` fetches, so no publish, dry run
included, executes an unpinned download. With the pnpm declaration:

```text
pnpm dlx jsr@<cliVersion> publish [--allow-dirty] [--dry-run]
```

## Inputs

Collected from the attrs: `config`, plus every declaration in `sources`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                                   |
| --------- | ------------------------------------------------- |
| Kinds     | `run`                                             |
| Cacheable | Never                                             |
| Executes  | Yes, through the CLI's `ExecIrreversibleLive` layer. |

`smithers-build run` selects this target. Its `run` verb gate rejects inclusion
under other verbs, including through dependency edges, so `build`, `test`,
`lint`, `docs`, and `ci` cannot include it.

The resolved `dryRun` attribute defaults to `true` and appends `--dry-run`.
Setting `dryRun: false` removes that flag and allows real publication. The CLI
supplies the irreversible execution layer; it does not unconditionally refuse
publication. `--plan` only plans and never executes.

## See also

- [NpmPublish](npm-publish.md), which runs before JSR publication
- [Changesets](changesets.md), which declares the irreversible exec action
