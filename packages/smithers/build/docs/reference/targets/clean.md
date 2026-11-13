---
title: "Clean"
description: "Deletes declared target output directories and workspace-rooted scratch paths."
---

Deletes generated output directories and explicitly named scratch paths through
the native package executor. No runtime or inline script is required.

```ts
// packages/greeter/PACKAGE.ts
import { Smithers } from "@smthrs/targets"

const clean = Smithers.Clean({
  paths: ["packages/greeter/dist", "packages/greeter/coverage"]
})

export const Package = Smithers.Package({ targets: { clean } })
```

## Attributes

| Name | Type | Default | Description |
| ---- | ---- | ------- | ----------- |
| `targets` | `Array<Target.Target>` | omitted | Targets whose declared `outDirs` should be removed, including their immediate dependency targets' `outDirs`. |
| `paths` | `Array<string>` | omitted | Literal paths resolved from the workspace root, regardless of the declaring package. |

To clean a build target's output directories, pass `targets: [lib]`. The
planner resolves those `outDirs` against their declaring packages. It does not
run the targets being cleaned.

`paths` are literal paths, not glob patterns. In a package declaration,
`paths: ["dist"]` means the workspace root's `dist`. Use
`"packages/greeter/dist"` for that package's output. List a `node_modules`
directory explicitly if it should be removed.

## Execution and validation

The native executor resolves every output and scratch path inside the canonical
workspace root, including symbolic-link checks, before removing any of them.
A refused path fails the target without deleting the other paths. Accepted
paths are removed recursively; missing paths are harmless.

## Channels and status

| Property | Value |
| -------- | ----- |
| Kinds | `run` |
| Cacheable | Never |
| Success | A successful native target result |
| Error | A target failure describing the refused path or removal error |
| Executes | Yes, through the native package executor |

Invoke it explicitly with `smithers-build run <label>`.

## See also

- [Running targets](../../workspace/running-targets.md)
- [Dev](dev.md)
