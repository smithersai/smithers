---
title: "PnpmWorkspace"
description: "Generates and drift-checks pnpm-workspace.yaml."
---

Generates and drift-checks `pnpm-workspace.yaml`.

```ts
import { Smithers } from "@smthrs/targets"

const runtime = Smithers.Runtime.Node({ version: ">=26.4.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

const workspace = Smithers.PnpmWorkspace({
  packageManager,
  packages: ["packages/*", "apps/*"],
  allowBuilds: { esbuild: false, sharp: false },
  linkWorkspacePackages: true
})

export const Package = Smithers.Package({
  targets: { workspace }
})
```

The target name is unchanged, and what it does is not. It used to run the install
flow; installing is now the [Install](./install.md) target's job. This target owns
the workspace _definition_ file, which decides which directories are packages,
which dependencies may run install scripts, and how workspace links resolve.
All three are build definition, so they belong in PACKAGE.ts rather than in a
second file free to disagree with it.

## Attributes

| Name                    | Type                      | Default   | Description                                   |
| ----------------------- | ------------------------- | --------- | --------------------------------------------- |
| `packageManager`        | `PackageManager`          | required  | Must be the pnpm declaration                  |
| `packages`              | `string[]`                | required  | Workspace package directories, in order       |
| `allowBuilds`           | `Record<string, boolean>` | `{}`      | Which dependencies may run install scripts    |
| `linkWorkspacePackages` | `boolean`                 | `true`    | Whether workspace packages link to each other |
| `mode`                  | `"write" \| "check"`      | `"check"` | Write the file, or verify the checked-in copy |

A manager that is not pnpm is refused at construction, not at execution: a
PACKAGE.ts file that declares npm and then asks for a pnpm workspace definition
is wrong when it is written, and reporting it then names the line to edit.

Package entries are plain strings, not `Input.glob` declarations. A generator's
output depends on the pattern text, not on which files currently match it.

## Rendering

Every package entry is quoted, whether or not YAML requires it: the entries are
glob patterns and `*` is YAML's alias sigil. Mapping keys are quoted only when
YAML would otherwise read them as another type, so `dprint` stays bare while
`"@journeyapps/wa-sqlite"` and `"no"` are quoted.

`allowBuilds` entries are sorted by name, so reordering a PACKAGE.ts literal is
not reported as drift.

## Status

| Property  | Value                                                             |
| --------- | ----------------------------------------------------------------- |
| Kinds     | `build`, `lint`                                                   |
| Cacheable | No                                                                |
| Executes  | Yes; `lint` forces the non-writing view, `build` honours the mode |

## See also

- [Install](./install.md)
- [Tsconfig](./tsconfig.md)
- [Install concept](../../concepts/install.md)
