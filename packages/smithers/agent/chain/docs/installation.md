---
title: "Installation"
description: "Install @smthrs/chain and the services a run needs."
sidebar:
  order: 1
---

## Requirements

- Node.js 22.19.0 or later, from the package's `engines` field.
- [Effect](https://effect.website) 4.0.0-rc.112. The package depends on it
  directly, so installing the package brings it along; every code sample on
  this site imports `Effect` and `Layer` from `effect`.

## Install the package

`@smthrs/chain` is not on the npm registry. It is developed in the
[Smithers repository](https://github.com/smithersai/smithers) and is used
today from a checkout of it, where it resolves as a workspace dependency.
When it publishes, the install is one command:

```bash
pnpm add @smthrs/chain
```

## Import paths

The barrel export and the wildcard subpath reach the same modules, so these
two imports name the same namespace:

```ts
import { Catalog } from "@smthrs/chain"
import * as Catalog from "@smthrs/chain/Catalog"
```

`./internal/*` is null-mapped in the export map and carries no promise.

## The services a run needs

`Chain.run` requires four services in its environment, and picks up two
optional seams when they are mounted:

| Service                     | Layer you mount                                          | Required |
| --------------------------- | -------------------------------------------------------- | -------- |
| `Journal.Journal`           | `Journal.layerMemory()` or a durable journal of your own | Yes      |
| `Catalog.Catalog`           | `Catalog.layer(entries)` or a composed catalog           | Yes      |
| `Author.Author`             | `ModelAuthor.layer(config)` over `Model.Model`           | Yes      |
| `ScriptRunner.ScriptRunner` | `QuickJsRunner.layer()` (production)                     | Yes      |
| `Authorize.Authorize`       | `Authorize.layerRules(rules)`                            | Optional |
| `Steering.Steering`         | `Steering.layerMemory()` or a durable queue              | Optional |

Two layers in this table can fail while they are being built, before any run
starts: `QuickJsRunner.layer()` fails with a `ScriptFailure` whose code is
`runner_unavailable` when the QuickJS WebAssembly module cannot load, and a
catalog layer such as `SubChains.layer` dies at construction when the host's
entries shadow reserved names. For the failure taxonomy, see
[Troubleshooting](./troubleshooting.md).

`ModelAuthor.layer(config)` needs `Model.Model` from the
[@smthrs/model package](/api/model). Provide the model layer UNDER the author
layer with `Layer.provide`, not beside it in `Layer.mergeAll`: siblings in one
`mergeAll` cannot satisfy each other. The
[Quickstart](./quickstart.md#7-drive-it-with-a-model) shows the full
composition, including the `Prompt.forCatalog` prefix a model-backed run
must pass to `Chain.run`.
