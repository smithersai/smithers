---
title: "Add a migration"
description: "Add a migration to a package's set: where the file goes, how it is keyed, why it must never be a default export, and the one rule that decides whether an existing database can accept it."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/database/docs/guides/add-a-migration.md"
---

A migration is an `Effect<void, unknown, SqlClient>` that a `MigrationSet`
names. Adding one is four steps, and the fourth is where the whole design shows
its teeth.

## 1. Write the migration

Put each migration in its own file under your package, and export it by name.
Keep them under `src/internal/migrations/`, one file per migration, named for
the key that references it. That is the layout the Smithers storage packages
use:

```ts
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_selection_suspected_edges` table.
 *
 * @category migrations
 * @since 0.1.0
 */
export const selectionStore: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE flows_selection_suspected_edges (
    scope TEXT NOT NULL CHECK (length(scope) > 0),
    affects TEXT NOT NULL CHECK (length(affects) > 0),
    PRIMARY KEY (scope, affects)
  )`
})
```

Use a named export, never a default export. A default export compiles to
`exports.default` in the CommonJS build, and Node's interop then hands a
default import the whole exports object instead of the Effect, so the set holds
an object with no `pipe` and the migration never runs.

Keep the migration steps out of the package's export map, under `internal/`,
so the set is the only way to reach them. A step imported on its own runs
outside the namespaced ordering the composer relies on.

## 2. Add it to the set

Keys are `<localId>_<name>`, with the id local to your package and below
`idBlock` (1000). Add the next id in sequence:

```ts
import * as Migrations from "@smthrs/database/Migrations"
import { initial } from "./migrations/0001_initial.ts"
import { selectionStore } from "./migrations/0002_selection_store.ts"

export const set: Migrations.MigrationSet = {
  namespace: "engine-store",
  idOffset: Migrations.idBlock * 3,
  migrations: {
    "0001_initial": initial,
    "0002_selection_store": selectionStore
  }
}
```

Zero padding is cosmetic: the loader parses the digits. Two keys that parse to
the same number are rejected, so `0002_a` beside `02_b` fails with
`Migration id 3002 is claimed twice`.

## 3. Append within the package's existing block

A migration's global id is `idOffset + localId`. For an installed package,
choose a local id greater than every id already applied in that package's
block. Keep its earlier migration identities in the set. Each installed block
with pending work must declare at least one matching recorded migration, even
when the append is above the global cursor. The loader also checks every
declared recorded id for a matching name before applying pending work.

The underlying Effect migrator uses one global high-water mark. Smithers
handles forward additions in lower installed blocks inside that same database
transaction, records their ids, and reports them alongside the ordinary
forward pass. A journal migration at id 3 can therefore follow an already
installed plan migration at id 4003 without renumbering either package.

Earlier holes remain errors: inserting id 2 after this package has applied id
3 is refused. Introducing a completely new lower block after higher packages
have run is also refused. A new package still reserves a higher unused block.
This prevents an omitted dependency from being silently treated as installed.
A different namespace cannot take over an installed block by changing its
recorded names or supplying only a new id.

Inspect the package's applied range before choosing an id:

```sql
SELECT migration_id, name FROM flows_migrations
WHERE migration_id >= 1000 AND migration_id < 2000
ORDER BY migration_id;
```

All appended migrations and their ledger rows commit together. A failed
append rolls back the whole migration pass; retrying executes the missing
work and never reports a rolled-back migration as completed.

## 4. Prove it

Migrations are ordinary code and take ordinary tests. Run the set against a
fresh in-memory database, twice, and assert on both the tables and the ledger:

```ts
import { describe, expect, it } from "@effect/vitest"
import * as Migrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

describe("migrations", () => {
  it.effect("creates every table and reruns idempotently", () =>
    Effect.gen(function*() {
      const first = yield* Migrations.run([set])
      const second = yield* Migrations.run([set])
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `
      expect(first).toHaveLength(2)
      expect(second).toEqual([])
      expect(tables.map((row) => row.name)).toContain("flows_selection_suspected_edges")
    }).pipe(Effect.provide(TestDatabase.layer)))
})
```

Assert the block too, so a mis-declared offset fails a test rather than a
deployment: the offset is a multiple of `idBlock`, no set composed beside it
claims the same offset, and every local id is below `idBlock`.

## What a failed migration leaves behind

Nothing. The pass runs in one transaction, so a migration that fails takes the
partial DDL and the ledger rows with it, and rerunning the corrected set
applies the whole sequence from the start. Test that if the migration is
consequential: apply a broken version, assert that neither the table nor the
record survives, then apply the corrected one and assert both do.

An interrupted pass behaves the same way. Only the id-zero migration has a
reporting quirk: `run` reports it, a hand-wired `loader` applies it without
reporting it.

## Reserving a new block

A package that owns tables and has no set yet declares one. Pick the next
multiple of `idBlock` above every block composed into the same database:

```ts
export const set: Migrations.MigrationSet = {
  namespace: "my-package",
  idOffset: Migrations.idBlock * 9,
  migrations: { "0001_initial": initial }
}
```

The blocks already reserved are listed in
[the migration ladder](/concepts/migration-ladder/). Offsets need only be
unique among the sets composed into one database, so a package that migrates a
database of its own may reuse a number another package uses elsewhere.
