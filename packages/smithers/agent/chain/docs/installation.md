---
title: "Installation"
description: "Use @smthrs/chain from a checkout of the Smithers repository, and the services a run needs."
sidebar:
  order: 1
---

## Requirements

- Node.js 26.4.0 or later, from the package's `engines` field.
- [Effect](https://effect.website) 4.1.1. The package depends on it
  directly, so installing the package brings it along; every code sample on
  this site imports `Effect` and `Layer` from `effect`.

## Install the package

`@smthrs/chain` is not published to npm. It is developed in the
[Smithers repository](https://github.com/smithersai/smithers) and is used
from a checkout of it, where it resolves as a workspace dependency.

## Import paths

The barrel export and the wildcard subpath reach the same modules, so these
two imports name the same namespace:

```ts
import { Catalog } from "@smthrs/chain"
import * as Catalog from "@smthrs/chain/Catalog"
```

`./internal/*` is null-mapped in the export map and carries no promise.

## The services a run needs

`Chain.run` requires five services in its environment, and picks up one
optional seam when it is mounted:

| Service                     | Layer you mount                                                      | Required |
| --------------------------- | -------------------------------------------------------------------- | -------- |
| `Journal.Journal`           | `Journal.layerMemory()` or a durable journal of your own             | Yes      |
| `Catalog.Catalog`           | `Catalog.layer(entries)` or a composed catalog                       | Yes      |
| `Author.Author`             | `ModelAuthor.layer(config)` over the durable `ModelAuthor.Step` port | Yes      |
| `ScriptRunner.ScriptRunner` | `QuickJsRunner.layer()` (production)                                 | Yes      |
| `Authorize.Authorize`       | `Authorize.layerRules(rules)`, or `Authorize.layerAllowAll` by name  | Yes      |
| `Steering.Steering`         | `Steering.layerMemory()` or a durable queue                          | Optional |

The authorization seam fails closed: a chain composed without it does not
compile. A host that enforces policy elsewhere mounts
`Authorize.layerAllowAll` and says so.

Two layers in this table can fail while they are being built, before any run
starts: `QuickJsRunner.layer()` fails with a `ScriptFailure` whose code is
`runner_unavailable` when the QuickJS WebAssembly module cannot load, and a
catalog layer such as `SubChains.layer` dies at construction when the host's
entries shadow reserved names. For the failure taxonomy, see
[Troubleshooting](./troubleshooting.md).

`ModelAuthor.layer(config)` needs the `ModelAuthor.Step` port: one model call
run as a durable step. A production host binds it to its durable engine
(`ModelStep.run` from `@smthrs/agent`), which retries a transient provider
failure and seals the answer a resumed run replays.
`ModelAuthor.layerStepUnsealed` binds it straight to a `Model.Model` from the
[@smthrs/model package](/api/model) for tests and replay models. Provide the
step layer UNDER the author layer with `Layer.provide`, not beside it in
`Layer.mergeAll`: siblings in one `mergeAll` cannot satisfy each other. The
[Quickstart](./quickstart.md#7-drive-it-with-a-model) shows the full
composition, including the `Prompt.forCatalog` prefix a model-backed run
must pass to `Chain.run`.
