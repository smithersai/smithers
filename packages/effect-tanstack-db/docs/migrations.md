---
title: "Migrations"
description: "Carry a device's stored collections and queued writes from one build of a program to the next: declare each store's versions, bring older rows forward before anything reads them, and fail a test when a schema changes without a new version."
---

A local-first program keeps data on the device that the next build must read:
rows in persisted collections and writes queued in the outbox. `Migrations`
makes each build declare what it stores and how each older shape becomes its
own, and keeps everything it can't bring forward instead of dropping it.

## Declare every store

```ts
import { Collection, Migrations } from "@smthrs/effect-tanstack-db"

// A collection only this device has: its versions, oldest first, and a pure migration between each pair.
const Drafts = Migrations.local({
  id: "drafts",
  versions: [DraftV1, Draft],
  migrations: [Migrations.step(DraftV1, Draft, (row) => ({ ...row, title: "" }))],
  getKey: (row) => row.id
})

// A collection the server fills: any schema change bumps its version, and its rows sync again.
const Messages = Migrations.synced({ id: "messages", version: 3, schema: Message, family: true })

// What the outbox's writes carry, by the collection key each write names.
const AskingPayload = Migrations.payload({ key: "asking", versions: [Asking] })

export const registry = Migrations.registry({
  stores: [Drafts, Messages],
  retired: [Migrations.retired({ id: "old-drafts", kind: "local", version: 1 })],
  outbox: { payloads: [AskingPayload], mutations: ["ask"], unstamped: { asking: 1 } }
})

const drafts = yield * Collection.persisted(Drafts) // the declaration is the collection's options
```

- A local store's version is the number of its versions, and `versions[n - 1]`
  is version `n`'s schema. A history with a missing migration, or one between
  the wrong versions, throws `InvalidDeclaration` as the program loads.
- A migration returns the next row, or `new Migrations.Unmigratable({ reason })`
  to refuse it. It never changes a row's key.
- `discard: true` marks a cache: a row that doesn't migrate is deleted and
  counted instead of kept, and the store needs no migrations.
- `first` is the version of the first schema listed, for a store whose earliest
  versions were never declared; a row stored at one of them is kept aside.
- Give `Persistence.layer` the registry: a persisted collection it doesn't
  declare, at that version and kind, dies with `Undeclared` as it opens.

## Bring the store forward before anything reads it

```ts
const report = yield * Migrations.apply(registry, Migrations.promiseSql(database))
```

`apply` reads TanStack DB's `collection_registry` and, for each stored
collection:

| Stored                        | Declared     | `apply`                                                                                                                                                                                                                              |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| this build's version          | any          | nothing (`current`)                                                                                                                                                                                                                  |
| another version               | synced       | nothing (`resync`): the persistence drops its rows and resume state as it opens, and the source sends them again                                                                                                                     |
| an older version              | local        | in one `BEGIN IMMEDIATE` transaction, decodes each row with its version's schema, runs each migration, checks it with this build's schema, writes it back under a new row version, and records the collection's version (`migrated`) |
| a newer or undeclared version | local        | sets every row aside, and the collection starts empty at this build's version (`reset`)                                                                                                                                              |
| any                           | retired      | sets a local store's rows aside (`retired`)                                                                                                                                                                                          |
| any                           | not declared | nothing (`skipped`): a newer build's                                                                                                                                                                                                 |

A row set aside goes to the `device_kept` table with its collection, key,
version, stored value and why: `decode`, `invalid`, `key`, `defect`,
`unreadable`, `newer`, `unknown`, `retired`, or a migration's own reason.
Each local collection's transaction first reads its version again, so running
`apply` twice, or from two programs, does nothing more, and a crash leaves the
collection as it was. In a browser, `@smthrs/platform-browser`'s leader runs it
before any tab reads the database:

```ts
BrowserRuntime.run({ name, sqlite, flows, registerFlows, prepare: Migrations.prepare(registry) })
```

The leader runs `prepare` as the durable flow `device/prepare`, once per
`registry.epoch`.

## The outbox

```ts
Outbox.layer({
  ...host.outbox,
  collections,
  mutations,
  upgrade: Migrations.outbox(registry),
  parked: { ask: (write) => showAsNotSent(write) }
})
```

- **Stamp.** `transact` stores each payload's version in the write's metadata.
  A write from before stamping takes the declared `unstamped` versions.
- **Upgrade.** Before the library loads the stored writes, each one an older
  build made is brought to this build's payload versions and stored again.
  Upgrading twice writes the same bytes.
- **Park.** A write naming a mutation or collection this build doesn't have, at
  a newer or unknown version, or whose row won't decode or a migration refuses,
  moves to `parked:<id>`. The library never loads it. `parked` hands each one to
  its feature as the outbox starts; `Outbox.parked` lists them and `discard`
  deletes one.

## Fail a test on a schema change without a version

```ts
const recorded = JSON.parse(readFileSync("schemas.lock.json", "utf8"))
expect(Migrations.check(registry, recorded)).toEqual([])
// To record new versions: writeFileSync("schemas.lock.json", JSON.stringify(Migrations.lock(registry, recorded).lock))
```

The lock holds each store's fingerprint by version: a hash of its schema's JSON
Schema document, with keys and required fields in order. `check` reports:

| Problem                   | Means                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `changed_without_version` | The schema of a recorded version changed: add a version, and for a local store or payload a migration |
| `history_changed`         | An older version's schema was edited                                                                  |
| `version_went_back`       | The store is at a lower version than one recorded                                                     |
| `kind_changed`            | A store changed between local and synced                                                              |
| `removed`                 | A recorded store or payload is no longer declared, nor retired                                        |
| `mutation_removed`        | A recorded mutation name is gone, neither renamed nor retired                                         |
| `unrecorded`              | A version the lock doesn't have yet                                                                   |

`lock` records new versions beside the old ones and never rewrites a
fingerprint; with any problem other than `unrecorded`, it returns them as
`refused`. A check JSON Schema can't state, such as a custom filter, doesn't
change a fingerprint.

## Observability

Each collection's outcome is a log line `device.migrate` (Info; Debug when
`current`; Warn when a migration set rows aside or dropped them, since they no
longer show) with `collection`, `store`, `outcome`, `from`, `to`, `migrated`,
`kept` and `dropped`, and a count of `device_migrations` by `store` and
`outcome`. Each row set aside counts in `device_rows_kept` by `store` and
`reason`; the whole run is a span `device.migrate` and a `device_migrate_ms`
sample. The outbox's pass counts `outbox_carried`. None carries a row's
content.

## Limits

- `apply` reads and writes TanStack DB's SQLite layout as
  `@tanstack/db-sqlite-persistence-core` 0.4.11 stores it; the suites run it
  against that persistence, so an upgrade that changes the layout fails them.
- Values are written back as the persistence encodes them: JSON, with bigints,
  dates and non-finite numbers tagged. A row holding a value tagged with
  another type, such as a Temporal value, is kept aside, not rewritten.
