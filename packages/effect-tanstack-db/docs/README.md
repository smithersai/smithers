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

`effect` 4.0.5, `@tanstack/db` 0.15.1 and
`@tanstack/db-sqlite-persistence-core` 0.4.11 are required.
`@tanstack/offline-transactions` 1.1.3 is optional: the package imports only
its types, and the host passes `startOfflineExecutor` to `Outbox.layer`.

## Durable holds and independent keys

`new Outbox.Retry({ status: 401, held: true })` retains the write and reports `Status.held` until settlement. `held` is generic: the package does not interpret HTTP statuses. A subsequent network retry preserves the persisted hold. Owned rows alone contribute to status, and a storage read failure keeps the last known state.

Supply `Options.orderingKeys` as a map from mutation names to functions of their rows. Each function returns stable dependency keys, captured in the existing transaction metadata before admission. Each admission reads the shared durable counter and atomically commits its increment with the new row, while holding the non-stealable admission fence. It never allocates from a leader-local counter, including after A→B→A leadership reacquisition. Startup and leadership recovery journal a stable repair plan for missing or duplicate sequences, placing a held member before ambiguous peers before replay. Recovery scans the retained backlog once; ordinary admission reads only the counter, and held-status invalidations remain bounded by indexed and dirty keys. Writes with overlapping keys remain ordered across reload and leadership handoff, including equal timestamps and transitive dependencies spanning several keys. Earlier rows without metadata derive keys from their persisted payloads on load. A mutation without a key declaration, or with an empty key array, conservatively conflicts with every key. A held head waiting out backoff lets independent keys pass. Ordinary retries preserve FIFO behavior. Writes keep their original settlement, withdrawal and idempotency boundaries.

For live follower status, supply `Options.changes` with `publish()` and `subscribe(listener)`, backed by a host channel. Notifications carry no rows. Admissions update held status incrementally. Dirty local membership survives an incomplete index read, and index repair rereads the indexed and dirty rows before publication, so a delayed invalidation cannot erase an unpublished hold. Followers coalesce invalidations, read a small persisted index of held transaction keys, and validate the referenced rows and their ownership. Startup and leadership change reconcile against retained rows, repairing an index missed by a crash. Storage completion never scans the backlog for status. A failed index write or notification remains dirty and is repaired by the next existing storage, retry or settlement step; notification follows successful index persistence. Until storage recovers, followers retain their last known status. Cached owner stamps are re-evaluated when the current principal or unstamped-ownership policy changes. Every instance reads held status before starting the executor, so an offline reload needs no notification or send. Notification failures are logged without changing admission.

The pinned offline-transactions 1.1.3 dependency needs this workspace's `retryScheduling` patch. It exposes eligible heads to the existing executor and retry timer; it adds no executor, retry loop or parallel send. The default dependency behavior remains FIFO. Tests exercise the real patched executor through this package's public API.

The default election keeps its Web Lock while shutdown drains persistence already in flight. Closing refuses new and late admissions before releasing leadership, so an older executor cannot overwrite a reopened executor's counter. Settlement still persists a response that outlives disposal, preventing its replay. Custom elections that transfer leadership during persistence must supply `Leader.withAdmission`; `Outbox.lockLeader` supplies that fence. These fenced elections can dispose immediately while a pending admission retains its separate lock until storage completes; successor recovery waits on that lock.

Storage supplies `withLock(name, action)` as cross-context exclusion for the held index. Publication holds it across reading, validating rows and replacing the index, including late settlements after disposal. All contexts using a database must share the same lock name and hold it until the action settles.

Late retry snapshots merge with the current row under that row's shared lock. Persisted holds and admission order survive a handoff; terminal or deleted writes stay settled. Different rows remain independent. Row changes release their lock before index publication.
