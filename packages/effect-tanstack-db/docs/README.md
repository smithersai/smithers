---
title: "@smthrs/effect-tanstack-db"
description: "TanStack DB collections, live queries and mutations for Effect programs: scoped services, rows checked by an Effect Schema, Streams for changes and results, typed errors, rows kept on the device, and a durable outbox for writes."
---

`@smthrs/effect-tanstack-db` makes TanStack DB an Effect library. Your program
creates collections and live queries in a scope, reads and writes them with
Effects, and follows them as `Stream`s. Nothing throws and nothing outlives its
scope.

## What it guarantees

- **Scoped lifetime.** A collection or live query lives exactly as long as the
  scope that made it. When the scope closes it is cleaned up; TanStack DB's
  garbage-collection timer is off. A cleanup that fails is logged as
  `collection cleanup failed` at Warn level, with `collection` (its id) and
  `error` (the error's name, never its message) annotations, and never fails
  the scope.
- **Checked rows.** Every collection takes a `RowSchema`, an Effect `Schema`
  that checks rows without transforming them. TanStack DB validates each insert
  and the merged row of each update with it; `Collection.local` decodes its
  initial rows with it.
- **Typed mutations.** `insert`, `update` and `delete` apply at once
  (optimistically) and fail with `MutationRefused` instead of throwing. Each
  returns a `Transaction`, whose `persisted` waits for the collection's
  handler and fails with `TransactionFailed` when it rolled back.
- **Streams.** `changes` streams a collection's or a live query's change
  batches from the moment the stream starts. Without `initial`, it delivers
  every later change, including changes to rows that existed before. With
  `initial`, the current rows come first. `LiveQuery.rows` streams the whole
  result: once when the stream starts, then the current result after changes.
  Slow consumers coalesce pending notifications into one snapshot.
- **Pure query expressions.** `Query` re-exports TanStack DB's comparisons,
  logic, null checks, `coalesce` and `caseWhen` as they are: they build data
  and run nothing. Nothing else from TanStack DB is re-exported.
- **Rows kept on the device.** `Persistence.layer` opens a SQLite database
  (OPFS in a tab, a file in Node) through TanStack DB's persistence. A
  collection made with `persist`, or with `Collection.persisted`, restores its
  rows from it before the network answers; `restored` waits for them. When the
  database can't open, rows stay in memory: the layer logs
  `persistence unavailable` and never fails. With a `lock`, one of the
  programs sharing the database stores what each synced collection syncs, and
  the others take their rows from the database.
- **Durable writes.** `Outbox.layer` sends writes through
  `@tanstack/offline-transactions`: each is stored before it is sent, sent
  again with the library's backoff until a mutation succeeds or refuses it, and
  restored after a reload or restart. Only the program that leads the outbox
  admits a write; a follower gets `NotAdmitted`, never the library's
  online-only path. `withdraw` takes back a write not sent yet, under the lock
  a send claims its write with, so a write is never both sent and taken back.
- **Device data across builds.** `Migrations` declares each stored
  collection's and outbox payload's versions, brings an older build's store to
  this build's before anything reads it, upgrades or parks the writes an older
  build queued, and keeps aside every row it can't bring forward. A lock fails
  a test when a schema changes without a new version. See
  [Migrations](migrations.md).
- **Host capabilities as arguments.** The database, its persistence, the tab
  coordinator, the outbox's entry point, storage, leader and network detector
  all come from the host, so the root imports no Node or browser module.

## Where it fits

- `Collection.local` makes an in-memory collection: one device's own state,
  such as a draft or which panel is open.
- `Collection.make` wraps the collection TanStack DB creates from a sync
  adapter's options. A sync adapter, such as `@smthrs/effect-electric`, builds
  its collections with it, so they get the same scope, schema and Effects.
- `Collection.persisted` keeps one device's own rows across reloads, such as
  writes a server refused.
- `LiveQuery.make` joins, filters, orders and windows collections. A query
  with `orderBy` and `limit` moves its window with `setWindow`, which succeeds
  once the rows the window needs have loaded.
- `Outbox.transact` makes an optimistic write that a named mutation sends, for
  writes that must survive going offline. Put the optimistic rows in a
  `Collection.local`; the synced collection shows the server's rows once they
  arrive.
- Every collection and live query keeps its TanStack DB collection in
  `tanstack`, for a framework binding and for `from` in a live query. See
  [Frameworks](frameworks.md).

## Pages

- [API reference](api.md)
- [Migrations](migrations.md)
- [Frameworks](frameworks.md)

## Tests

`pnpm test` runs the suite in Node at 100% coverage of `src/`, with in-memory
collections and small sync adapters written in the tests. Persistence runs on
real SQLite files: TanStack DB's own browser persistence over an injected
`{ execute, close }` on `node:sqlite`. The outbox runs on the library's real
executor, with a `StorageAdapter` in memory and Node's Web Locks. It needs no
service.

## Peers

`effect` 4.1.0, `@tanstack/db` 0.15.1 and
`@tanstack/db-sqlite-persistence-core` 0.4.11 are required.
`@tanstack/offline-transactions` 1.1.3 is optional: the package imports only
its types, and the host passes `startOfflineExecutor` to `Outbox.layer`.
