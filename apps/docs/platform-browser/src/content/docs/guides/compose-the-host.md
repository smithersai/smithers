---
title: "Compose the browser host bundle"
description: "Wire one ZenFS mount, a just-bash interpreter, and the flows_jj wasm reactor into BrowserHost.layer, and compose a host for a page that has no wasm to hand over."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-browser/docs/guides/compose-the-host.md"
---

`BrowserHost.layer` provides the five service tags the Smithers runtime needs
from a host. Everything it runs on is passed in, so this guide is the order in
which a page assembles the three arguments.

## Mount the volume first

Both filesystem shapes come from one isolated mount. The FileSystem isolation
root is `/`; create the repository directory inside it before jj opens it:

```ts
import { configureSingle, fs } from "@zenfs/core"
import { IndexedDB } from "@zenfs/dom"

await configureSingle({ backend: IndexedDB })
await fs.promises.mkdir("/repo", { recursive: true })
```

`fs` is the synchronous API jj mounts through WASI. `fs.promises` is the
asynchronous one `BrowserFileSystem` adapts. They are two shapes of the same
volume, which is what the bundle requires.

## Load the wasm and build the interpreter

```ts
import { Bash } from "just-bash"

// wasmUrl: however your bundler serves @smthrs/jj's wasm/flows_jj.wasm.
const wasm = await WebAssembly.compileStreaming(fetch(wasmUrl))
const bash = new Bash({ fs })
```

The layer never fetches. Handing it an already-compiled `WebAssembly.Module`
lets a page share one module across layers, and raw bytes work too.

## Compose the bundle

```ts
import * as BrowserHost from "@smthrs/platform-browser/BrowserHost"

const layer = BrowserHost.layer({
  bash,
  fs: fs.promises,
  jj: { wasm, fs, root: "/repo" }
})
```

| Argument | What it is                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------- |
| `bash`   | The just-bash interpreter, over the mount.                                                     |
| `fs`     | The promises API of the mount.                                                                 |
| `jj`     | `BrowserJj.BrowserJjOptions`: `wasm`, the synchronous `fs`, an optional `root` and stdio taps. |

`jj.root` defaults to `"/"`. A dedicated directory such as `/repo` keeps the
repository's `.jj` inside that directory. It must already exist in the mount.
The FileSystem isolation root stays `/`, regardless of `jj.root`.
The full option semantics, including which fields are read once and which is
read at the first operation, are in
[`@smthrs/jj`](https://jj.smithers.sh/guides/run-jj-in-a-browser/).

## Sync the mount after writes that must persist

ZenFS writes back to IndexedDB and OPFS asynchronously, so a returned write is
not yet a stored write. Call the mount's `sync()` after the writes that must
survive a reload, including after jj operations. This bundle does not own the
mount.

## A page with no wasm

`BrowserHost.layer` requires jj options, and it never installs a jj-less layer
on your behalf. A page that cannot supply wasm composes the same five tags
explicitly and says so:

```ts
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import { BrowserServices } from "@smthrs/platform-browser"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

const layer = Layer.mergeAll(
  BrowserServices.layer({ bash, fs: fs.promises }),
  // Every jj operation reports `not_installed` instead of the tag being absent.
  BrowserJj.layerUnsupported,
  // The same manual-redirect client BrowserHost configures.
  Layer.provide(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })
  )
)
```

Keep `redirect: "manual"`. It is what stops the runtime from walking to a second
origin behind the capability kernel's grant check, and
[The closed Host surface](/concepts/host-bundle/) explains what a tab does
with the resulting opaque redirect.

## Verify the pairing

The mistake this composition can still make is handing `bash`, `fs`, and
`jj.fs` views of different volumes. It produces no error, only disagreement, so
assert it once in a test: write a file through `FileSystem`, read it back
through a spawned command, and snapshot it with jj. If all three agree, the
three arguments are one mount. See [Testing](/testing/).

Use one workspace per isolated mount. The FileSystem isolation root is `/`;
`jj.root` may name a dedicated repository directory inside that mount.
