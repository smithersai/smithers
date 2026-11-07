---
title: "Installation"
description: "Install @smthrs/jj, the jj executable the Node and Bun layers spawn, the import forms for each entry point, and the wasm asset a browser layer needs."
sidebar:
  order: 1
---

## Install the package

```bash
npm install @smthrs/jj@next effect
```

The `next` tag carries the 1.0 release candidates.

## Requirements

- Node.js 22.19.0 or later.
- [`effect`](https://effect.website) `4.1.1`. It is a peer dependency, so
  the application owns the single copy every layer resolves against.
- [`@smthrs/capability`](/api/capability) and
  [`@smthrs/canonical`](/api/canonical), the two packages `@smthrs/jj` depends
  on. `@smthrs/capability` names the permission failures a guarded `Jj` adds to
  the error channel.

None of these dependencies pulls in a process spawner or an HTTP client, which
is what keeps the root entry point browser bundleable. The package builds to
both ESM and CommonJS with TypeScript declarations.

## Install jj for the Node and Bun layers

`NodeJj` and `BunJj` spawn the `jj` executable. This package vendors no
binaries, so install jj yourself:

```bash
brew install jj          # macOS
cargo install --locked jj-cli
```

Other platforms are covered by the
[Jujutsu installation guide](https://jj-vcs.github.io). Confirm the result:

```bash
jj --version
```

The layers build without jj. With no usable jj, every operation fails with the
`not_installed` code and a message naming the fix, rather than throwing. Nothing in the package installs,
downloads, or `chmod`s a binary on your behalf.

On a stale or sibling working-copy operation error, the Node and Bun layers fail with `JjError.code = "stale_workspace"`, naming the workspace directory. They disable jj’s automatic stale update and never run `workspace update-stale` or retry with a working-copy rewrite. Commit or back up your files, then recover deliberately.

### Point at a specific jj

Set `SMITHERS_JJ_PATH` to the file you want spawned:

```bash
export SMITHERS_JJ_PATH=/opt/homebrew/bin/jj
```

An override that names an existing file stays authoritative even when it is not
executable, so a broken explicit path is reported instead of a different binary
being quietly substituted. An override that names nothing falls through to
`PATH`, and the fall-through is reported rather than silent. For the resolution
order and what `smthrs doctor` prints, see
[Choose which jj binary runs](./guides/choose-the-jj-binary.md).

## Import forms

The root entry point re-exports the contract flat:

```ts
import { isJjError, Jj, JjError, layerNoop, make, makeNoop } from "@smthrs/jj"
```

Implementations are never root exports. Import each from its own subpath:

```ts
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import * as BunJj from "@smthrs/jj/bun/BunJj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as resolveJjBinary from "@smthrs/jj/node/resolveJjBinary"
```

Two subpath forms are not public and are blocked in the export map:
`@smthrs/jj/internal/*` and `@smthrs/jj/*/index`. `@smthrs/jj/package.json` is
exported.

## The wasm asset for a browser layer

`BrowserJj` runs a compiled reactor that ships in the package at
`wasm/flows_jj.wasm`, exported as `@smthrs/jj/wasm/flows_jj.wasm`. It is an
asset, not a module: the layer never fetches, so serving the bytes is your
bundler's business. Copy the file into your static assets or let the bundler
emit a URL for it, then compile it yourself and hand over the module:

```ts
const wasm = await WebAssembly.compileStreaming(fetch(wasmUrl))
```

`BrowserJj` accepts either a compiled `WebAssembly.Module` or the raw bytes, so
`fetch(wasmUrl).then((r) => r.arrayBuffer())` works too.

A browser layer also needs a synchronous filesystem, which the package does not
supply either. In a page that is ZenFS:

```bash
pnpm add @zenfs/core @zenfs/dom
```

See [Run jj in a browser tab](./guides/run-jj-in-a-browser.md) for the whole
composition and for the places the WebAssembly backend answers differently from
the jj command line.

## What a host composition adds

A host that guards jj behind capability grants adds
[`@smthrs/kernel`](/api/kernel), whose `Jj.layer` decorates this package's tag
in place. A host that wants jj children inside its process ledger adds a
`ChildProcessSpawner` and uses `NodeJj.layerSpawner`;
[`@smthrs/platform-node`](/api/platform-node) and
[`@smthrs/platform-bun`](/api/platform-bun) ship that composition already
wired.

## Next step

Take a snapshot of a real repository and put it back in the
[Quickstart](./quickstart.md).
