---
title: "Lockfile"
description: "Generates the lockfile for the package manager the workspace declared."
---

Generates the lockfile for the declared package manager.

```ts
import { Smithers } from "@smthrs/targets"

const runtime = Smithers.Runtime.Node({ version: ">=26.4.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })
const workspace = Smithers.pnpmWorkspace("//pnpm-workspace.yaml")

const lockfile = Smithers.Lockfile({ packageManager, manifests: [workspace] })

export const Package = Smithers.Package({
  targets: { lockfile }
})
```

A lockfile is a build output: derived, deterministic given the manifests and
the registry state it pins, and never hand-edited. Declaring it as a target
says so, and gives [Install](./install.md) something to depend on.

## Why this is separate from Install

A target cannot be keyed on a file it produces. The key would be computed from
the old bytes and then invalidated by the target's own run. So resolution writes
the lockfile here, and installation reads it there, where it is ordinary
declared content.

## Attributes

| Name             | Type               | Default                             | Description                                         |
| ---------------- | ------------------ | ----------------------------------- | --------------------------------------------------- |
| `packageManager` | `PackageManager`   | the workspace declaration           | The declared manager                                |
| `lockfilePath`   | `string`           | the manager's lockfile name         | The file the manager writes, relative to `cwd`      |
| `manifests`      | `Input.Declared[]` | `[glob("packages/*/package.json")]` | The manifests whose change marks the lockfile stale |
| `workspace`      | `Target \| null`   | `null`                              | The workspace-definition target, when generated     |
| `cwd`            | `string`           | `"."`                               | The directory the manager runs in                   |

The manifests are declared inputs: a change to any of them marks this target
affected. They do not select what the manager resolves. The manager reads the
workspace it finds in `cwd`, so declare every manifest that workspace
includes. A `pnpmWorkspace` input parses the workspace file's `packages` list
and expands to that file, the adjacent root manifest, and every selected
member manifest. Other workspace settings remain pnpm-owned and do not need to
be represented by the target schema.

## What it runs

The manager's resolve-only install, with lifecycle scripts refused:

```text
pnpm install --lockfile-only --ignore-scripts
bun  install --lockfile-only --ignore-scripts
```

Resolution has no reason to execute package code, and a lifecycle script that
runs during resolution can change what gets pinned.

## Status

| Property  | Value                                                                                 |
| --------- | ------------------------------------------------------------------------------------- |
| Kinds     | `build`                                                                               |
| Cacheable | No; resolution reaches the network and is not reproducible from declared inputs alone |
| Outputs   | The lockfile the declared manager writes                                              |

Two runs a week apart can pin different versions of the same declared range.
That is exactly what a cache must not paper over.

## See also

- [Install](./install.md)
- [PnpmWorkspace](./pnpm-workspace.md)
