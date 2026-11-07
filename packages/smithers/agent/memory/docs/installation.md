---
title: "Installation"
description: "Install @smthrs/memory, its runtime requirements, and the packages you add for production wiring."
sidebar:
  order: 1
---

## Install the package

```bash
npm install @smthrs/memory@next effect
```

The `next` tag carries the 1.0 release candidates. `latest` still carries the
`0.x` line, the previous generation of the package, which has a different API.

## Requirements

- Node.js 22.19.0 or later. The package's `engines` field enforces this floor.
- [Effect](https://effect.website) at exactly `4.1.1`. It is a peer
  dependency so the application and Smithers share one Effect runtime.

The package ships as ESM and CommonJS with TypeScript declarations. Its
Smithers dependencies (`@smthrs/core`, `@smthrs/database`, `@smthrs/flow`,
`@smthrs/patterns`) install with it; the host owns the shared `effect` peer.

## Packages you add for production wiring

The `TestMemory` layer uses a real in-memory SQLite database. Add its optional
Node driver before following the quickstart:

```bash
npm install @effect/sql-sqlite-node
```

A store backed by a database file needs the database package and its selected
Node adapters:

```bash
npm install @smthrs/database@next @effect/platform-node @effect/platform-node-shared @effect/sql-sqlite-node
```

- `@smthrs/database` supplies the SQLite client and the durable writer. It is
  already a dependency of this package, but the quickstart's persistent wiring
  imports `@smthrs/database/node/NodeDatabase` and
  `@smthrs/database/DurableWriter` by name, and a package manager that isolates
  transitive dependencies will not resolve those unless you declare it too.
- `@effect/platform-node` provides `NodeCrypto.layer`, the `Crypto.Crypto`
  service `MemoryStore.layer` requires for generating thread ids.
- `@effect/sql-sqlite-node` is the optional database peer required by
  `@smthrs/database/node/NodeDatabase`.

The [Quickstart](./quickstart.md) wires both forms. For the import forms the package publishes (root namespaces, per-module subpaths, the test layer), see [Import surface](./surface.md).
