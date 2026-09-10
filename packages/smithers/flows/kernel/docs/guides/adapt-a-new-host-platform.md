---
title: "Adapt a new host platform"
description: "Implement the five host ports for a new runtime: attach the filesystem confinement extension the kernel requires, declare what your bundle does not support, and prove it with the shared contract suite."
sidebar:
  order: 7
---

A host adapter provides the five tags on the closed list. It does not check
capabilities; the kernel does that above it. What the adapter owes the kernel
is an honest filesystem and a truthful declaration of what it cannot do.

## Provide the five tags

Your bundle is one `Layer` providing `FileSystem`, `Path`,
`ChildProcessSpawner`, `Jj`, and `HttpClient`. Where Effect owns the tag,
implement Effect's service rather than a wrapper around it.

A capability you do not support still gets a tag. Fail it in the error channel
with a stable code instead of omitting the service:

```ts
import { CommandLine } from "@smthrs/kernel"
import { Effect, Layer, PlatformError } from "effect"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"

const layerSpawnerUnsupported: Layer.Layer<ChildProcessSpawner> = Layer.succeed(ChildProcessSpawner)(
  makeSpawner((command) =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "NotFound",
        module: "MyHost",
        method: "spawn",
        description: `no process host for \`${CommandLine.render(command)}\``
      })
    )
  )
)
```

The kernel ships stubs for two of these: `ChildProcessSpawner.layerNoop()` and
`HttpClient.layerNoop()`.

Derive the spawner's six methods from one `spawn` with
`ChildProcessSpawner.make`, so `exitCode`, `string`, `lines`, and both `stream`
helpers can never diverge from what `spawn` was given. Render command lines
with `CommandLine.render`: it is the same renderer the `proc:spawn` capability
resource uses, so an adapter that executes a different string than the kernel
authorized is a defect the contract catches.

## Attach a filesystem confinement extension

This is the one thing the kernel will not do for you. A path-based filesystem
cannot be confined, because the pathname the kernel checked is not the
pathname the host resolves. A host that attaches neither extension fails every
relevant filesystem operation closed.

**A native host attaches a descriptor-relative executor:**

```ts
import { FileSystem as KernelFileSystem } from "@smthrs/kernel"

const guardedRoot = KernelFileSystem.withAtomicFileSystem(myFileSystem, {
  execute: (request) => runRelativeToPinnedRoot(request)
})
```

The executor receives an `AtomicRequest`: one member per operation, naming the
boundary and logical roots and exactly the operands that operation needs. Run
it relative to a pinned root handle, rejecting symlinks as you traverse, and
answer the result the operation names (`AtomicResult`). An executor that runs
in process can be a typed `AtomicHandlers` record, which will not compile until
every operation is implemented.

**An isolated volume attests instead:**

```ts
const volume = KernelFileSystem.withIsolatedFileSystem(myInMemoryFileSystem)
```

Use this only when the implementation genuinely cannot address the host
filesystem, as an in-memory browser volume cannot.
`@smthrs/platform-browser` does exactly this. It throws on a filesystem that
already carries a descriptor-relative executor, so the stronger guarantee can
never be downgraded to the weaker one.

Both functions decorate the supplied object in place and return the same
identity. Attach once, at the boundary, and keep no undecorated alias.

## Prove it with the contract suite

`@smthrs/kernel/test/contract` exports `runHostContract`, the shared
behavioral contract every host bundle must satisfy. It registers Vitest cases,
so install the peers first:

```bash
pnpm add -D @effect/vitest@4.0.0-rc.112 vitest@4.1.9
```

Then declare, per slot, whether your bundle supports the capability and what it
answers when it does not:

```ts
import { runHostContract } from "@smthrs/kernel/test/contract"
import { Layer } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"

runHostContract("MyHost", Layer.mergeAll(fs, path, spawner, jj, http), {
  fileSystem: {
    expected: "success",
    // A scratch root, only when your filesystem rejects an OS temp path.
    scratchPath: "/scratch",
    // Per-operation exceptions, with the code each one fails with.
    unsupported: { link: "NotFound", symlink: "NotFound", watch: "NotFound" }
  },
  path: { expected: "success" },
  childProcess: {
    expected: "success",
    execCommand: ChildProcess.make("printf", ["ok"]),
    expectedStdout: "ok",
    stdin: { expected: "failure", code: "BadArgument" },
    pipeline: { expected: "failure", code: "BadArgument" }
  },
  jj: { expected: "failure", code: "not_installed" },
  httpClient: { expected: "failure", code: "TransportError" }
})
```

A slot you do not support is
`{ expected: "failure", code: "<the stable code>" }`. The suite normalizes the
three shapes a host failure carries its code in: a `code` field on `JjError`, a
nested `reason._tag` on `PlatformError` and `HttpClientError`, and a bare
`_tag` on a thrown tagged value.

The suite asserts that every tag on the closed list resolves, that every
filesystem operation is declared one way or the other, that the spawner
executes, streams, honours options, and is observably interruptible, and that
the HTTP client executes a read, a write, and a **manual** redirect. That last
one matters: a host that follows redirects on its own defeats the kernel's
per-hop check, and the contract is where it gets caught.

Declare defaults rather than overriding them where you can. A default nobody
runs is a default nobody has checked.

## Related

- [Filesystem confinement](../concepts/filesystem-confinement.md): why the
  extension is not optional.
- [Testing](../testing.md): the rest of what this package ships for tests.
