---
title: "Quickstart"
description: "Create a SQLite file, declare a migration set, run it, and write through the durable boundary: one end-to-end program that leaves a migrated database on disk."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/database/docs/quickstart.md"
---

This quickstart builds a small durable store from nothing: one table, one
migration set, one write through `DurableWriter`, and one read back. When it
finishes you have a SQLite file with your table, a `flows_migrations` ledger
recording what was applied, and a program that is safe to run again.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with `@smthrs/database`, `effect`, and `@effect/sql-sqlite-node`
  resolved. See [Installation](/installation/), which also covers where the
  package comes from while it is unpublished.

## Declare the migration

A migration is an ordinary `Effect` that requires `SqlClient` and returns
nothing. Nothing about it is special: it runs inside the migrator's
transaction, so a failure rolls the whole pass back.

Create `quickstart.ts`:

```ts
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const createNotes: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)`
})
```

## Declare the migration set

A `MigrationSet` is the unit the composer takes. It carries a `namespace` that
prefixes every migration name, an `idOffset` that reserves a block of global
migration ids, and the migrations themselves keyed as `<localId>_<name>`:

```ts
import * as Migrations from "@smthrs/database/Migrations"

const notes: Migrations.MigrationSet = {
  namespace: "notes",
  idOffset: 0,
  migrations: { "0001_initial": createNotes }
}
```

Local id `0001` plus offset `0` is global id `1`, and the ledger records it as
`notes_initial`. A second package that also ships an `0001_initial` picks a
different offset and lands somewhere else entirely, which is the whole point of
the scheme. See [the migration ladder](/concepts/migration-ladder/).

## Compose the layers

Three layers stack in a fixed order. The driver provides the SQL client, the
writer adds the transaction policy over that client, and the migration layer
runs before anything is allowed to read the database:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Layer from "effect/Layer"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "notes.sqlite" })
)

const layer = Layer.provideMerge(Migrations.layer([notes]), database)
```

`Layer.provideMerge` keeps the client and the writer in the output, so the
program below can ask for both.

## Write and read

Writes go through `writer.write`. Reads use the `SqlClient` directly, because
this package adds policy to writes only:

```ts
const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter.DurableWriter
  yield* writer.write(sql`INSERT INTO notes (id, body) VALUES ('first', 'hello')`)
  return yield* sql<{ readonly body: string }>`SELECT body FROM notes ORDER BY id`
})

const main = program.pipe(Effect.provide(layer), Effect.scoped)

Effect.runPromise(main).then(console.log)
```

`Effect.scoped` is required: the client layer holds an open connection for the
lifetime of a scope, and closing the scope closes the database.

Run the file with your TypeScript runner. The output is the row you inserted:

```text
[ { body: 'hello' } ]
```

## Prove the migration is recorded

Run the same file a second time. The insert fails on the primary key, which is
the correct outcome: a `constraint` failure is never retried, because replaying
it cannot change the answer. The migration, on the other hand, does not run
again. Read the ledger to see why:

```ts
const applied = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<{
    readonly migration_id: number
    readonly name: string
  }>`SELECT migration_id, name FROM ${sql(Migrations.table)} ORDER BY migration_id`
})
```

```text
[ { migration_id: 1, name: 'notes_initial' } ]
```

`Migrations.run` returns the same pairs for the migrations it applied on this
pass, so a second pass returns an empty array.

## Count what a write changed

A compare-and-swap needs to know whether its statement matched a row. Read the
count out of the driver's raw result rather than casting to a driver-specific
shape:

```ts
const deleted = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter.DurableWriter
  return yield* writer.write(
    sql`DELETE FROM notes WHERE id = ${"first"}`.raw.pipe(Effect.flatMap(DurableWriter.affectedRows))
  )
})
```

The delete that matches the row answers `1`, and the same delete run again
answers `0`. See
[Read a write's affected-row count](/guides/count-affected-rows/).

## What just happened

The migration layer opened a transaction, created `flows_migrations`, resolved
your set into global id `1`, applied it, and recorded it. The write ran inside
its own transaction under a retry policy that replays a lock conflict and
refuses to replay a constraint violation. Both behaviors are contract, not
driver detail: see [the write boundary](/concepts/write-boundary/).

## Next steps

- [Compose a database layer](/guides/compose-a-database/): the same wiring
  with the storage packages a real engine needs.
- [Add a migration](/guides/add-a-migration/): the rules a second migration
  must satisfy, and the one that bites.
- [Test against a database](/guides/test-against-a-database/): the in-memory
  layer and the deterministic retry clock.
