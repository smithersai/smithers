---
title: "Quickstart"
description: "Stand up the Node host, run a command and read a file through it, then wrap it in the capability kernel and watch a symlink escape get refused."
sidebar:
  order: 2
---

This quickstart runs one program against the Node host twice: once raw, and
once behind the capability kernel with a workspace root. By the end you will
have seen the bundle do real work and refuse a real escape, and you will know
which layer is responsible for each.
Each step below is TypeScript; the
[VibeLang tab](#the-same-walkthrough-in-vibelang) runs the same program as
`effect` functions.

## Prerequisites

- Node.js 22.19.0 or later, on a POSIX host.
- A project with the packages installed:
  `npm install @smthrs/platform-node@next @smthrs/kernel@next effect`. The
  package ships the `smithers-jj-export` helper the filesystem runs.

## Run a command through the raw host

Create `quickstart.ts`. `NodeHost.layer` provides all five host tags, so a
program that asks for `ChildProcessSpawner` gets Effect's Node spawner:

```ts
import { NodeHost } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"

const runCommand = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("printf", ["hello from node"]))
})

console.log(await Effect.runPromise(Effect.provide(runCommand, NodeHost.layer)))
```

```text
hello from node
```

Nothing here is a Smithers wrapper. `ChildProcess` and `ChildProcessSpawner`
are Effect's own tags; this package supplies the implementation and nothing
else. A wall-clock budget is `Effect.timeout` around the effect, and
cancelling a command is fiber interruption.

## Build a workspace with an escape in it

The filesystem is where this bundle differs from Effect's Node adapter, so give
it something to refuse. Create a workspace directory with one ordinary file
inside it, and one symlink pointing at a file outside it:

```ts
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const container = mkdtempSync(join(tmpdir(), "platform-node-quickstart-"))
const workspace = join(container, "workspace")
const secret = join(container, "secret.txt")

mkdirSync(workspace)
writeFileSync(join(workspace, "inside.txt"), "confined\n")
writeFileSync(secret, "outside\n")
symlinkSync(secret, join(workspace, "escape.txt"))
```

## Compose the guarded host

`HostServices.layer` from [`@smthrs/kernel`](/api/kernel) decorates every one
of the five tags with a capability check. It needs the workspace root that
bounds the filesystem, and a grant store that answers the permission
questions. For this local trial, use the allow-all store, so that the only
thing left refusing anything is the confinement itself. `GrantStore.layerNoop`
is a seam for tests and boot paths, not a production policy; a real host
answers with rules, as
[Write a capability policy](../../kernel/docs/guides/write-a-capability-policy.md)
shows:

```ts
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as Layer from "effect/Layer"

const guarded = HostServices.layer.pipe(
  Layer.provide(NodeHost.layer),
  Layer.provide(Workspace.layer(workspace)),
  Layer.provide(GrantStore.layerNoop)
)
```

## Read both files

Read the ordinary file, then read through the symlink and keep the failure
instead of the success:

```ts
import * as FileSystem from "effect/FileSystem"

const readBoth = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const inside = yield* fs.readFileString(join(workspace, "inside.txt"))
  const refusal = yield* Effect.flip(fs.readFileString(join(workspace, "escape.txt")))
  return { inside: inside.trim(), refusedWith: refusal.reason._tag }
})

console.log(await Effect.runPromise(Effect.provide(readBoth, guarded)))
```

```text
{ inside: 'confined', refusedWith: 'PermissionDenied' }
```

## What just happened

The first read walked the workspace with directory descriptors and opened a
regular file. The second read reached a symlink, and the walk refuses to
traverse one, so the operation failed with a typed `PermissionDenied` before
anything outside the workspace was opened. The grant store allowed both reads:
the refusal came from the descriptor-relative walk, not from a permission rule.

That is the property the bundle exists for. A path check followed by a
path-based open leaves a window in which the path can be swapped; performing
the operation relative to a pinned descriptor closes it. See
[The descriptor-relative filesystem](./concepts/descriptor-relative-filesystem.md)
for how the helper does it and what else it refuses.

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) each step is an `effect`
function and `try` runs each host call. The workspace is built through Effect's
`FileSystem` from the raw host instead of `node:fs`, inside a temporary
directory that `scoped` removes, and a nested `provide` swaps the raw host for
the guarded one around the two reads.

This is `examples/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

```vibe
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import * as Workspace from "@smthrs/kernel/Workspace"
import { NodeHost } from "@smthrs/platform-node"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"

/** Runs a command through Effect's own spawner tag; this package supplies only the implementation. */
export effect function runCommand() {
  const spawner = try ChildProcessSpawner
  return try spawner.string(ChildProcess.make("printf", ["hello from node"]))
}

/** Builds a workspace holding one ordinary file and a symlink to a file outside it. */
export effect function buildWorkspace(container: string) {
  const fs = try FileSystem.FileSystem
  const path = try Path.Path
  const workspace = path.join(container, "workspace")
  const secret = path.join(container, "secret.txt")
  try fs.makeDirectory(workspace)
  try fs.writeFileString(path.join(workspace, "inside.txt"), "confined\n")
  try fs.writeFileString(secret, "outside\n")
  try fs.symlink(secret, path.join(workspace, "escape.txt"))
  return workspace
}

/** The five host tags behind capability checks, confined to `workspace`, with every grant allowed. */
export const guarded = (workspace: string) =>
  HostServices.layer.pipe(
    Layer.provide(NodeHost.layer),
    Layer.provide(Workspace.layer(workspace)),
    Layer.provide(GrantStore.layerNoop)
  )

/** Reads the ordinary file, then keeps the failure of the read through the symlink. */
export effect function readBoth(workspace: string) {
  const fs = try FileSystem.FileSystem
  const path = try Path.Path
  const inside = try fs.readFileString(path.join(workspace, "inside.txt"))
  const refusal = try flip(fs.readFileString(path.join(workspace, "escape.txt")))
  return { inside: inside.trim(), refusedWith: refusal.reason._tag }
}

/** The raw host runs the command and builds the workspace; the guarded host reads it. */
export effect function quickstart() {
  provide NodeHost.layer {
    const printed = try runCommand()
    return try scoped(effect {
      const workspace = try buildWorkspace(try (try FileSystem.FileSystem).makeTempDirectoryScoped())
      provide guarded(workspace) {
        return { printed, ...try readBoth(workspace) }
      }
    })
  }
}
```

## Next steps

- [Contain child processes](./guides/contain-child-processes.md): give every
  spawned process a kill deadline and a durable record, so a crashed host
  leaves nothing running.
- [Configure the filesystem helper](./guides/configure-the-filesystem-helper.md):
  point at a different helper, and set the ceilings that bound a wide
  fan-out.
- [The host bundle](./concepts/host-bundle.md): the five tags, the four layers,
  and what the bundle deliberately does not provide.
- [Troubleshooting](./troubleshooting.md): what to do when every filesystem
  call fails closed.
