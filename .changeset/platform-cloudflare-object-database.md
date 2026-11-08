---
"@smthrs/platform-cloudflare": minor
"@smthrs/database": minor
---

`ObjectDatabase.layer(ctx.storage)` gives `CloudflareRuntime.layer` its `SqlClient` in a SQLite-backed Durable Object's
own storage, through `@effect/sql-sqlite-do`, so a host whose flows start no children needs no database server. Its
transactions and the engine's read transactions run in `storage.transaction()`, which the object's SQLite requires
instead of `BEGIN`. `Dialect.registerReadTransaction(sql, open)` is how such a driver tells `Dialect.readTransaction`
to do that.
