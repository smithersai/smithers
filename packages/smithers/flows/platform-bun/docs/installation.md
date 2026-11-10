---
title: "Installation"
description: "Install @smthrs/platform-bun from npm with its required peers, the smithers-jj-export helper @smthrs/platform-node ships for the filesystem slot, the jj executable the Jj slot probes on first use, and the import forms for each entry point."
sidebar:
  order: 1
---

## Install the package and its peers

The package is on npm under the `next` tag, which carries the 1.0 release
candidates. Install the current candidate with Bun:

```bash
bun add @smthrs/platform-bun@1.0.0-rc.17 effect @smthrs/kernel@1.0.0-rc.17
```

`@smthrs/kernel` is on the line because the [Quickstart](./quickstart.md)'s
`contained.ts` imports its `ProcessLedger`, which the contained bundles require.
Bun's isolated linker and pnpm link only the packages a project declares.

The manifest declares two required peers, neither optional:

| Peer                    | Version                        | Why                                                       |
| ----------------------- | ------------------------------ | --------------------------------------------------------- |
| `effect`                | `4.1.1`                        | The runtime every service tag belongs to.                 |
| `@smthrs/platform-node` | exactly this package's version | The atomic filesystem slot and the containment machinery. |

Bun installs required peers, so the line above also installs
`@smthrs/platform-node` at the matching version. Install one `effect` in the
peer range so the host shares one Effect runtime. `@effect/platform-bun`,
`@effect/platform-node` and `@effect/platform-node-shared` are bundled
privately, built from `effect@4.1.1`, so your project installs none of them.

## Supported runtimes

Bun 1.4.0 or later, and Node.js 22.19.0 or later. Both are declared in
`engines`, and both are real: the bundle falls back to the
`@effect/platform-node` adapters off Bun, so it runs unchanged under Node. See
[Runtime parity with Node](./concepts/runtime-parity.md) for what that does and
does not buy you.

## The filesystem helper

The filesystem slot is `@smthrs/platform-node`'s `AtomicFileSystem`, which
carries the kernel's atomic host extension. That extension does not run
in-process: it executes each guarded path operation through the
`smithers-jj-export` helper so the operation is descriptor-relative and
no-follow.

`@smthrs/platform-node` ships the helper prebuilt for macOS (arm64, x64), Linux
(arm64, x64), and Windows (x64), so installing the package installs it; there
is nothing to build. `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` only overrides the
packaged helper with another absolute path; see
[Configure the filesystem helper](./guides/configure-the-filesystem-helper.md).

Windows is unsupported for this slot.

## Install Jujutsu for the Jj slot

Every bundle, `BunHost.layer`, `layerAt`, `layerContained`, and
`layerContainedAt`, builds without jj, so a program that never calls `Jj` runs
on a host without it. The `Jj` slot requires jj 0.39.0 or later: its first
operation runs one `jj --version` probe, and on a host without the executable,
or with an older one, that operation fails with `JjError` carrying
`not_installed` or `unsupported_version`. The slot selects the executable when
the layer is built, so restart the program after installing jj.

Install [Jujutsu](https://jj-vcs.github.io), a version-control system that
works on a Git repository, and confirm the version:

```bash
jj --version
```

This package vendors no binaries. [`@smthrs/jj`](/api/jj) documents the
resolution order and the `SMITHERS_JJ_PATH` override for an executable that is
not on `PATH`.

A program that wants only some of the services composes the individual service
layers instead of a complete bundle: `BunFileSystem.layer`, `Path.layer`, and
the spawner and HTTP client layers. See
[The Host surface on Bun](./concepts/host-surface.md) for taking one service
without the other four.

## Import forms

The root entry point re-exports both modules as namespaces, plus `BunRuntime`,
the durable flow runtime on Bun, which has no subpath of its own:

```ts
import { BunFileSystem, BunHost, BunRuntime } from "@smthrs/platform-bun"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as BunFileSystem from "@smthrs/platform-bun/BunFileSystem"
import * as BunHost from "@smthrs/platform-bun/BunHost"
```

Two subpath forms are blocked in the export map and are not public:
`@smthrs/platform-bun/internal/*` and `@smthrs/platform-bun/*/index`.
`@smthrs/platform-bun/package.json` is exported.

The bundle resolves `node:` built-ins, so it does not bundle for a browser. A
page composes [`@smthrs/platform-browser`](/api/platform-browser) instead.

## What a real composition adds

`BunHost.layer` provides the raw host. Two additions are common:

- [`@smthrs/kernel`](/api/kernel) guards it. Its `FileSystem.layer`,
  `ChildProcessSpawner.layer`, `HttpClient.layer`, `Jj.layer`, and `Path.layer`
  decorate the very tags this bundle provides, in place, so a capability check
  runs before every host call. The guarded filesystem is also where the atomic
  extension earns its keep, and it needs a `Workspace` root and a `GrantStore`.
- A `ProcessLedger`, from `@smthrs/kernel/ProcessLedger`, is required by
  `BunHost.layerContained` and `BunHost.layerContainedAt`. It is a requirement
  rather than a default because only your program knows whether it has a
  durable journal to write to. See
  [Contain and reap child processes](./guides/contain-child-processes.md).

The `Jj` slot spawns the `jj` command that
[Install Jujutsu for the Jj slot](#install-jujutsu-for-the-jj-slot) covers. The
slot probes it on its first operation, so jj is a requirement of the programs
that call `Jj`, not of every host.

## Next step

Run a command and a file operation through the host in the
[Quickstart](./quickstart.md).
