---
title: "Installation"
description: "Install @smthrs/jj, the jj executable the Node and Bun layers spawn, the import forms for each entry point, and the wasm asset a browser layer needs."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/jj/docs/installation.md"
---

## Get the package

`@smthrs/jj` is not on npm at 1.0.0-rc.0. It ships as a member of the
[smithers repository](https://github.com/smithersai/smithers) workspace, so
using it today means working from a checkout:

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
```

Code that consumes it lives in that workspace too, either an existing package
or one you add, and depends on it with a workspace specifier:

```json
{
  "dependencies": {
    "@smthrs/jj": "workspace:*"
  }
}
```

## Requirements

- Node.js 22.19.0 or later.
- [`effect`](https://effect.website) 4.0.0-rc.115. It is a peer dependency, so
  the application owns the single copy every layer resolves against.
- [`@smthrs/capability`](https://capability.smithers.sh/reference/api/), the only package `@smthrs/jj`
  depends on. It names the permission failures a guarded `Jj` adds to the error
  channel.

Neither dependency pulls in a process spawner or an HTTP client, which is what
keeps the root entry point browser bundleable. The package builds to both ESM
and CommonJS with TypeScript declarations.

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

With no usable jj, every operation fails with the `not_installed` code and a
message naming the fix, rather than throwing. Nothing in the package installs,
downloads, or `chmod`s a binary on your behalf.

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
[Choose which jj binary runs](/guides/choose-the-jj-binary/).

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

See [Run jj in a browser tab](/guides/run-jj-in-a-browser/) for the whole
composition and for the places the WebAssembly backend answers differently from
the jj command line.

## What a host composition adds

A host that guards jj behind capability grants adds
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/), whose `Jj.layer` decorates this package's tag
in place. A host that wants jj children inside its process ledger adds a
`ChildProcessSpawner` and uses `NodeJj.layerSpawner`;
[`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) and
[`@smthrs/platform-bun`](https://platform-bun.smithers.sh/reference/api/) ship that composition already
wired.

## Next step

Take a snapshot of a real repository and put it back in the
[Quickstart](/quickstart/).
