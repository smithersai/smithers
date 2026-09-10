---
title: "The closed Host surface"
description: "What BrowserHost provides beyond BrowserServices: the five service tags a Smithers host owes, the wasm-backed Jj service, and why the fetch client never follows a redirect on its own."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-browser/docs/concepts/host-bundle.md"
---

A Smithers **Host** is a closed set of five service tags. A program written
against the tags runs on any bundle that provides them, which is what makes a
flow portable between a server and a page.

| Tag                   | Provided here by                                                           |
| --------------------- | -------------------------------------------------------------------------- |
| `FileSystem`          | `BrowserFileSystem.layer`, over the mounted volume.                        |
| `Path`                | Effect's own `Path.layer`, which needs no platform.                        |
| `ChildProcessSpawner` | `BrowserChildProcessSpawner.layer`, over the in-page interpreter.          |
| `Jj`                  | [`@smthrs/jj`](https://jj.smithers.sh/reference/api/)'s `BrowserJj.layer`, over jj-lib compiled to wasm. |
| `HttpClient`          | Effect's `FetchHttpClient.layer`, configured for manual redirects.         |

`ChildProcessSpawner` and `HttpClient` are Effect's own tags. Smithers provides
implementations of them rather than a wrapper around them, so nothing in a flow
imports a Smithers network or process API.

## Two layers, two audiences

`BrowserServices.layer({ bash, fs })` provides the first three tags. It is the
browser counterpart of `NodeServices`, and it is what a page composes when it
wants Effect's platform services and nothing else.

`BrowserHost.layer({ bash, fs, jj })` provides all five. It is what the Smithers
runtime needs, and it is the direct counterpart of
[`NodeHost`](https://platform-node.smithers.sh/reference/api/) and [`BunHost`](https://platform-bun.smithers.sh/reference/api/). In a tab
that runtime is the memory engine and the capability kernel: durable execution
also needs the Node-only `SqlClient` and `NodeRuntime`, which no Host tag
supplies.

`BrowserHost.layer` is the module's only factory. Every backend arrives as an
argument, so there is no `layerAt` or contained-host variant. `Crypto` is not
one of the five tags, so a page that hashes artifacts supplies
`BrowserCrypto.layer` from `@effect/platform-browser` alongside the bundle.

## jj runs in the tab, or says it does not

jj is a native binary, and a tab cannot spawn one. jj-lib compiles to
`wasm32-wasip1` instead, so `BrowserHost` wires `BrowserJj.layer` over the
compiled reactor and the synchronous slice of the same mount `fs` exposes as
promises. The page decides how the bytes arrive: a bundler asset, a `fetch` plus
`WebAssembly.compileStreaming`, or a cache.

`jj.root` defaults to `/` and may instead name an existing repository directory
inside that mount, such as `/repo`. It does not narrow the `FileSystem`
isolation root, which is always the mount root `/`, so use one workspace per
isolated mount. [The isolation attestation](/concepts/isolation-attestation/) explains
why.

The bundle never installs `BrowserJj.layerUnsupported` on its own. A page with
no wasm to hand over composes that layer explicitly, so a jj-less host is a
stated choice rather than a silent default, and every operation then reports
`not_installed` rather than the tag being missing. For how to compose it, see
[Compose the browser host bundle](/guides/compose-the-host/).

## The fetch client never follows a redirect

The one thing this bundle configures on Effect's fetch client is
`RequestInit { redirect: "manual" }`. The reason is the capability kernel: a
grant names an origin, and a followed redirect reaches a second origin that was
never checked. Following a hop is the kernel's guarded `HttpClient.layer`, which
rechecks each one; the host client's job is to hand back the redirect rather
than walk it.

A tab is stricter about what that leaves visible than a server is. Under the
Fetch standard, `redirect: "manual"` produces an **opaque-redirect** response:
status `0`, no headers, no body. The kernel's redirect loop has no `location` to
read, so it returns the response as it stands: a success with status `0` that
the caller must handle, never a hop to another origin.

The same bundle running under Node or Bun sees the ordinary 3xx with its
`location` header instead. Both forms hold the same invariant: the host client
never contacts the second origin on its own.

## Related reading

- [Capabilities and the host kernel](https://smithers.sh/docs/concepts/kernel/), for what a grant
  covers.
- [Injected backends](/concepts/injected-backends/), for the one-mount rule the jj
  slice participates in.
