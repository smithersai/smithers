---
title: "Installation"
description: "Install @smthrs/platform-browser, the backends you supply yourself (a ZenFS mount, a just-bash interpreter, the flows_jj wasm reactor), the import forms, and the browser bundle gate."
sidebar:
  order: 1
---

## Install the package

```bash
npm install @smthrs/platform-browser@next effect
```

The `next` tag carries the 1.0 release candidates.

`effect` is a peer dependency at exactly `4.1.1`, so install it
yourself at that version. The services these adapters implement live in Effect 4
(`effect/FileSystem`, `effect/Path`, and `effect/process`), Effect 3
does not satisfy the peer range, and two copies of `effect` in one program are
two sets of service tags.

The package ships as ESM and CommonJS with TypeScript declarations, and its
`engines` field asks for Node.js 26.4.0 or later, which is the toolchain that
installs and builds it rather than a runtime the code needs. Its other runtime
dependencies install with it:

| Dependency                                                        | Why it is here                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`@smthrs/kernel`](/api/kernel)                                   | `CommandLine.render`, which produces the line the interpreter runs, and the filesystem isolation attestation. |
| [`@smthrs/jj`](/api/jj)                                           | The wasm-backed `Jj` service the `BrowserHost` bundle composes.                                               |
| [`@smthrs/flows`](/api/flows) and the engine packages it composes | The durable engine `BrowserRuntime` hosts.                                                                    |
| `@journeyapps/wa-sqlite`                                          | SQLite compiled to WebAssembly, and the OPFS VFS `BrowserSqlite` opens the store with.                        |

## What you supply

Neither backend is a dependency of this package. Each arrives as a structural
slice, so the page decides which one is mounted and this package's dependency
list stays short. Install the ones your composition needs:

| You supply                         | Where it comes from                                                                                           | Needed by                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| A `node:fs/promises`-shaped object | [`@zenfs/core`](https://www.npmjs.com/package/@zenfs/core)'s `fs.promises`, over a backend from `@zenfs/dom`. | `BrowserFileSystem`          |
| A bash interpreter instance        | [`just-bash`](https://www.npmjs.com/package/just-bash)'s `Bash` class (`new Bash({ fs })`).                   | `BrowserChildProcessSpawner` |
| The `flows_jj.wasm` reactor        | [`@smthrs/jj`](/api/jj)'s `wasm/flows_jj.wasm`, served by your bundler.                                       | `BrowserHost` only           |
| The wa-sqlite build                | `@journeyapps/wa-sqlite/dist/wa-sqlite.mjs` and `wa-sqlite.wasm`, imported lazily by your engine worker.      | `BrowserRuntime.run`         |

```bash
npm install @zenfs/core @zenfs/dom just-bash
```

All three must view the same filesystem. The interpreter, the promises object,
and the synchronous slice jj mounts are three views of one volume, and a
composition that splits them produces adapters that disagree about what exists.
See [Injected backends](./concepts/injected-backends.md).

Because the slices are structural, a test satisfies them without either vendor
package: Node's own `node:fs/promises` satisfies `ZenFsPromisesLike`, so a test
can run against a real temp directory instead of a mock. See
[Testing](./testing.md).

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { BrowserChildProcessSpawner, BrowserFileSystem, BrowserHost, BrowserServices } from "@smthrs/platform-browser"
```

Each module is also importable from its own subpath, which is the form the API
reference uses:

```ts
import * as BrowserFileSystem from "@smthrs/platform-browser/BrowserFileSystem"
import * as BrowserHost from "@smthrs/platform-browser/BrowserHost"
```

The durable engine's modules, `BrowserRuntime`, `BrowserEngine`,
`BrowserSqlite`, `WebLock`, `TabChannel` and `StoragePersistence`, are exported
from the root entry point only.

Deeper paths are not public. `@smthrs/platform-browser/BrowserFileSystem/*`,
`@smthrs/platform-browser/BrowserChildProcessSpawner/*`,
`@smthrs/platform-browser/internal/*`, and `@smthrs/platform-browser/*/index`
are all blocked in the export map, so the two adapter directories have exactly
one entry point each. `@smthrs/platform-browser/package.json` is exported.

## Browser bundles

Every module here bundles for a browser. No published module resolves a `node:`
built-in, `BrowserHost` included, whose `HttpClient` is Effect's `fetch` client
rather than a Node transport, so no bundler asks you for a polyfill it cannot
supply. Bundle the root entry point in browser mode to see it: nothing in the
graph names a `node:` specifier.

## Next step

Mount a volume, run a command, and read the file back through both views in the
[Quickstart](./quickstart.md).
