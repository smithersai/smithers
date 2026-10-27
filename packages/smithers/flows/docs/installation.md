---
title: "Installation"
description: "Install @smthrs/flows and a platform package from npm, the Node and effect requirements, the import forms, the platform package each runtime needs, and when to depend on individual engine packages instead."
sidebar:
  order: 1
---

## Install the package

```bash
npm install @smthrs/platform-node@next @smthrs/flows@next effect
```

`@smthrs/flows` is the engine and imports no platform code. A program that runs
flows also installs the host for its runtime, `@smthrs/platform-node` on Node.

npm 11 ends the install with an `install-scripts` warning naming `esbuild`.
Leaving it unapproved is safe: npm installs esbuild's platform binary as an
ordinary dependency, and `SandboxedFlow` bundles without the script.

The `next` tag carries the 1.0 release candidates. With pnpm 11, name the
version instead of the tag, then approve `esbuild`'s install script:

```bash
pnpm add @smthrs/platform-node@1.0.0-rc.16 @smthrs/flows@1.0.0-rc.16 effect
pnpm approve-builds esbuild
```

pnpm 11 installs only versions at least 24 hours old (`minimumReleaseAge`), so
`@smthrs/flows@next` resolves to the newest candidate published more than a day
ago, which can be more than one release behind `next`. An exact version is
installed the day it is published: pnpm records it under
`minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. pnpm 11 also ends
the install with `ERR_PNPM_IGNORED_BUILDS` until the project allows or denies
the install script of `esbuild`; the packages are already installed, and
`approve-builds` records the choice in `pnpm-workspace.yaml` so later installs
succeed.

`@smthrs/flows` installs the twenty engine packages it re-exports.
[`@smthrs/platform-node`](../platform-node/docs/api.md) installs `@smthrs/flows`,
the Node SQLite driver `@effect/sql-sqlite-node`, and `esbuild`, which
`SandboxedFlow` uses to bundle a guest entry module. `effect` is a peer
dependency. Install it yourself, and name `@smthrs/flows` too, because your
program imports both directly and pnpm links only the packages a project
declares.

## Requirements

- Node.js 22.19.0 or later, which also runs a `.ts` file directly, with no build
  step. Durable execution is tested on Node.js 22.19+ and Bun 1.4+; `engines`
  requires Node `>=22.19.0`.
- [jj](https://jj-vcs.github.io/jj/latest/install-and-setup/) 0.39.0 or later
  on `PATH`, or `SMITHERS_JJ_PATH` naming the binary, for the steps that use
  it: a compensable step, which the engine snapshots before each attempt; a
  time-travel fork, which adds a jj workspace for the child run; a rewind that
  restores files, because it crosses a compensable step or sets `wholeRepo`;
  and an action that calls `Jj`. A rewind over sealed steps alone needs no jj.
  A compensable step's workspace must also be a jj repository (`jj git init`).
  Every `NodeRuntime` and `BunRuntime` host starts without jj. The first step
  that needs jj runs `jj --version` and fails with `No jj on PATH` when there
  is none. On macOS, `brew install jj`; the linked page covers Linux and
  Windows.
- [`effect`](https://effect.website) at exactly `4.0.5`, as a peer
  dependency. This is an Effect library throughout: a flow's payload and result
  are Effect schemas, an action's implementation is an `Effect`, and a host is
  a `Layer`. Install one `effect` in the consuming project, so the service
  tags and schemas this package exports are the same classes the project
  constructs. A project already on Effect 4.0.5 or later keeps its version.

The package ships as ESM and CommonJS with TypeScript declarations.

## Import forms

The root entry point is the barrel. Authoring names are flat and infrastructure
packages are namespaces:

```ts
import { Action, Engine, Flow, Interpreter, Journal, Kernel } from "@smthrs/flows"
```

The runtime core, `Runtime`, consumes injected services. In the published
`1.0.0-rc.16`, import the Node runtime and sandbox composition from
these subpaths:

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
```

The source checkout relocates these namespaces to `@smthrs/platform-node`
and the Bun runtime to `@smthrs/platform-bun`. Those root runtime exports are
not part of the published rc.16 packages.

Two subpath forms are blocked in the export map and are not public:
`@smthrs/flows/internal/*` and `@smthrs/flows/*/index`.
`@smthrs/flows/package.json` is exported.

## Platform packages

The root entry point imports no platform, for the same reason `effect`'s own
index does not re-export `@effect/platform-node`: one import must not resolve
`node:child_process`, ZenFS, and Bun at once. A platform is reached through its
own package:

| Runtime           | Runtime export                         | Platform package                                                    |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------- |
| Node.js           | `NodeRuntime`                          | `@smthrs/flows/NodeRuntime` (rc.16)                                 |
| Bun               | `BunRuntime`                           | [`@smthrs/platform-bun`](../platform-bun/docs/api.md)               |
| Browser tab       | `BrowserRuntime`, `BrowserEngine`      | [`@smthrs/platform-browser`](../platform-browser/docs/api.md)       |
| Cloudflare Worker | `CloudflareRuntime`, `ExecutionObject` | [`@smthrs/platform-cloudflare`](../platform-cloudflare/docs/api.md) |

`@smthrs/platform-node` supplies the Node host, containment, process reaping,
and the liveness probe. In rc.16, `NodeRuntime` is in the flows subpath above. It carries its own copy of
`@effect/platform-node` and installs the SQLite driver `@effect/sql-sqlite-node`,
so a Node program adds no `@effect/*` package of its own. The
[Bun](#bun-durable-execution) section has the Bun line.

Test doubles are reached through their own packages:
`@smthrs/testing/TestHost`, `@smthrs/database/node/NodeDatabase`,
`@smthrs/journal/test/TestJournal`.

## Bundling for a browser is not durable execution

The root entry point bundles for a browser and for a Cloudflare Worker, and so
does every package root it re-exports. What bundles is the engine with no host:
you can declare flows, read a plan, and decode a journal event anywhere.

Durable execution is a different claim: it needs a host, a SQL store, and the
platform package that binds them. Durable execution is tested on Node.js 22.19+
and Bun 1.4+; `engines` requires Node `>=22.19.0`. The browser and Cloudflare
hosts carry their own evidence in their packages. The native compositions live
in the platform packages precisely so importing the root never opens
`node:sqlite`.

## When to depend on individual packages instead

The barrel is a convenience, not a seam. A library published to other consumers
usually wants the narrower dependency: depend on
[`@smthrs/flow`](../flow/docs/api.md) alone to declare flows and actions, or on
[`@smthrs/engine`](../engine/docs/api.md) and
[`@smthrs/engine-store`](../engine-store/docs/api.md) to execute them. Reach for
`@smthrs/flows` in the program that composes the whole engine, which is where
one dependency saves you twenty.

Install an individual package at `@next` as well, for example
`npm install @smthrs/flow@next effect`. `latest` on several engine packages,
among them `@smthrs/engine` and `@smthrs/testing`, still names a 0.x release.

## Use PostgreSQL

SQLite is the default. To keep the durable stores in PostgreSQL instead,
install the optional adapter:

```bash
npm install @effect/sql-pg
```

Then set `SMITHERS_POSTGRES_URL` to a `postgres://` connection string, or pass
one as the `filename` of `NodeRuntime.layerHost` from `@smthrs/flows/NodeRuntime` in rc.16. `SMITHERS_BACKEND=sqlite`
keeps a filename on SQLite even when `SMITHERS_POSTGRES_URL` is set.
[SQLite and PostgreSQL](../database/docs/concepts/sqlite-only.md) covers the
schema each store gets and the role permissions the adapter needs.

## Next step

Stand a durable runtime up and run a flow on it in the
[Quickstart](./quickstart.md).

## Bun durable execution

```bash
bun add @smthrs/flows@next effect @smthrs/platform-bun@next
```

`@smthrs/platform-bun` carries its own copy of the Effect Bun and Node platform
adapters, and the Bun database opens `bun:sqlite` itself, so a Bun program adds
no `@effect/*` package of its own.

Then import `BunRuntime` from `@smthrs/platform-bun`. Its `layerHost`, `layer`,
`make` and `storage` compositions share the engine with Node's `NodeRuntime`. See
[runtime portability](./concepts/runtime-portability.md).
