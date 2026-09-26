---
title: "The migration ladder"
description: "How several packages migrate one database without colliding: namespaced sets, reserved id blocks, the migrator's single high-water mark, and the two skips the loader refuses to perform."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/database/docs/concepts/migration-ladder.md"
---

Every storage package above `@smthrs/database` owns its own tables and
therefore its own migrations. They all migrate one database and record their
progress in one `flows_migrations` table. That is the whole problem this module
solves.

Effect's `Migrator` keys a migration by a numeric id. Two packages that both
ship an `0001_initial` would either collide on id 1 or, if their records were
merged, silently shadow one another: one table would never be created and the
migration would still report success.

## Namespace plus block equals identity

A `MigrationSet` makes the package part of the identity:

```ts
import * as Migrations from "@smthrs/database/Migrations"

export const set: Migrations.MigrationSet = {
  namespace: "step-cache",
  idOffset: Migrations.idBlock * 2,
  migrations: { "0001_initial": initial }
}
```

- `namespace` prefixes every migration name in the ledger, so id `2001` is
  recorded as `step-cache_initial`.
- `idOffset` lifts the set's local ids into the block it reserves. `idBlock` is
  `1000`, so a package may ship 1000 migrations before it would reach its
  neighbour, and the loader fails loudly if one ever does.
- Each key is `<localId>_<name>`, exactly as `Migrator.fromRecord` keys it,
  with the id local to the package.

These are the blocks the shipped packages reserve:

| Package                                     | Namespace      | Offset        | First migration id |
| ------------------------------------------- | -------------- | ------------- | ------------------ |
| [`@smthrs/journal`](https://journal.smithers.sh/reference/api/)           | `journal`      | `0`           | `1`                |
| [`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/)       | `run-store`    | `idBlock`     | `1001`             |
| [`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/)     | `step-cache`   | `idBlock * 2` | `2001`             |
| [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) | `engine-store` | `idBlock * 3` | `3001`             |
| [`@smthrs/plan`](https://plan.smithers.sh/reference/api/)                 | `plan`         | `idBlock * 4` | `4001`             |
| [`@smthrs/time-travel`](https://time-travel.smithers.sh/reference/api/)   | `time-travel`  | `idBlock * 5` | `5001`             |
| [`@smthrs/control`](https://control.smithers.sh/reference/api/)           | `control`      | `idBlock * 6` | `6001`             |
| [`@smthrs/memory`](https://memory.smithers.sh/reference/api/)             | `memory`       | `idBlock * 7` | `7001`             |
| [`@smthrs/integrations`](https://integrations.smithers.sh/reference/api/) | `integrations` | `idBlock * 8` | `8001`             |

Offsets must be unique among the sets composed into one database. Integration
cursors can share the control database, so integrations reserves its own
block after control and memory. It can also migrate a standalone cursor
database with that same set.

`@smthrs/engine-store` exports `Migrations.sets`, the journal, run store, step
cache, engine store, and plan sets together, which is the full durable schema an
engine needs.

## The loader rejects what the migrator would swallow

`loader(sets)` resolves the sets into one list ordered by global id, and fails
the migration rather than returning a list that would quietly lose a table. It
rejects a duplicate namespace, a duplicate offset, an offset that is not a
non-negative safe integer aligned to `idBlock`, a malformed key, a local id at
or above `idBlock`, and two keys in one set that realize the same id
(`0001_first` beside `01_second`).

Every one of those is a mis-declaration a developer can fix. The next one is
subtler.

## The high-water mark, and the skip it hides

`Migrator` records applied migrations but decides what to run from a single
high-water mark: anything with an id at or below the highest applied id is
assumed done. Blocks make that assumption false.

Migrate a database with the `2000` block alone, then compose every set, and the
`0` and `1000` blocks sit below the mark. The migrator assumes them applied,
never creates their tables, and reports success. Nothing about running the
migration again repairs it.

So the loader refuses:

```text
Migration 1_alpha_initial would be skipped: the database has already applied migration id 1001, and this is not a forward append in a declared, installed package block. Compose each installed package's recorded migrations when appending to its block; introduce new packages above 1001.
```

Installed blocks can accept migrations below the global cursor under the
[forward-append rule](/guides/add-a-migration/#3-append-within-the-packages-existing-block).

## Global id zero

Id zero is the one skip that is legitimate work. A fresh database has
high-water mark zero, so id zero always sits at or below it and `Migrator` can
never run it. The loader applies it itself, inside the migrator's transaction,
and records it in `flows_migrations` like any other migration.

Two consequences follow. `run(sets)` reports id zero in its completed list;
a caller who wires `loader` into its own `Migrator` gets id zero applied but
not reported. And a failing id-zero migration rolls back with the rest of the
pass, reported as a `Failed` `MigrationError` named `0_<namespace>_<name>`.

## Ordering and concurrency

`run(sets)` applies the composed sets in id order, not in the order the sets
were given, so the array's order is documentation rather than behavior.

The whole migrator pass, the `BEGIN IMMEDIATE`, the loader, and the pending
migrations, is wrapped in the same transient-lock retry the durable writer
uses. Two processes migrating one SQLite file therefore serialize: the loser of
the write-lock race replays after the winner commits, finds the migrations
applied, and reports an empty list instead of surfacing `SQLITE_BUSY` or
applying anything twice.

A migration plan is snapshotted when `run`, `layer`, or `loader` is called, so
mutating the record afterwards cannot change a pass already under way.

## A verified historical name

Migration names are persisted identities. Changing SQL requires a new id. If
an earlier release used another name for the same schema, the owning package
can declare `previousNames: { "0002_current": ["earlier_name"] }` on its
`MigrationSet`, after verifying that historical implementation. Names omit the
namespace; acceptance is scoped to that package and the exact numeric id.
Unknown names still fail. Existing ledger names and data remain unchanged,
the migration is not rerun, and fresh databases record the current name.
Alias keys and arrays are captured with the migration plan.
