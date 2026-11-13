---
title: "Bind jj to a repository and contain its child process"
description: "Choose among the four Node and Bun layers: whether jj is pinned to one repository root, and whether its child process runs under the host's spawner."
sidebar:
  order: 3
---

`NodeJj` ships four layers, and `BunJj` re-exports all four. They differ along
two independent axes, so picking one is two yes-or-no answers.

|                       | Spawns its own child | Spawns through the host |
| --------------------- | -------------------- | ----------------------- |
| Repository is the cwd | `layer`              | `layerSpawner`          |
| Repository is bound   | `layerAt(root)`      | `layerSpawnerAt(root)`  |

Everything else is identical. Both process-ownership modes share one command
vocabulary, one error classification, and one 64 MiB output ceiling, so routing
jj through a spawner changes nothing a caller can observe.

## Axis one: who owns the child process

```ts
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"

// A program with no spawner to offer.
const direct = NodeJj.layer

// A host whose spawner decides how children are started and stopped.
const spawner = Layer.provide(
  NodeChildProcessSpawner.layer,
  Layer.mergeAll(NodeFileSystem.layer, Path.layer)
)
const contained = Layer.provide(NodeJj.layerSpawner, spawner)
```

`layer` spawns through `node:child_process` directly. Use it when a host must
be able to checkpoint work where a spawner is unavailable, sandboxed, or gated
behind a `proc:spawn` grant the user has not given.

`layerSpawner` requires Effect's `ChildProcessSpawner`, so whatever decorates
that service decorates jj too: the child lands in a recorded process group, in
the kernel's process ledger, and within reach of the reaper that sweeps a
crashed incarnation. Use it wherever the host contains what it starts.
[`@smthrs/platform-node`](/api/platform-node) wires this one into its contained
host bundle, and [`@smthrs/platform-bun`](/api/platform-bun) does the same with
`BunJj.layerSpawner`.

### What `layer` costs, exactly

A jj child started around the spawner leads no process group the host recorded
and is not reaped by a later incarnation of a host that died holding it. That is
a bounded exposure rather than a leak, and the bound is what makes the layer
usable:

- Every command it runs is short-lived and starts no long-lived child of its
  own. Each writes to a pipe, so jj starts no pager.
- No command opens an editor: `snapshot` never runs `describe` and never passes
  its message to jj.
- The invocation holds the handle it started, so cancelling the fiber signals
  the process rather than losing it. The package pins that with a `jj` shim
  that never returns: after an interrupt, nothing on the machine still names
  it.

## Axis two: which repository

```ts
const bound = NodeJj.layerAt("/srv/checkouts/main")
```

Binding makes repository authority explicit. A later change to `process.cwd()`
cannot redirect snapshots, restores, or diffs into another checkout, which
matters in a long-lived process where a step you did not write may `chdir`.

Two consequences to know:

- A **relative** `path` handed to `workspaceAdd` resolves against the bound root
  here, and against the caller's working directory under `layer`. Pass absolute
  lane paths and the difference never bites.
- `root(from)` is **exempt** from the binding by design. Its argument names the
  directory jj must run in, which is the whole question it answers.

A relative repository root is a wiring mistake, not a runtime condition, so both
bound layers throw a `TypeError` at construction rather than failing later:

```text
TypeError: NodeJj.layerAt requires an absolute repository root: ./checkout
```

## Find the root to bind to

When you have a path inside a checkout but not the checkout itself, ask jj:

```ts
import { Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"

const rootOf = (from: string) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    return yield* jj.root!(from)
  })
```

`root` runs `jj root` in the directory that holds `from`, which is correct for
colocated repositories and secondary workspaces where walking up looking for
`.jj` is not. A `from` that names a file resolves to its directory first,
because handing a file to a spawn as its working directory throws `ENOTDIR`
synchronously. Only the terminal line ending is stripped from the answer, never
surrounding whitespace, because a repository root may end in a space.

## Diagnosing a bad binding

A missing working directory and a missing binary both surface as `ENOENT` from
`spawn`, so the adapter probes the directory before it blames the binary. A
bound layer pointed at a directory that is gone reports the directory:

```text
jj status: cannot run in /srv/checkouts/main: not a directory
```

rather than claiming jj is not installed while jj sits on `PATH`.
