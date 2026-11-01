---
title: "Installation"
description: "The packages a Cloudflare flow host needs, the Worker's compatibility flags, and the database the engine writes to."
---

## Install the package

```bash
npm install @smthrs/platform-cloudflare@next @smthrs/flow@next @smthrs/database@next @effect/sql-pg@4.1.0 effect@4.1.0
```

- `@smthrs/flow` declares the flows and actions the object runs.
- `@smthrs/database` provides `PostgresDatabase.layer`, the engine's
  `SqlClient`. It is correct behind a transaction-pooling proxy such as
  Hyperdrive: it sets the schema inside every transaction and changes no
  session state.
- `@effect/sql-pg` is the socket driver `PostgresDatabase.layer` takes as its
  `driver` option.
- `effect` is a peer dependency at exactly `4.1.0`. Two copies of `effect` in
  one program are two sets of service tags.

Import from the package root only:

```ts
import { CloudflareHost, CloudflareRuntime, ExecutionObject } from "@smthrs/platform-cloudflare"
```

## Configure the Worker

The Worker that hosts the Durable Object needs the `nodejs_compat`
compatibility flag, because `@effect/sql-pg` opens its socket with `node:net`.
Nothing in this package imports a `node:` built-in or a `cloudflare:` module;
the flag is for the driver.

The object uses its key-value storage and its alarm, nothing else, so either
storage backend serves. It stores two keys, `ExecutionObject.intentKey` and
`ExecutionObject.failuresKey`; keep your own keys apart from them, and do not
schedule anything else on the object's one alarm.

## Prepare the database

The engine writes its journal, runs, attempts and timers to Postgres, in the
schema you pass to `PostgresDatabase.layer` (`smithers_flows` by convention).
Building the runtime applies the engine's migrations to that schema if they are
missing, so the first alarm after a deploy that adds a migration applies it.

Through Hyperdrive, turn the query cache off: a resumed run must read the rows
the previous incarnation wrote a moment ago.
