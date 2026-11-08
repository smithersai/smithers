---
title: "Installation"
description: "Install @smthrs/plan-store, satisfy its peer requirements, and add the driver packages a persisting composition needs."
sidebar:
  order: 1
---

## Requirements

- Node.js 22.19.0 or later.
- `effect` `4.1.1`. The package's schemas, layers, and error classes are
  Effect values, so it uses the one `effect` your application installs.

## Install

```bash
npm install @smthrs/plan-store@next effect
```

The `next` tag carries the 1.0 release candidates.

The store writes to SQL, so a composition also needs the SQLite client, the
durable writer, and Effect's `Crypto` service:

```bash
npm install @effect/platform-node @effect/platform-node-shared @effect/sql-sqlite-node
```

[`@smthrs/plan`](/api/plan), [`@smthrs/database`](/api/database) and
[`@smthrs/keys`](/api/keys) arrive as dependencies of this package; you do not
install them yourself unless you use them directly. Compiling the plans you
record is `@smthrs/plan`, which performs no I/O at all.

## Import forms

The root entry point re-exports both modules as namespaces:

```ts
import { Migrations, PlanStore } from "@smthrs/plan-store"
```

Each module is also its own entry point. Prefer this form: it keeps a bundle to
the modules you actually reach for.

```ts
import * as Migrations from "@smthrs/plan-store/Migrations"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
```

Both forms resolve to the same values.

## What you cannot import

The ordered migration steps live under `src/internal/migrations`, and the
export map blocks that prefix. `@smthrs/plan-store/Migrations` is the only way
to reach them.

```ts
import * as Migrations from "@smthrs/plan-store/Migrations"
// Migrations.set is the namespaced set; the steps inside it are not addressable.
```

A step imported on its own would run outside the namespaced ordering that
[`@smthrs/database`](/api/database)'s migrator relies on to decide what has
already been applied. Node reports `ERR_PACKAGE_PATH_NOT_EXPORTED` for the
internal path, and `ERR_MODULE_NOT_FOUND` for the path the steps shipped from
before 1.0.

## Browser support

The package is browser-safe: it resolves no `node:` built-in and names no
database driver, exactly as [`@smthrs/database`](/api/database) does. Choosing
a driver, such as `@smthrs/database/node/NodeDatabase`, is where a platform
choice enters.

## Next

[Quickstart](./quickstart.md) records a plan, appends a generation, and reads
the whole graph back.
