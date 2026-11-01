---
title: "Installation"
description: "How to install @smthrs/step-cache, what it requires at runtime, the import forms it publishes, and the database driver and HTTP client a runnable composition adds."
sidebar:
  order: 1
---

## Install the package

```bash
npm install @smthrs/step-cache@next effect
```

The `next` tag carries the 1.0 release candidates.

## Requirements

- Node.js 22.19.0 or later.
- [`effect`](https://effect.website) `4.1.0`, which supplies the `Effect`,
  `Schema`, `Layer`, `Metric`, and SQL client types this package's signatures
  use.
- [`@smthrs/canonical`](/api/canonical) for RFC 8785 JSON and
  [`@smthrs/database`](/api/database) for the driver-neutral write boundary.
  Both resolve with the package. Declare `@smthrs/database` yourself only when
  you import a driver from it, as a durable composition does below.

The build ships both ESM and CommonJS with TypeScript declarations.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { CacheStore, CacheStoreMetrics, CombinedCacheStore, Migrations, RemoteCacheStore } from "@smthrs/step-cache"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Migrations from "@smthrs/step-cache/Migrations"
```

Three subpath forms are not public and are blocked in the export map:
`@smthrs/step-cache/internal/*`, `@smthrs/step-cache/migrations/*`, and
`@smthrs/step-cache/*/index`. The migration implementations are private on
purpose: only `Migrations.set` composes them.
`@smthrs/step-cache/package.json` is exported.

## Node and the browser

The root entry point is written against the `@smthrs/database` service contract
and names no driver, so it bundles for the browser. Only two things bind a
platform:

- `@smthrs/step-cache/test/TestCacheStore` binds a Node SQLite database, which
  is why it lives at its own subpath rather than in the root namespace set.
- A production composition supplies its own driver layer, and that layer
  chooses the platform.

## What a runnable composition adds

`CacheStore.layer` requires two services from
[`@smthrs/database`](/api/database): Effect's `SqlClient` and the
`DurableWriter` write boundary. Building them means importing that package
directly, so declare it too:

```bash
npm install @smthrs/database@next
```

On Node:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Layer from "effect/Layer"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "flows.sqlite" })
)
```

`NodeDatabase.layer` provides the SQL client and nothing else;
`DurableWriter.layer` adds the write policy above it. Composing the store on
top of that pair is [compose a durable step cache](./guides/compose-a-store.md).

A composition that also reaches a shared tier adds an `HttpClient`
implementation, which `RemoteCacheStore` requires. `FetchHttpClient.layer` from
`effect/http/FetchHttpClient` is the usual one.

Most hosts never build this composition by hand.
[`@smthrs/engine-store`](/api/engine-store) already composes the step cache,
the journal, and the run store into one durable engine, and
`Migrations.sets` there installs every table in dependency order.

## Next step

Record a result and read it back in the [Quickstart](./quickstart.md).
