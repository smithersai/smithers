---
title: "Install"
description: "Produces node_modules for the package manager the workspace declared."
---

Produces `node_modules` for the declared package manager.

```ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=26.4.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

const nodeModules = Smithers.Install({ packageManager })

export const Package = Smithers.Package({
  targets: { nodeModules }
})
```

Listed in the root Package map as `nodeModules`, the label is `//:nodeModules`.

This replaces `PnpmWorkspace`, the manager-specific wrapper that configured
itself: it hardcoded pnpm, took lockfile and workspace-manifest attrs it did
not use, and left the install flow to discover the manager through its own
layer. One target now covers every manager, and the manager arrives as a
declaration the caller passes in.

## Attributes

| Name             | Type             | Default  | Description                                                        |
| ---------------- | ---------------- | -------- | ------------------------------------------------------------------ |
| `packageManager` | `PackageManager` | required | The declared manager, from `PackageManager.Pnpm` or `.BunPackages` |
| `lockfile`       | `Target \| null` | `null`   | The `Lockfile` target, when the lockfile is generated              |
| `manifest`       | `Target \| null` | `null`   | The root-manifest target, when it is generated                     |
| `workspace`      | `Target \| null` | `null`   | The workspace-definition target, when it is generated              |

The three optional attributes are dependency edges, not file declarations. They
order the generators before the install. The lockfile's _content_ still reaches
this target's key through its declared inputs, so a hand-edited lockfile
invalidates the install even though the same file is another target's output.

There is no `cwd`. Execution is anchored to the canonical workspace root by the
package-manager service.

## Declared inputs

The target declares three files, whoever produced them:

1. the lockfile the declared manager writes, for example `pnpm-lock.yaml`;
2. `.npmrc`, which decides the registry and the credentials;
3. `package.json`, which decides what the workspace asked for.

A change in any of the three changes what an install produces.

## What it plans

The target body is one call to the install flow, carrying the declared manager:

```ts
implementation: ;
;((attrs) => Install.Install.call({ manager: attrs.packageManager.name }))
```

The manager is a plan-time value, so the flow selects one manager-specific
fetch action in a single round. It measures the lockfile and `.npmrc` digests,
verifies the host against the declared manager and runtime versions, fetches
into `.flows/store/<manager>`, and always reconciles `node_modules` offline.
Measure, fetch, and link all use `expected` boundaries and are not admitted to
the cross-run engine cache.

## Channels

| Channel | Type                                                            |
| ------- | --------------------------------------------------------------- |
| Success | `Install.LinkManifest`, `{store, manifest, linked}`             |
| Error   | `PackageManager.PackageManagerError`, `{code, message, cause?}` |

Error `code` is one of `command_failed`, `environment_mismatch`,
`lockfile_unreadable`, `manifest_unreadable`, `unsafe_configuration`, or
`unsupported`. A host whose manager or runtime does not satisfy the declared
version fails with `environment_mismatch` before anything is written.

## Status

| Property  | Value                                                                |
| --------- | -------------------------------------------------------------------- |
| Kinds     | `run`                                                                |
| Cacheable | No; a JSON hit must never skip local link reconciliation             |
| Executes  | Yes, as a `run` root or dependency, under the declared manager layer |

The outer target is explicitly `cache: false`. Its `LinkManifest` is not enough
to restore either `node_modules` or the manager store, so caching that wrapper
would allow a JSON hit to skip the entire nested install flow.

`smithers-build install` runs the same flow directly and requires the default `.flows`
cache directory because the store boundary is fixed there.

## See also

- [Install concept](../../concepts/install.md)
- [Lockfile](./lockfile.md)
- [PnpmWorkspace](./pnpm-workspace.md)
- [CLI install verb](../cli.md#install)
