---
title: "NpmPublish"
description: "Publishes a package to an npm registry."
---

Publishes a package to an npm registry.

```ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

const publish = Smithers.NpmPublish({
  packageManager,
  packageJson: Smithers.file("//packages/greeter/package.json"),
  artifacts: [Smithers.glob("//packages/greeter/dist/**/*")],
  deps: [lib, packageLint],
  registry: "https://registry.npmjs.org",
  access: "public",
  provenance: true,
  tag: "latest",
  dryRun: true
})

export const Package = Smithers.Package({
  targets: { publish }
})
```

## Attributes

| Name             | Type                            | Default  | Description                                                                                |
| ---------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `packageManager` | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material. |
| `packageJson`    | `Input.File`                    | required | The manifest. Its directory is where the publish command runs.                             |
| `artifacts`      | `Array<Input.Declared>`         | required | Built output declarations, digested as key material.                                       |
| `deps`           | `Array<Target.Target>`          | required | Dependency targets: the build, the package lint, and versioning.                           |
| `registry`       | `string`                        | required | Passed as `--registry`.                                                                    |
| `access`         | `"public" \| "restricted"`      | required | Passed as `--access`.                                                                      |
| `provenance`     | `boolean`                       | required | Spelled into the environment as `npm_config_provenance` and `pnpm_config_provenance`.      |
| `tag`            | `string`                        | required | The dist-tag, passed as `--tag`.                                                           |
| `dryRun`         | `boolean`                       | `true`   | Append `--dry-run`. A real publish is always an explicit opt-out.                          |

There is no `cwd`. The publish directory is `Input.declaredDirectory` of
`packageJson.path`: a `//` path yields its workspace-relative directory, and a
package-relative path resolves from the declaring package directory.

## Command

Through the irreversible exec action, because publication changes external
registry state. The argv is `PackageManager.publish` of the declared package
manager. With the pnpm declaration:

```text
pnpm publish --registry <registry> --access <access> --tag <tag> --no-git-checks [--dry-run]
```

Environment: `npm_config_provenance` and `pnpm_config_provenance`, both set to
`true` or `false` from the `provenance` attribute. npm and pnpm 10 read the
`npm_config_` key; pnpm 11 reads the `pnpm_config_` key. `false` is always
spelled out, so a manifest or inherited configuration that enables provenance
cannot override the declaration.

`--no-git-checks` is always passed. Tree policy belongs to the release pipeline,
not the publish step.

`registry`, `access`, and `tag` land on argv even though they mirror the
generated manifest's `publishConfig`, which pnpm also reads. `provenance` rides
the environment so the attribute wins over a stale manifest.

## Inputs

Collected from the attrs: `packageJson`, plus every declaration in `artifacts`.

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

- [JsrPublish](jsr-publish.md), which runs after npm publication
- [Changesets](changesets.md), which declares the irreversible exec action
- [PackageJson](package-json-gen.md), which derives publish fields from the build target
