---
title: "Installation"
description: "Install @smthrs/std, its runtime requirements and import form, the platforms its root entry runs on, and the packages a host adds to make the handlers runnable."
sidebar:
  order: 1
---

## Install the package

```bash
npm install @smthrs/std@next effect
```

The `next` tag carries the 1.0 release candidates.

On Node.js it
requires 22.19.0 or later. It ships as both ESM and CommonJS with TypeScript
declarations. Its runtime dependencies install with it:
[`effect`](https://effect.website), plus [`@smthrs/core`](/api/core) for the
flow declaration type, [`@smthrs/kernel`](/api/kernel) for the permission-aware
host services, [`@smthrs/capability`](/api/capability) for the capability
vocabulary, and [`@smthrs/control`](/api/control) for the credential seam
`ExaWebSearch` reads its API key through.

## Import form

The root entry point re-exports every module as a namespace. Import from it:

```ts
import { Grep, Manifest, Read, StdError } from "@smthrs/std"
```

Each module also has its own subpath, `@smthrs/std/<Module>`. Two subpath forms
are not public: `@smthrs/std/internal/*` and `@smthrs/std/<Module>/index`. Both
are blocked in the export map and carry no promise.
`@smthrs/std/package.json` is exported.

## Platforms

The root entry point imports and runs in a browser, a Cloudflare Worker,
Node.js, and Bun. It reaches no `node:*` module, and the repository's browser
check bundles it for the browser.

What a handler can do on a platform depends on the services the host provides:

- `PortableSearch` walks the injected `FileSystem`, so a browser host that
  provides one gets working `grep` and `glob` with no external binary.
- The process handlers read the environment through `@smthrs/kernel`'s
  `ChildProcessSpawner.ambientEnvironment()`, which is empty on a host without
  a `process` global.
- The web handlers need a client that pins each request to the addresses they
  checked, and a name resolver. A browser tab or a Worker has neither, so
  `fetch`, `http-post`, and `webfetch` refuse there with `unsupported`. See
  [Reach the network](./guides/reach-the-network.md#where-names-resolve).
- `lsp` needs a bound `LanguageServer`. The client that runs server processes
  is `NodeLanguageServer` in [`@smthrs/platform-node`](/api/platform-node).

## What a runnable host adds

The declarations run nowhere on their own. Handlers ask for host services
through Effect's context, so a composition adds a platform package that provides
them:

```bash
pnpm add @effect/platform-node @effect/platform-node-shared
```

`NodeServices.layer` from `@effect/platform-node` provides `FileSystem`, `Path`,
and `ChildProcessSpawner`, which is everything the filesystem, search, and shell
handlers require. A host that wants the permission kernel's capability checks in
front of those services builds them through
[`@smthrs/kernel`](/api/kernel)'s `HostServices` instead, which is what the
Smithers CLI does.

| Handler                                     | Services it requires                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `Read.run`, `Edit.run`                      | `FileSystem`                                                                   |
| `Write.run`, `Ls.run`, `ApplyPatch.run`     | `FileSystem`, `Path`                                                           |
| `Grep.run`, `Glob.run`                      | `Search`                                                                       |
| `Bash.run`                                  | `ChildProcessSpawner`, `Path`, and `Container` when a call names one           |
| `TestRun.run`                               | `ChildProcessSpawner`, `TestRunner`, and `Container` when the runner names one |
| `ShellCommand.run`                          | `ChildProcessSpawner`                                                          |
| `Fetch.run`, `HttpPost.run`, `WebFetch.run` | `HttpClient`, `GrantStore`                                                     |
| `WebSearch.run`                             | `WebSearch`                                                                    |
| `Lsp.run`                                   | `LanguageServer`, `FileSystem`                                                 |
| `UpdatePlan.run`                            | none                                                                           |

## The six injected services

Six flows reach the host through a service rather than through a platform layer.
Each one has a refusal layer for a host that cannot serve it, so a flow whose
service is missing says so instead of succeeding quietly.

| Service          | Refusal layer              | Working layer                                                                   |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `Search`         | `Search.layerNoop`         | `PortableSearch.layer` or `NativeSearch.layer`                                  |
| `Container`      | `Container.layerNoop`      | `Container.layerCommand({ program: "docker" })`                                 |
| `TestRunner`     | `TestRunner.layerNoop`     | `TestRunner.layer(runner)`                                                      |
| `Checkpoints`    | `Checkpoints.layerNoop`    | `Checkpoints.layerGit({ root })` or `Checkpoints.layerContainer({ container })` |
| `WebSearch`      | `WebSearch.layerNoop`      | `ExaWebSearch.layer(credentialId)`                                              |
| `LanguageServer` | `LanguageServer.layerNoop` | `NodeLanguageServer.layer(config)` from `@smthrs/platform-node`                 |

`NativeSearch.layer` drives the `rg` executable, so a host that binds it needs
ripgrep on the path. `PortableSearch.layer` needs nothing beyond `FileSystem`
and `Path`. `ExaWebSearch.layer` additionally requires
[`@smthrs/control`](/api/control)'s `Credential` service and
[`@smthrs/kernel`](/api/kernel)'s `HttpClient`.

Composing these is one job, covered in
[Bind the standard flows into a host](./guides/bind-the-standard-flows.md).
