---
title: "Installation"
description: "Install @smthrs/kernel, its runtime requirements, its public subpaths, and the platform and journal packages a working host composition adds."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/kernel/docs/installation.md"
---

## Get the package

`@smthrs/kernel` is not on npm at 1.0.0-rc.0. It ships as a member of the
[smithers repository](https://github.com/smithersai/smithers) workspace, so
using it today means working from a checkout:

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
```

Code that consumes it lives in that workspace too, either an existing package
or one you add under `packages/`, and depends on it with a workspace specifier:

```json
{
  "dependencies": {
    "@smthrs/kernel": "workspace:*"
  }
}
```

## Requirements

The package requires Node.js 22.19.0 or later and ships as ESM, CommonJS, and
TypeScript declarations. Its Smithers dependencies install with it:
[`@smthrs/capability`](https://capability.smithers.sh/reference/api/), [`@smthrs/jj`](https://jj.smithers.sh/reference/api/), and
[`@smthrs/journal`](https://journal.smithers.sh/reference/api/). The host supplies the exact
`effect@4.0.0-rc.115` peer so the library never installs a second runtime.

The root entry point carries no Node built-ins. A package test bundles the
whole root dependency graph for the browser and asserts that no
`node:child_process`, `node:fs`, `node:path`, or `node:process` import
survives, so the kernel itself runs anywhere its host does.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Capability, CapabilitySet, GrantStore, HostServices, Permission, Workspace } from "@smthrs/kernel"
```

Each module is also importable from its own subpath, which is the form the
API reference uses:

```ts
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
```

`Capability` and `Permission` are re-exports. Their modules live in
[`@smthrs/capability`](https://capability.smithers.sh/reference/api/), so their deep import paths are
`@smthrs/capability/Capability` and `@smthrs/capability/Permission`.

Two subpath shapes are blocked in the export map: `@smthrs/kernel/internal/*`
and `@smthrs/kernel/*/index`. `@smthrs/kernel/package.json` is exported.

## Test subpaths

Two helpers ship for testing. They are published code, not dev-only files;
`test/HostContract` is an alias for `test/contract`:

| Subpath                              | What it gives you                                                                 | Platform |
| ------------------------------------ | --------------------------------------------------------------------------------- | -------- |
| `@smthrs/kernel/test/TestGrantStore` | `layerAllow`, `layerDeny`, and `layerScripted` grant-store doubles.               | any      |
| `@smthrs/kernel/test/contract`       | `runHostContract`, the shared behavioral contract every host bundle must satisfy. | Node.js  |

`test/contract` is Node-only because it uses Node process and
temporary-directory fixtures. The deterministic host bundle is published by
`@smthrs/testing/TestHost`; keeping it with the other test utilities avoids a
kernel-to-platform dependency cycle. To use that host, add a devDependency
in the consuming workspace package:

```json
{
  "devDependencies": {
    "@smthrs/testing": "workspace:*"
  }
}
```

`test/contract` registers Vitest cases, so importing it requires the declared
peers, `@effect/vitest@4.0.0-rc.115` and `vitest@5.0.0`. Both are optional: a
consumer that imports only the kernel or `test/TestGrantStore` needs neither.
See [Testing](/testing/) for what each one covers.

## What a working host adds

The kernel holds no platform implementations. It decorates ports that
something else provides, so a composition that actually reaches a machine adds
a platform bundle:

- [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) implements the five ports on
  Node, attaches the descriptor-relative filesystem executor the kernel
  requires, and ships the process reaper that retires orphaned records.
- [`@smthrs/platform-bun`](https://platform-bun.smithers.sh/reference/api/) and
  [`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/) implement the same
  ports for Bun and for the browser.
- [`@smthrs/journal`](https://journal.smithers.sh/reference/api/) is already a dependency, but a host only
  needs a live `Journal` service when it uses `JournalGrantStore` or the
  durable `ProcessLedger`.

## Next step

Guard a host and watch a call get refused in the
[Quickstart](/quickstart/).
