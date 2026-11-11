# `@smthrs/effect-tanstack-db`

## 0.2.0 (unreleased)

### Fixed

- Interrupted device migrations roll back before the connection is reused.
  Resets and retirements warn whenever rows are set aside or dropped.
  The API reference includes pending writes, query publication, outbox holds
  and ordering, and stored collection discovery.

- Outbox payload migrations preserve dates, Temporal values and marker-shaped
  user objects instead of parking valid rows or losing their value types.

- A storage failure while `Outbox.layer` upgrades older builds' writes no longer
  lets the library send the writes it didn't reach with their old rows: each
  stays stored, unsent, until a later start upgrades or parks it.
- `LiveQuery.rows` coalesces pending notifications for slow consumers instead of
  accumulating repeated current snapshots. `LiveQuery.make` reports construction
  exceptions as `Collection.LoadFailed` with the original cause.
- Stored row encoding and decoding preserve own `__proto__` fields without changing object prototypes.

### Added

- `LiveQuery.make(query, { getKey })` keys each result row itself, so a join's
  row keeps its source collection's key.
- `Persistence`: TanStack DB's SQLite persistence as an Effect service.
  `Persistence.layer({ open, make, coordinator })` takes the host's database,
  persistence and tab coordinator as arguments, and keeps rows in memory, with
  a `persistence unavailable` warning and the `persistence_unavailable`
  counter, when the database can't open. `Persistence.memory` persists
  nothing. `persistence_restore_ms` records each collection's restore.
- `Collection.persisted`: a local collection whose rows are kept on the device.
- `Collection.make(schema, options, { persist: { schemaVersion } })`: a synced
  collection that keeps its rows and resume state, restored before the network
  answers.
- `Collection.restored`: waits for the rows kept on the device, whatever the
  network does.
- `Outbox`: durable writes through `@tanstack/offline-transactions`.
  `transact` writes optimistic rows and returns a `Write` with `admitted` and
  `settled`; mutations fail with `Refused` or `Retry`; followers get
  `NotAdmitted`; `status` and `retryNow`; `Online.always()`; `lockLeader` over
  a lock service such as `@smthrs/platform-browser`'s `WebLock`. Records
  `outbox_attempts`, `outbox_refused`, `outbox_queued_ms`,
  `outbox_leader_changes` and an `outbox.send` span per send, linked to the
  span the write was made in.
- Peer dependencies: `@tanstack/db-sqlite-persistence-core` 0.4.11 (required)
  and `@tanstack/offline-transactions` 1.1.3 (optional).

## 0.1.0 (unreleased)

### Added

- `Collection.local`: an in-memory collection, scoped, its rows checked by an
  Effect `Schema`.
- `Collection.make`: the collection TanStack DB creates from a sync adapter's
  options, scoped and checked the same way.
- Reads as Effects (`toArray`, `get`, `isSynced`, `preload`) and changes as a
  `Stream` (`changes`).
- Mutations as Effects with typed errors: `insert`, `update` and `delete` fail
  with `MutationRefused`; a transaction's `persisted` fails with
  `TransactionFailed`.
- `LiveQuery.make`: a scoped live query whose result is a `Stream` (`rows`),
  with `changes`, `preload` and `setWindow`, which fails with `LoadFailed`.
- `Query`: TanStack DB's comparison, logic and null-check expressions and
  `caseWhen`, re-exported as pure data.

- Add `LiveQuery.Publication`, `LiveQuery.incremental`, and a per-query publication override. Incremental publication keeps ordered refills from retaining rows withdrawn by an access gate; window and preload receipts still await settlement. The default remains settled publication.

SQLite schema bootstrap uses the driver’s transactional batch when available, reducing cold-start autocommits and rolling back partial collection schema creation on failure.
