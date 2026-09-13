---
title: "Installation"
description: "How to get @smthrs/harness, the runtimes it supports, the entry points its exports map publishes, and the effect version it pins."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/harness/docs/installation.md"
---

## Get the package

`@smthrs/harness` is not published to npm at 1.0.0-rc.0, so
`pnpm add @smthrs/harness` does not resolve. Its source lives in the
[smithers repository](https://github.com/smithersai/smithers). Clone that
repository, install its dependencies, and declare the package where you need
it:

```json
{
  "dependencies": {
    "@smthrs/harness": "workspace:*"
  }
}
```

## Requirements

- Node.js 22.19+ (Node 22) or 24.11+ for the Node runtime, matching the package's
  `engines` field.
- [`effect`](https://effect.website) 4.0.0-rc.115, as an exact peer
  dependency. Pin the same version in the consuming project, so the service
  tags and schemas this package exports are the same class instances the
  project constructs.
- A browser runtime works unchanged: the QuickJS binding compiles the same
  single-file WebAssembly build on Node and in a browser.
- Cloudflare workerd works through the build-naming seam, because workerd
  runs no WebAssembly it did not compile itself. For the setup, see
  [Run on Cloudflare workerd](/guides/workerd/).

## Entry points

The `exports` map publishes these subpaths:

| Import                           | What it is                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/harness`                | The root barrel: 26 namespaces, each re-exporting one module.                                                                                                        |
| `@smthrs/harness/<Module>`       | Any top-level module directly, for example `@smthrs/harness/CellTurn`.                                                                                               |
| `@smthrs/harness/QuickJSSandbox` | The QuickJS-WASM `Sandbox` binding. Deliberately not re-exported from the root, because it carries an embedded WebAssembly build; only hosts that want it import it. |
| `@smthrs/harness/package.json`   | The package manifest.                                                                                                                                                |

The `./internal/*` and `./*/index` subpaths map to `null` and do not resolve.
Nothing under `src/internal/` is public.

## The namespaces on the root

Every namespace on the root barrel is also importable from its own subpath.
The complete list, with what each one is for, is the
[module index](/reference/api/#module-index) of the API reference.

## Compose the rest of a host

`@smthrs/harness` is translation, not assembly. A running agent also needs a
durable engine behind `EngineLike`, a registry behind `CellCalls`, and a model
provider behind `EngineLike.sealStep`. The production composition of all three
lives in [`@smthrs/agent`](https://agent.smithers.sh/reference/api/). The request and event shapes the
sealed model step carries belong to [`@smthrs/model`](https://model.smithers.sh/reference/api/), and the
descriptor and registry contracts belong to
[`@smthrs/registry`](https://registry.smithers.sh/reference/api/); those pages document them.

To run a first cell against the QuickJS binding, continue to the
[Quickstart](/quickstart/).
