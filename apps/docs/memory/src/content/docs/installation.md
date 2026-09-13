---
title: "Installation"
description: "Install @smthrs/memory, its runtime requirements, and the packages you add for production wiring."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/memory/docs/installation.md"
---

## Availability

The `1.0.0-rc.0` release this site documents is not on the npm registry yet.
The `0.x` versions published under this name are the previous generation of the
package and have a different API. Until the release candidate publishes, use
`@smthrs/memory` from a checkout of the
[Smithers repository](https://github.com/smithersai/smithers), where it resolves
as a workspace dependency:

```json
{
  "dependencies": {
    "@smthrs/memory": "workspace:*"
  }
}
```

When it publishes, the install is one command:

```bash
pnpm add @smthrs/memory@next effect@4.0.0-rc.115
```

## Requirements

- Node.js 22.19.0 or later. The package's `engines` field enforces this floor.
- [Effect](https://effect.website) 4.0.0-rc.115, exactly. It is a peer
  dependency so the application and Smithers share one Effect runtime.

The package ships as ESM and CommonJS with TypeScript declarations. Its
Smithers dependencies (`@smthrs/core`, `@smthrs/database`,
`@smthrs/patterns`) install with it; the host owns the shared `effect` peer.

## Packages you add for production wiring

The `TestMemory` layer uses a real in-memory SQLite database. Add its optional
Node driver before following the quickstart:

```bash
pnpm add @effect/sql-sqlite-node@4.0.0-rc.115
```

A store backed by a database file needs the database package and its selected
Node adapters:

```bash
pnpm add @smthrs/database@1.0.0-rc.0 @effect/platform-node@4.0.0-rc.115 @effect/sql-sqlite-node@4.0.0-rc.115
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

The [Quickstart](/quickstart/) wires both forms. For the import forms the package publishes (root namespaces, per-module subpaths, the test layer), see [Import surface](/surface/).
