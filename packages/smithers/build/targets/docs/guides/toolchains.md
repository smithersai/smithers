---
title: "Workspace toolchains"
description: "What S.Workspace accepts: the Node.js trio, a toolchains list, or both, and what a mixed-language repository declares."
sidebar:
  order: 1
---

`S.Workspace` is where a repository states, once, which tools its targets run
under. Every tool-running rule reads that statement at plan time, so no target
spells an interpreter or a package manager into an argv of its own.

CI jobs that need a repository-built native helper declare it in
`CiToolchain.Needs({ cargoBinaries: [...] })`. Each entry names `package`,
`binary`, the reviewed `toolchain` (`"1.98.0"`), supported `platforms`
(`"linux"` and/or `"darwin"`), and the `environment` variable carrying its path.
The generator builds with the lockfile, installs the executable under
`RUNNER_TEMP/smithers-native`, and exports its absolute path before targets run.
The guarded filesystem's `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` path is part of
the build runner's inherited tool environment; other variables must be
declared by their consuming targets.

The declaration accepts either the complete Node.js trio (`runtime`,
`packageManager`, and `nodeModules`) or a non-empty `toolchains` list. A
repository that builds more than one language declares both. Omitting only part
of the Node.js trio is rejected, because a package manager with no runtime and
a runtime with no installed modules tree each describe a host the planner
cannot hold anything to.

A Go and Nix workspace, with no JavaScript at all:

```ts
import { Smithers as S } from "@smthrs/targets"

const nix = S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
const go = S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: nix })

export const Workspace = S.Workspace("service", {
  repository: "git+https://example.test/service.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [nix, go]
})
```

The generated GitHub Actions setup follows the declaration: a Go-only workspace
renders `actions/setup-go` with `go-version-file`. A target that asks for a
package-manager reference in a workspace that declared none is refused rather
than defaulted.

For the two toolchain layers in detail, see [Go toolchains](./go.md) and
[Nix dev shells](./nix.md).
