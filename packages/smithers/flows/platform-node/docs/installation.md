---
title: "Installation"
description: "Install @smthrs/platform-node, the peers and host prerequisites it needs, its entry points, and the packages a real host composition adds."
sidebar:
  order: 1
---

## Install the package

```bash
npm install @smthrs/platform-node@next effect
```

The `next` tag carries the 1.0 release candidates.

`effect` is the one peer dependency, at exactly `4.1.1`, so your project
picks its version rather than inheriting a second copy.

`@effect/platform-node` and `@effect/platform-node-shared` are bundled
privately, built from `effect@4.1.1`, so your project installs neither for
this package. The upstream Node adapter uses a caret for its shared adapter,
which otherwise permits a later shared adapter with an incompatible Effect
peer. Bundling both keeps the Node implementation on one Effect release.

Its own runtime dependencies, [`@smthrs/jj`](/api/jj) and
[`@smthrs/kernel`](/api/kernel), install with it.

The package ships ESM, CommonJS, and TypeScript declarations.

## Host requirements

| Requirement                     | Why it is needed                                                      |
| ------------------------------- | --------------------------------------------------------------------- |
| Node.js 22.19.0 or later        | the minimum this package's `engines` field declares                   |
| macOS, Linux, or Windows x64    | a matching native helper must be available                            |
| the `smithers-jj-export` helper | `AtomicFileSystem` runs every guarded filesystem operation through it |
| `jj` 0.39.0 or newer on `PATH`  | required by `Jj` operations; a host builds without it                 |

### jj is checked on first use

Every complete host bundle, `NodeHost.layer`, `NodeHost.layerAt`,
`NodeHost.layerContained`, and `NodeHost.layerContainedAt`, builds without jj
and spawns nothing while it builds. Its `Jj` service runs `jj --version` on its
first operation, so a program that uses only the filesystem, process spawner,
or HTTP client runs on a host with no jj. Compensable steps, time-travel
restores, and any code that calls `Jj` need jj 0.39.0 or newer. Check the
installed version with `jj --version`.

If the executable is missing, that first operation fails with a typed `JjError`
whose code is `not_installed`. An older version fails with
`unsupported_version`. A refused probe runs again on the next operation, so an
in-place upgrade needs no restart. The bundle picks the jj path, from
`SMITHERS_JJ_PATH` or `PATH`, when it builds: restart the host after installing
jj. The probe uses the same runner as repository commands, so the contained
bundles record it in the process ledger.

### The filesystem helper

The package ships the helper prebuilt for macOS (arm64, x64), Linux (arm64,
x64), and Windows (x64), so installing the package installs it; there is
nothing to build. `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` only overrides the
packaged helper with another absolute path.

`NodeHost.layer` builds cleanly on a host with no helper. The executable is
re-validated on every request rather than once at construction, because the
file a path names can be replaced while a host runs, and a check that happened
only at boot would be a check about a file that is no longer there.

The consequence is that where no helper resolves, the layer builds, the run
starts, and the first guarded filesystem call inside a flow body fails with
`PermissionDenied`. For the search order and
`layerWith`, see
[Configure the filesystem helper](./guides/configure-the-filesystem-helper.md).

## Individual services

A program that should reach only part of the host can provide individual
service layers instead of a bundle. This composition supplies the bundle's
filesystem, path, process spawner, and HTTP client, and no `Jj`:

```ts
import { NodeHost } from "@smthrs/platform-node"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"

const platform = Layer.mergeAll(NodeHost.AtomicFileSystem.layer, Path.layer)
const spawner = NodeHost.NodeChildProcessSpawner.layer.pipe(Layer.provide(platform))
const http = NodeHost.EgressHttpClient.layer(process.env)
const hostWithoutJj = Layer.mergeAll(platform, spawner, http)
```

`NodeHost.EgressHttpClient.layer(process.env)` is the HTTP client the complete
bundles above use. It routes through the proxy `HTTP_PROXY`, `HTTPS_PROXY` and
`NO_PROXY` name, and is the plain Undici pool when they name none.
`NodeHost.NodeHttpClient.layerUndici` is that plain pool on its own: it dials
every origin directly and ignores the proxy variables, so it bypasses an
egress proxy allowlist. Compose it only when direct egress is intended.

Provide `hostWithoutJj` to a program that needs these services, or provide only
the individual layer it needs. The spawner requires both filesystem and path
services, supplied by `platform` above. The filesystem still requires the
helper described above. This composition does not provide `Jj`
and cannot satisfy consumers that require the complete five-tag host.

## Import forms

The root entry point re-exports every module as a namespace, including the
durable flow runtime:

```ts
import { HostLiveness, NodeHost, NodeRuntime, ProcessReaper, SandboxedFlow, ScopedProcess } from "@smthrs/platform-node"
```

`FetchTransport`, `NodeGarbageCollector`, `NodeLanguageServer`, `NodeRuntime`,
`NativeRuntime`, `SandboxedFlow`, and `TestNodeRuntime` have no subpath of
their own; import them from the root.

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as HostLiveness from "@smthrs/platform-node/HostLiveness"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
```

`AtomicFileSystem` is deliberately not in the barrel. Reach it through its own
subpath, or as a re-export off `NodeHost`:

```ts
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
// or
import { NodeHost } from "@smthrs/platform-node"
const filesystem = NodeHost.AtomicFileSystem.layer
```

Two subpath shapes are blocked in the export map:
`@smthrs/platform-node/internal/*` and `@smthrs/platform-node/*/index`.
`@smthrs/platform-node/package.json` is exported.

## Entry points

| Import                                   | Source                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/platform-node`                  | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/index.ts)                       |
| `@smthrs/platform-node/NodeHost`         | [src/NodeHost.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/NodeHost.ts)                 |
| `@smthrs/platform-node/AtomicFileSystem` | [src/AtomicFileSystem.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/AtomicFileSystem.ts) |
| `@smthrs/platform-node/HostLiveness`     | [src/HostLiveness.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/HostLiveness.ts)         |
| `@smthrs/platform-node/ProcessReaper`    | [src/ProcessReaper.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/ProcessReaper.ts)       |
| `@smthrs/platform-node/ScopedProcess`    | [src/ScopedProcess.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/ScopedProcess.ts)       |

Every entry point is Node-only by construction: the bundle resolves
`node:child_process` and its siblings, and a build check keeps it that way. For a
browser host, use [`@smthrs/platform-browser`](/api/platform-browser); for Bun,
[`@smthrs/platform-bun`](/api/platform-bun).

## What a real composition adds

This package provides raw host services. A composition that enforces
capabilities wraps them in [`@smthrs/kernel`](/api/kernel)'s decorators, which
need a workspace root and a grant store. Add that package to your own
dependencies, then compose:

```bash
npm install @smthrs/kernel@next
```

```ts
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import * as Workspace from "@smthrs/kernel/Workspace"
import { NodeHost } from "@smthrs/platform-node"
import * as Layer from "effect/Layer"

const guarded = HostServices.layer.pipe(
  Layer.provide(NodeHost.layer),
  Layer.provide(Workspace.layer("/absolute/workspace")),
  Layer.provide(GrantStore.layerNoop)
)
```

`GrantStore.layerNoop` allows every operation inside the workspace. It is a
seam for tests and boot paths, not a production policy. Replace it with a
rule-based store before running untrusted work; see
[Write a capability policy](../../kernel/docs/guides/write-a-capability-policy.md).

Turning on process containment adds a `ProcessLedger`, which the journal backs.
See [Contain child processes](./guides/contain-child-processes.md).

Most programs never compose this by hand. This package's `NodeRuntime` builds
the whole durable runtime, including `NodeHost.layerContainedAt` and
`HostLiveness.isAlive`, from one options object.
