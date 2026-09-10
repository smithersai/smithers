---
title: "Installation"
description: "Install @smthrs/time-travel, the five services TimeTravel.layer requires, the import forms, and the packages a runnable composition adds."
sidebar:
  order: 1
---

## Install the package

`@smthrs/time-travel` is at `1.0.0-rc.0` and has not reached npm yet. When it
does, the release candidate publishes under the `next` tag, which is what this
command selects; the plain package name still resolves to the older `0.x` line,
a different API.

```bash
pnpm add @smthrs/time-travel@next
```

The package requires Node.js 22.19.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. Its runtime dependencies install with
it: [`effect`](https://effect.website) and the `@smthrs/*` packages whose
contracts it reads history through.

## What the layer requires

`TimeTravel.layer` asks for five injectable contracts and nothing else. Four of
them are the services a durable engine already provides, so the layer merges
straight onto an engine composition:

| Service           | From                                    | What time travel does with it                                                        |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| `TimeTravelStore` | this package                            | Reads anchors, state, attempts, and descendants at a frame; writes audits and forks. |
| `Journal`         | [`@smthrs/journal`](/api/journal)       | Pages the entries every fold and every assessment reads.                             |
| `RunStore`        | [`@smthrs/run-store`](/api/run-store)   | Claims the run a rewind holds, and answers whether a parent or child is still live.  |
| `CacheStore`      | [`@smthrs/step-cache`](/api/step-cache) | Reads the sealed results a replay folds in and a fork inherits.                      |
| `Jj`              | [`@smthrs/jj`](/api/jj)                 | Provisions a fork's workspace and restores a rewound one.                            |

The store is the only contract this package defines. Pick an implementation
with [Provide a store](./guides/provide-a-store.md): `MemoryTimeTravelStore`
for tests and browser use, `SqlTimeTravelStore` for a durable database.

Building the layer is scoped, and the scope owns every fork workspace the
service adds: a fork lane is forgotten when the service is released, not when
the call that created it returns.

## Import forms

The root entry point exports the service key flat and everything else as a
namespace:

```ts
import { CompensationHandlers, EffectBoundary, Frame, TimeTravel } from "@smthrs/time-travel"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as EffectBoundary from "@smthrs/time-travel/EffectBoundary"
import * as SqlTimeTravelStore from "@smthrs/time-travel/SqlTimeTravelStore"
```

Two subpath forms are not public: `@smthrs/time-travel/internal/*` and
`@smthrs/time-travel/*/index`. Both are mapped to `null` in the package's
export map, because `Replay`, `Fork`, `Rewind`, `Recovery`, `Compensation`,
`SnapshotProjector`, `HistoryLimit`, and `EffectHandlerRegistry` are machinery
a caller never names.
`@smthrs/time-travel/package.json` is exported.

The root entry point is a browser contract: it bundles with no `node:` built-in,
including `SqlTimeTravelStore`, which needs a SQLite-speaking `SqlClient` rather
than a Node binding.

## Reaching the service through the umbrella

A composition that already installs [`@smthrs/flows`](/api/flows) reaches the
same service key through it, with no second dependency:

```ts
import { Engine, TimeTravel } from "@smthrs/flows"
```

`TimeTravel` is a service key rather than a namespace, so `yield* TimeTravel`
is the whole onboarding and `TimeTravel.layer` provides it. The umbrella is
also where a caller reaches `Engine.FlowEngine.Lineage`, the one constructor
that mints the lineage id a frame is addressed by.

## What a runnable composition adds

Time travel reads a journal the engine wrote, so a composition that produces
history adds the engine and the storage under it:

```bash
pnpm add @smthrs/engine@next @smthrs/engine-store@next @smthrs/flow@next @smthrs/database@next @effect/platform-node@4.0.0-rc.112 effect@4.0.0-rc.112 @effect/sql-sqlite-node@4.0.0-rc.112
```

- [`@smthrs/engine`](/api/engine) is the durable engine a run executes on, and
  the home of `FlowEngine.Lineage`.
- [`@smthrs/engine-store`](/api/engine-store) is the producer of everything the
  service reads. It stamps `meta.lineageId` on every record, journals an
  anchor per attempt, and writes effect-boundary records around an irreversible
  dispatch and a child spawn.
- [`@smthrs/flow`](/api/flow) is the flow and action authoring model.
- [`@smthrs/database`](/api/database) is the driver-neutral SQL contract
  `SqlTimeTravelStore` writes through.

For the durable schema, run `Migrations.run` from this package rather than
letting the store create its own tables. See
[Provide a store](./guides/provide-a-store.md).

## Next step

Execute a durable run and replay it in the [Quickstart](./quickstart.md).
