---
title: "API reference"
description: "Every export of @smthrs/effect-tanstack-db: the Collection, LiveQuery, Query, Persistence, Outbox and Migrations namespaces, their models, constructors, metrics and errors."
---

The package root exports six namespaces and nothing else:

```ts
import { Collection, LiveQuery, Migrations, Outbox, Persistence, Query } from "@smthrs/effect-tanstack-db"
```

## `Collection`

### `Collection.local`

```ts
const local: <A extends object, K extends Key>(options: {
  readonly id: string
  readonly schema: RowSchema<A>
  readonly getKey: (row: A) => K
  readonly initialData?: ReadonlyArray<NoInfer<A>>
}) => Effect.Effect<Collection<A, K>, never, Scope.Scope>
```

An in-memory collection, cleaned up when the scope closes. Its writes apply at
once and need no handler. `initialData` is decoded with `schema`; a row that
doesn't decode is a defect. The row type comes from `schema`, the key type from
`getKey`.

### `Collection.persisted`

```ts
const persisted: <A extends object, K extends Key>(options: {
  readonly id: string
  readonly schema: RowSchema<A>
  readonly getKey: (row: A) => K
  readonly schemaVersion: number
}) => Effect.Effect<Collection<A, K>, never, Scope.Scope | Persistence.Persistence>
```

An in-memory collection whose rows are kept on the device through
`Persistence`, and restored by the next program that makes it: TanStack DB's
persisted collection without a sync source. Its writes apply at once, then are
stored; `preload` and `restored` wait for the stored rows. A write the device
couldn't store rolls back: it is logged as `persisted write failed` at Warn
level, with `collection`, `operation` and `error` (the error's name, never its
message), and counted in `Persistence.writeFailures`. A changed
`schemaVersion` does what the persistence's `schemaMismatchPolicy` says.
Without a database (`Persistence.memory`, or one that couldn't open) it is the
same as `local`.

### `Collection.make`

```ts
function make<A extends object, K extends Key, U extends UtilsRecord = UtilsRecord>(
  schema: RowSchema<A>,
  options: Options<A, K, U>
): Effect.Effect<Collection<A, K, U>, never, Scope.Scope>
function make<A extends object, K extends Key, U extends UtilsRecord = UtilsRecord>(
  schema: RowSchema<A>,
  options: Options<A, K, U>,
  settings: { readonly persist: Persist }
): Effect.Effect<Collection<A, K, U>, never, Scope.Scope | Persistence.Persistence>
```

The collection TanStack DB creates from a sync adapter's options, checked by
`schema`, and cleaned up when the scope closes. It sets the schema, turns
garbage collection off and indexes fields eagerly as queries need them. Use it
to build a sync adapter's collection; use `local` for in-memory state.

`options.onSyncCommit` receives `{ getMetadata(key) }` after each sync
transaction's application receipt succeeds. Rows and collection metadata are
visible when it runs. It observes transactions installed by the shared-device
coordinator too, including metadata-only transactions and empty snapshots.
Dropped watcher-source writes and rejected receipts never call it. Adapters
can compare their accepted cursor with `getMetadata` before reporting recovery.
The reader holds that transaction's metadata; a later staged cursor cannot
certify an earlier receipt. The adapter's acceptance receipt stays intact.

With `persist`, the collection keeps its rows, and its sync adapter's resume
state, through `Persistence`: TanStack DB's `persistedCollectionOptions` with
network-first initial rendering that waits for no network
(`networkTimeoutMs: 0`), so the rows restored from the device show at once and
the network's rows follow. `restored` waits for them, and the milliseconds it
took are recorded in `Persistence.restoreMs`. A restore that fails, so the
collection starts without its stored rows, is logged as `persisted restore
failed` at Warn with `collection` (its kind: the id up to its first `:`) and
`error` (the error's name, never its message), and counted in
`Persistence.restoreFailures`. Without a database, the rows stay in memory.

Each transaction the sync adapter opens reaches TanStack DB's persisted core
whole, at its commit: begin, its writes and metadata in order, then the commit,
in one turn. The persisted core refuses a commit whose transaction began before
the device's rows were read again, which another tab's commit to the shared
database does, and Electric keeps a transaction open from a batch that ends
without `up-to-date` until the next batch. A read of the sync metadata inside a
transaction hands the core what the transaction holds so far, so the read sees
its own writes.

With `Persistence`'s `lock`, one program of those sharing the database stores
what the collection's source syncs: the one holding lock
`persisted-sync:<id>`, which a program waits for and never steals. Every other
program runs its source watching: what it writes, empties or commits is
dropped, and it gets no sync metadata, so it neither reads nor stores resume
state. Its rows come from the database, through the coordinator, while its
source still reports the network and marks the collection ready. A watcher that
comes to hold the lock ends its watching session and starts its source again,
writing, from what the database stored. A writer that stops lets the lock go
only once the database has stored, or refused, what it committed, so none of
its commits lands after the next writer's. A source that throws as it starts
fails the collection (`markError`), as it would alone, logged as `persisted
sync failed` at Warn level with `collection` (its kind: the id up to its first
`:`) and `error` (the error's name, never its message), and the program lets
the lock go. Each role a program's source takes is counted in
`Persistence.syncRoles` and logged as `persisted sync role`, with `collection`
and `role` (`writer` or `watcher`): at Debug for a first role
[`Persistence.reportRoles`](#persistencereportroles) counts, which sums them in
one Info line, and at Info for any other, such as a watcher taking the lock when
the writing program closes. So one
program's snapshot, taken before a row arrived and committed after another
program stored that row, never erases it. A row reaches a watcher through the
database, so wait for one with `awaitRow`, not with the sync adapter's own
receipts, which follow the program's own stream.

### `Collection.Persist`

```ts
interface Persist {
  readonly schemaVersion: number
}
```

How a collection keeps its rows on the device. `schemaVersion` names the rows'
shape: when it changes, a synced collection drops the rows kept under the old
one and syncs again; a collection without a sync source does what the
persistence's `schemaMismatchPolicy` says.

### `Collection.Collection<A, K, U>`

```ts
interface Collection<A extends object, K extends Key = Key, U extends UtilsRecord = UtilsRecord> {
  readonly id: string
  readonly tanstack: TanStackCollection<A, K, U>
  readonly toArray: Effect.Effect<ReadonlyArray<A>>
  readonly get: (key: K) => Effect.Effect<Option.Option<A>>
  readonly isSynced: (key: K) => Effect.Effect<boolean>
  readonly preload: Effect.Effect<void, LoadFailed>
  readonly restored: Effect.Effect<void, LoadFailed>
  readonly changes: (options?: { readonly initial?: boolean }) => Stream.Stream<ReadonlyArray<Change<A, K>>>
  readonly awaitRow: (match: (row: A) => boolean, timeout: Duration.Input) => Effect.Effect<A, Cause.TimeoutError>
  readonly insert: (rows: A | ReadonlyArray<A>) => Effect.Effect<Transaction, MutationRefused>
  readonly update: (key: K, recipe: (draft: WritableDeep<A>) => void) => Effect.Effect<Transaction, MutationRefused>
  readonly delete: (keys: K | ReadonlyArray<K>) => Effect.Effect<Transaction, MutationRefused>
}
```

| Field                        | Does                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tanstack`                   | The TanStack DB collection, for a framework binding and for `from` in a live query. See [Frameworks](frameworks.md).                                                                                               |
| `toArray`                    | The rows as they are now, optimistic writes included.                                                                                                                                                              |
| `get`                        | One row as it is now.                                                                                                                                                                                              |
| `isSynced`                   | Whether the row is there as the sync source has it: present, with no optimistic write of its own pending. A row a mutation inserted is not synced until its handler persists it and the source delivers it back.   |
| `preload`                    | Starts the sync and waits for the first rows: for a synced collection, the network's. Fails with `LoadFailed`.                                                                                                     |
| `restored`                   | Starts the collection and waits until the rows kept on the device have loaded, whatever the network does. For a collection that keeps none, the same as `preload`. Fails with `LoadFailed` when the restore fails. |
| `changes`                    | The change batches from when the stream starts. Without `initial`, every later change, including to rows that existed before; with `initial`, the current rows first.                                              |
| `awaitRow`                   | The first row `match` accepts, there now or once it shows, however it came: from this program's sync source or, through the database, another program's. Fails with `TimeoutError` past `timeout`.                 |
| `insert`, `update`, `delete` | Apply at once. Fail with `MutationRefused`. Return the `Transaction`.                                                                                                                                              |

### `Collection.Change<A, K>`

```ts
interface Change<A, K extends Key = Key> {
  readonly type: "insert" | "update" | "delete"
  readonly key: K
  readonly value: A
  readonly previousValue: A | undefined
}
```

One change, in the batch TanStack DB published it in. `previousValue` is the
row before an update.

### `Collection.Transaction`

```ts
interface Transaction {
  readonly id: string
  readonly persisted: Effect.Effect<void, TransactionFailed>
}
```

`persisted` succeeds once the collection's mutation handler, if it has one,
accepted the mutation, and fails with `TransactionFailed` when the handler
failed and the mutation rolled back.

### `Collection.RowSchema<A>`

```ts
type RowSchema<A> = Schema.Codec<A, A>
```

A schema that checks rows and never transforms them, so a row's encoded and
decoded forms are the same type. TanStack DB stores what a mutation passes and
validates merged rows on update, so a transforming schema such as
`Schema.NumberFromString` is refused at compile time.

### `Collection.Options<A, K, U>`

```ts
type Options<A extends object, K extends Key, U extends UtilsRecord> =
  & Omit<CollectionConfig<A, K, never, U>, "schema" | "gcTime" | "autoIndex" | "defaultIndexType" | "utils">
  & {
    readonly utils?: U
    readonly onSyncCommit?: (commit: SyncCommit) => void
  }

interface SyncCommit {
  readonly getMetadata: (key: string) => unknown
}
```

The options TanStack DB creates a collection from, as a sync adapter returns
them, without the fields `make` sets.

### `Collection.Key`

```ts
type Key = string | number
```

### Errors

| Error               | Fields                                                          | When                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MutationRefused`   | `operation: "insert" \| "update" \| "delete"`, `cause: unknown` | TanStack DB refused a mutation before applying it: a duplicate key, a key that isn't there, a row the schema refused, or no handler for the operation. |
| `TransactionFailed` | `cause: unknown`                                                | A transaction rolled back because its handler failed; `cause` is the handler's failure.                                                                |
| `LoadFailed`        | `cause: unknown`                                                | A live query could not be constructed, or rows could not load. `cause` is the original construction or loading failure.                                |

All three are `Data.TaggedError`s, so `Effect.catchTag` narrows them.

## `LiveQuery`

### `LiveQuery.make`

```ts
const make: <Q extends AnyQuery>(
  query: (q: InitialQueryBuilder) => Q
) => Effect.Effect<LiveQuery<Q>, LoadFailed, Scope.Scope>
```

A live query over other collections, built with TanStack DB's query builder and
the expressions in `Query`, cleaned up when the scope closes. Name a source by
its `tanstack` field: `q.from({ todo: todos.tanstack })`. It starts on its
first read, `preload` or stream. Query-construction exceptions fail with
`Collection.LoadFailed`, preserving the original exception as `cause`.

### `LiveQuery.LiveQuery<Q>`

```ts
interface LiveQuery<Q extends AnyQuery> {
  readonly tanstack: TanStackLiveQuery<Q>
  readonly toArray: Effect.Effect<ReadonlyArray<Row<Q>>>
  readonly preload: Effect.Effect<void, LoadFailed>
  readonly rows: Stream.Stream<ReadonlyArray<Row<Q>>>
  readonly changes: (options?: { readonly initial?: boolean }) => Stream.Stream<ReadonlyArray<Change<Row<Q>>>>
  readonly setWindow: (window: Partial<Window>) => Effect.Effect<void, LoadFailed>
}
```

| Field       | Does                                                                                                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tanstack`  | The TanStack DB collection behind the query.                                                                                                                                                                                                                                           |
| `toArray`   | The result as it is now.                                                                                                                                                                                                                                                               |
| `preload`   | Starts the query and waits for its first result. Fails with `LoadFailed`.                                                                                                                                                                                                              |
| `rows`      | The result when the stream starts, then the current result after changes. Slow consumers coalesce pending notifications into one snapshot; use `changes` for every change batch.                                                                                                       |
| `changes`   | As `Collection.changes`, over the result.                                                                                                                                                                                                                                              |
| `setWindow` | Moves the window of a query with `orderBy` and `limit`. The window moves when the Effect runs; the Effect succeeds once the rows it needs have loaded. It fails with `LoadFailed` when they don't load, or when the query has no window; the query then keeps its last settled window. |

TanStack DB adds its virtual properties (`$synced`, `$key`, `$origin`,
`$collectionId`, `$hasPendingWrites`) to every result row.

### Types

| Type                   | Is                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `AnyQuery`             | `QueryBuilder<any>`: any query TanStack DB's builder returns.                                           |
| `Row<Q>`               | The row type query `Q` selects.                                                                         |
| `TanStackLiveQuery<Q>` | The TanStack DB collection behind `Q`: a single result for a query ending in `findOne()`, else many.    |
| `Window`               | `{ readonly offset: number; readonly limit: number }`: `limit` rows from `offset` of an ordered result. |

## `Query`

```ts
export { and, caseWhen, coalesce, eq, gt, gte, isNull, isUndefined, lt, lte, not, or } from "@tanstack/db"
```

TanStack DB's expressions, re-exported as they are. They are pure data: each
call returns a description of an expression for a live query to compile, and
runs nothing, so they need no Effect wrapper. Nothing else from TanStack DB is
re-exported; import its types from `@tanstack/db` where a signature needs one.

## `Persistence`

TanStack DB's SQLite persistence as an Effect service. The host supplies
everything platform-specific as arguments, so the module imports and runs
anywhere Effect does.

### `Persistence.layer`

```ts
const layer: <D extends Database>(options: Options<D>) => Layer.Layer<Persistence>

interface Options<D extends Database> {
  readonly open: () => Promise<D> | D
  readonly make: (
    database: D,
    coordinator: PersistedCollectionCoordinator | undefined
  ) => PersistedCollectionPersistence
  readonly coordinator?: () => Coordinator
  readonly registry?: Migrations.Registry
  readonly lock?: Outbox.Lock
}
```

| Option        | Is                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `open`        | Opens the database: `openBrowserWASQLiteOPFSDatabase` in a tab, a file in Node. A throw or rejection means the database is unavailable.                                                                                                                |
| `make`        | TanStack DB's persistence over the open database, sharing `coordinator` when there is one: `createBrowserWASQLitePersistence({ database, coordinator })`.                                                                                              |
| `coordinator` | Makes the coordinator that shares one database between a browser's tabs: `new BrowserCollectionCoordinator({ dbName })`.                                                                                                                               |
| `registry`    | Every store the program keeps (`Migrations.registry`). A persisted collection it doesn't declare, at that version and kind, dies with `Migrations.Undeclared` as it opens, with or without a database.                                                 |
| `lock`        | The lock service the programs sharing the database elect each synced collection's writer with (`Collection.make`): `WebLock` in a tab. Give it whenever `coordinator` shares the database. Without it, every program stores what its own source syncs. |

Opens the database and builds the persistence. When the layer closes, the
coordinator is disposed, then the database closed; a close that fails is
ignored. When `open` fails, collections keep their rows in memory: the layer
logs `persistence unavailable` at Warn level with an `error` annotation (the
error's tag, `PersistenceUnavailable`), counts `unavailable`, and succeeds.

```ts
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase
} from "@tanstack/browser-db-sqlite-persistence"

const DeviceStore = Persistence.layer({
  open: () => openBrowserWASQLiteOPFSDatabase({ databaseName: "app.sqlite" }),
  make: (database, coordinator) =>
    createBrowserWASQLitePersistence({ database, ...(coordinator ? { coordinator } : {}) }),
  coordinator: () => new BrowserCollectionCoordinator({ dbName: "app" }),
  lock: WebLock.make(navigator.locks)
})
```

`make` accepts any database TanStack DB's driver can use: an object with
`execute(sql, params)` and an optional `close`. The package's tests hand it one
over `node:sqlite`.

### `Persistence.memory`

```ts
const memory: Layer.Layer<Persistence>
```

No database: every persisted collection keeps its rows in memory. For a program
or test that persists nothing.

### `Persistence.reportRoles`

```ts
const reportRoles: Effect.Effect<Persistence.Roles, never, Persistence>
```

Waits until every persisted synced collection made so far with this
`Persistence` has taken its first role, or stopped without one, then logs
`persisted sync roles` at Info with `writers` and `watchers`, how many first
took each role, and answers `{ writers, watchers }`. Call it once, after the
program has built its collections: a program with 23 synced collections logs
one line instead of 23. A first role comes as soon as the lock answers whether
it is free, so a watcher's first role does not wait for the program holding
the lock. Each first role it counts is logged at Debug. A collection made after
it logs its first role at Info, as does every later change of role. With no
database or no `lock`, it answers zero of each.

```ts
const booted = Effect.gen(function*() {
  // ...build the program's collections, then:
  const { writers, watchers } = yield* Persistence.reportRoles
})
```

### Models

| Type          | Is                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Persistence` | The service: `{ readonly persistence: Option.Option<PersistedCollectionPersistence>; readonly registry?: Migrations.Registry; readonly lock?: Outbox.Lock }`, none when rows stay in memory. |
| `Database`    | `{ readonly close?: () => Promise<void> \| void }`: whatever `open` returns and `make` builds on.                                                                                            |
| `Coordinator` | TanStack DB's `PersistedCollectionCoordinator` with an optional `dispose`, run as the layer closes, before the database.                                                                     |
| `Roles`       | `{ readonly writers: number; readonly watchers: number }`: how many of a program's persisted synced collections first took each role, as `reportRoles` answers.                              |

### Metrics and errors

| Export                   | Is                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `unavailable`            | Counter `persistence_unavailable`: times the database couldn't open, so rows stayed in memory.                                                 |
| `restoreMs`              | Histogram `persistence_restore_ms`, by `collection` (its id): milliseconds from making a persisted collection to its rows restored.            |
| `restoreFailures`        | Counter `persistence_restore_failures`, by `collection` (its kind, the id up to its first `:`): persisted collections whose restore failed.    |
| `writeFailures`          | Counter `persistence_write_failures`, by `collection` and `operation`: writes to a persisted collection the device couldn't store.             |
| `syncRoles`              | Counter `persistence_sync_roles`, by `collection` and `role` (`writer` or `watcher`): roles a synced collection's source took in this program. |
| `PersistenceUnavailable` | `Data.TaggedError` with `cause: unknown`: the database couldn't be opened. `cause` is what the host reported.                                  |

When `Persistence.layer` cannot open a SQL connection, `persistence unavailable`
records the SQL reason tag as `reason` and the underlying cause's tag or error
name as `errorCode`, alongside `error`. It never records SQL, error messages, or
stored values. This distinguishes a refused OPFS operation from a connection
or transport failure without exposing user content.

## `Outbox`

A durable outbox for TanStack DB writes, through
`@tanstack/offline-transactions`. A write is an offline transaction: its
optimistic rows show at once, the transaction is stored durably (IndexedDB in a
browser) before anything is sent, and the library sends it with its own
backoff, one at a time in the order written, across reloads and restarts. Only
a program that leads the outbox, with durable storage, admits a write.

### `Outbox.layer`

```ts
const layer: <R>(options: Options<R>) => Layer.Layer<Outbox, never, R>

interface Options<R> {
  readonly start: (config: OfflineConfig) => OfflineExecutor
  readonly collections: Readonly<Record<string, Collection<any, any, any>>>
  readonly storage: StorageAdapter
  readonly leader?: Leader
  readonly online: Online
  readonly mutations: Readonly<Record<string, Mutation<R>>>
  readonly upgrade?: Migrations.OutboxUpgrade
  readonly parked?: Readonly<Record<string, (write: Parked) => Effect.Effect<boolean, never, R>>>
  readonly principal?: Principal
}

interface Principal {
  readonly now: () => string | undefined
  readonly ownsUnstamped: () => boolean
}

type Mutation<R> = (params: {
  readonly rows: ReadonlyArray<unknown>
  readonly idempotencyKey: string
}) => Effect.Effect<void, Refused | Retry, R>
```

| Option        | Is                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`       | The library's entry point: `startOfflineExecutor` from `@tanstack/offline-transactions`.                                                                                                                                                                |
| `collections` | The collections writes may change, keyed by a name that never changes: a stored write names its collection by this key, so a write queued by one version of a program is restored into the same collection by the next.                                 |
| `storage`     | Where writes are stored: `new IndexedDBAdapter(...)` in a browser. The library's own storage probe is skipped.                                                                                                                                          |
| `leader`      | Who leads: a `LeaderElection`, such as `lockLeader`'s. Without one, the library elects with its own `WebLocksLeader`, which never queues: when the leader closes, no other program takes over.                                                          |
| `online`      | The network detector: the library's `WebOnlineDetector` in a browser, `Online.always()` elsewhere.                                                                                                                                                      |
| `mutations`   | The named mutations, as Effects run with the services of the fiber that builds the layer.                                                                                                                                                               |
| `upgrade`     | How writes cross builds: `Migrations.outbox(registry)`. Each write is stamped with its payloads' versions; before the library loads the stored writes, each one an older build made is upgraded, or parked. See [Migrations](migrations.md#the-outbox). |
| `parked`      | What takes a parked write of each mutation name as the outbox starts, such as a feature showing it Not sent: `true` when it took the write, which the outbox then deletes; `false` leaves it parked.                                                    |
| `principal`   | Who this program writes as, so a write is sent only as who queued it; see below. Without it, every stored write is this program's.                                                                                                                      |

With `principal`, read synchronously each time the outbox asks, each write is
stamped with `now`, the principal this program writes as at that moment, such
as the person whose data it opened. The outbox loads, shows, parks and sends
only the stored writes that are the principal's: stamped with `now`, or, for a
write stored before writes were stamped, when `ownsUnstamped()`. Every other
write stays in the storage, sealed: never loaded, offered to `parked`, sent or
deleted, and logged as `outbox write sealed` at Warn level with `name` and
`stage: "load"`. A write whose principal changed after it was loaded is sealed
as it comes up to be sent (`stage: "send"`, counted in `attempts` as
`sealed`): its rows roll back, `settled` fails, and the storage keeps it, so
it goes once a program that writes as its principal loads it. Upgrade callbacks
receive only owned writes; `discard` also checks ownership before deleting a
parked write.

Starts the outbox and waits until it has loaded the writes stored earlier,
restored their rows, and asked to lead; a storage it can't read at start is
logged as `outbox couldn't load its writes` at Warn level, with `error`, the
storage error's name. The outbox stops when the layer closes.

A mutation's typed failure becomes the library's retry decision:

| Mutation fails with | The write                                                                                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Retry`             | Is sent again after the library's backoff, 1 second doubling to 60, jittered, or at once on `retryNow` or the browser coming back online. Its first retry is logged as `outbox write retrying` at Warn level with `name`, `status` (or `none`) and `outcome: "retry"`; later ones only count in `attempts`. |
| `Refused`           | Is never sent again; its optimistic rows roll back and `settled` fails. It is logged as `outbox write refused` at Warn level with `name`, `status` (or `none`) and `outcome: "refused"`, and counted in `refused`.                                                                                          |
| a defect            | Is never sent again; its rows roll back, and it is logged as `outbox write failed` at Error level with `name`, `outcome: "defect"` and `error.type`, the defect's name, never its message.                                                                                                                  |

The outbox throws the library errors with fixed messages, and its
`shouldRetry` retries only an error named `OutboxRetry`. So the library's own
rules, which never retry an `AbortError` or an error whose message contains
`400`, `401`, `403` or `422`, never see any other error: an aborted request or
a status in a message can't stop a write that should be sent again.

### `Outbox.Outbox`

```ts
interface Service {
  readonly transact: (
    name: string,
    ids: { readonly idempotencyKey: string },
    mutate: Effect.Effect<void, MutationRefused>
  ) => Effect.Effect<Write, NotAdmitted | MutationRefused>
  readonly status: Stream.Stream<Status>
  readonly retryNow: Effect.Effect<void>
  readonly withdraw: (idempotencyKey: string) => Effect.Effect<void, NotWithdrawn>
  readonly parked: Effect.Effect<ReadonlyArray<Parked>>
  readonly discard: (id: string) => Effect.Effect<void>
}

interface Parked {
  readonly id: string
  readonly name: string
  readonly reason: string
  readonly rows: ReadonlyArray<unknown>
}

interface Write {
  readonly id: string
  readonly admitted: Effect.Effect<void, NotAdmitted>
  readonly settled: Effect.Effect<void, TransactionFailed>
}

interface Status {
  readonly leader: boolean
  readonly failing: null | "network" | "server"
}
```

| Field      | Does                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transact` | Writes through mutation `name`. `mutate` runs at once, synchronously, inside the write, so its inserts, updates and deletes show as optimistic rows until the write settles. Fails with `NotAdmitted` when this program doesn't lead (it never takes the library's online-only path), and with `mutate`'s `MutationRefused`, after rolling the write back. The current span, if any, is stored with the write. |
| `status`   | The outbox's state now, then each change: whether this program leads, and whether the last send failed on the `network` (no status) or at the `server`; null once a send gets through.                                                                                                                                                                                                                         |
| `retryNow` | Sends every waiting write now instead of waiting out its backoff: the network detector's `notifyOnline`.                                                                                                                                                                                                                                                                                                       |
| `withdraw` | Takes back a write not sent yet, by its idempotency key: deletes it from the storage, so it is never sent, and rolls back its optimistic rows. Fails with `NotWithdrawn` when it can't. See below.                                                                                                                                                                                                             |
| `parked`   | The writes parked now: ones an older build stored that this build can't send as they were meant, with the mutation's `name`, the `reason` and the rows as stored, which no schema checked. A storage that can't be read reads as none, logged as `outbox couldn't read its parked writes` with `error`.                                                                                                        |
| `discard`  | Deletes parked write `id`, logged as `outbox write discarded` at Info level with its `name`. One that isn't parked changes nothing; a storage that fails is logged as `outbox couldn't discard a parked write` with `error`.                                                                                                                                                                                   |

`Write.admitted` succeeds once the write is stored, and fails with
`NotAdmitted` (`reason: "storage"`) when the storage refused it, or
`reason: "follower"` when leadership was lost before persistence; the write then
rolls back. `Write.settled` succeeds once the mutation succeeded, and fails
with `TransactionFailed` when the write rolled back.

#### Taking a write back

`withdraw(idempotencyKey)` takes back a stored write that is waiting to be
sent: queued while offline, waiting out its backoff, or restored after a
reload. Use it to let a person edit or cancel a write before the outbox sends
it.

```ts
const write = yield * outbox.transact("ask", { idempotencyKey: question.id }, Effect.asVoid(questions.insert(question)))
yield * write.admitted
// The person edits the question before it was sent.
yield * outbox.withdraw(question.id)
```

When `withdraw` succeeds, the write is gone from the storage and its rows are
gone from the collection. Its `settled` fails with `TransactionFailed`, whose
`cause` is an error named `OutboxWithdrawn`. As when the server refuses a
write, TanStack DB also rolls back the rows of later pending writes on the same
keys; those writes are still sent. A restored write's rows roll back the same
way. When the outbox reaches the withdrawn write in its queue, it settles it
without calling the mutation and counts `outbox_attempts` with outcome
`withdrawn`; the writes behind it are sent in order.

A send claims its write under the same lock `withdraw` holds, so a write is
never both sent and taken back. The lock is one per program: a takeover by
another tab in the moment of the withdraw is not covered by it.

| `NotWithdrawn` reason | Means                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `follower`            | This program doesn't lead the outbox, so another program may be sending the write.                                                                                                           |
| `gone`                | No stored write waiting to be sent has that key: it was sent or refused already, isn't stored yet (`admitted` hasn't succeeded), or was never made.                                          |
| `sending`             | The write's mutation is running now, or the write was just sent or refused and the library is deleting it. It settles as usual.                                                              |
| `storage`             | Reading or deleting the storage failed. The write is sent as usual, and the failure is logged as `outbox write not withdrawn` at Warn level with `reason`. Other reasons log at Debug level. |

A withdraw is a span, `outbox.withdraw`, with `outcome` (`withdrawn` or the
reason), and a success is logged as `outbox write withdrawn` at Info level with
the mutation's `name`, never the write's rows.

### `Outbox.lockLeader` and `Outbox.Lock`

```ts
interface Lock {
  readonly hold: (
    name: string,
    options?: { readonly steal?: boolean }
  ) => Effect.Effect<{ readonly lost: Effect.Effect<void> }, never, Scope.Scope>
  readonly tryHold: (
    name: string
  ) => Effect.Effect<Option.Option<{ readonly lost: Effect.Effect<void> }>, never, Scope.Scope>
}

const lockLeader: (options: {
  readonly lock: Lock
  readonly name: string
}) => Effect.Effect<
  Leader & { readonly take: Effect.Effect<void>; readonly dispose: () => void },
  never,
  Scope.Scope
>
```

A leader for the outbox over a lock service, so the outbox shares the host's one
election mechanism: `hold(name)` waits until this program holds the exclusive
lock `name` and holds it until the scope closes, or with `steal` takes it at
once from whichever program holds it; `tryHold(name)` takes it only when no
program holds it or waits for it, and answers none otherwise; `lost` completes
when another program steals it. `@smthrs/platform-browser`'s `WebLock` is one.
Unlike the library's `WebLocksLeader`, a program that doesn't get the lock
waits for it, so when the leader closes, the next one leads and restores the
writes it stored.

`requestLeadership` answers what the lock says, however long the lock manager
takes to say it: `true` when the lock was free and this program now holds it,
`false` when another program holds it or waits for it. The outbox starts only
after that answer, so a program alone admits its first write, never refusing it
as a follower's. A program that answered `false` waits in line, and a lock
granted later is reported through `onLeadershipChange`. Released before the
lock manager answers, it answers `false`. A lock manager that refuses the
request answers `false` too, logged as `outbox lock refused` at Warn level with
the error's name (`error`); the next `requestLeadership` or `take` asks again.

`take` makes this program lead at once, as the tab a person is using should: it
steals the lock unless this program leads already, and completes once the
outbox has heard it leads, so a write made next is admitted. The program it
took the lead from hears a moment later that it lost the lock, stops leading
(its send in flight finishes), and waits for the lock again, so it leads again
once the taker closes. A write is sent only while the storage holds it: one the
first program still had queued, which the taker sent and deleted meanwhile,
settles without a second send when the first leads again (counted
`sent_elsewhere`). Only a write both of them are sending in the moment the lead
moves reaches the server twice, under one idempotency key, so the server must
dedupe on it. The lock is released when the outbox stops or the scope closes.

```ts
const leader = yield * Outbox.lockLeader({ lock: WebLock.make(navigator.locks), name: "app-outbox" })
// The person focused this tab: it leads, and writes made here are admitted.
yield * leader.take
```

### `Outbox.Online.always`

```ts
const Online: { readonly always: () => Online }
```

A network detector that is always online: the outbox sends whenever it has a
write, and `retryNow` sends at once. For Node, a Worker or a test, where the
library's browser detector has no `online` event to follow, and reads Node as
offline.

### Models, errors and records

| Export                 | Is                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Leader`               | The library's `LeaderElection`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Online`               | The library's `OnlineDetector`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Refused`              | `Data.TaggedError` with `status?: number`: the server refused the write for good.                                                                                                                                                                                                                                                                                                                                                                 |
| `Retry`                | `Data.TaggedError` with `status?: number`: the write didn't get through (a 5xx, 408 or 429, or no status for the network or a deadline).                                                                                                                                                                                                                                                                                                          |
| `NotAdmitted`          | `Data.TaggedError` with `reason: "follower" \| "storage"`: another program leads, or the storage failed to store the write. Nothing was sent and the write's rows rolled back.                                                                                                                                                                                                                                                                    |
| `NotWithdrawn`         | `Data.TaggedError` with `reason: "follower" \| "gone" \| "sending" \| "storage"`: `withdraw` didn't take the write back, and nothing changed. See [Taking a write back](#taking-a-write-back).                                                                                                                                                                                                                                                    |
| `attempts`             | Counter `outbox_attempts`, by `name` and `outcome`: `sent`, `retry`, `refused`, `defect`, `sent_elsewhere` (another program sent the write while this one followed), `withdrawn` (settled unsent after `withdraw`), or `sealed` (another principal queued it; kept, never sent).                                                                                                                                                                  |
| `refused`              | Counter `outbox_refused`, by `name` and `status` (`none` without one).                                                                                                                                                                                                                                                                                                                                                                            |
| `queuedMs`             | Histogram `outbox_queued_ms`, by `name`: milliseconds from a write to its mutation succeeding.                                                                                                                                                                                                                                                                                                                                                    |
| `leaderChanges`        | Counter `outbox_leader_changes`, by `leader` (`true` or `false`).                                                                                                                                                                                                                                                                                                                                                                                 |
| `carried`              | Counter `outbox_carried`, by `name`, `outcome` (`upgraded` or `parked`) and `reason` (`none` for an upgrade): stored writes from an older build the outbox brought forward or parked as it started.                                                                                                                                                                                                                                               |
| `Parked`               | A parked write: its `id`, mutation `name`, `reason` and the `rows` as stored.                                                                                                                                                                                                                                                                                                                                                                     |
| span `outbox.carry`    | One per start with `upgrade`: the pass over the stored writes. Each upgraded write is logged as `outbox write upgraded` (Info), each parked one as `outbox write parked` (Warn, `stage: "upgrade"`), with `name` and `reason`, never its rows. A parked write no feature takes is logged again as `outbox write parked` (`stage: "load"`) each time the outbox starts. A storage that fails is `outbox couldn't upgrade its writes` with `error`. |
| span `outbox.send`     | One per send, with `name`, `attempt` and `outcome`, linked to the span the write was made in, so a send after a reload still points at the ask.                                                                                                                                                                                                                                                                                                   |
| span `outbox.withdraw` | One per `withdraw`, with `outcome`: `withdrawn`, or the `NotWithdrawn` reason.                                                                                                                                                                                                                                                                                                                                                                    |

## `Migrations`

Every store a program keeps on the device declares its history, so each build
brings the stores an older build wrote to its own versions, and a schema that
changes without a new version fails a test. The guide is
[Migrations](migrations.md).

| Export                                                                     | Is                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local({ id, versions, migrations?, getKey, discard?, first? })`           | A collection only the device has (`Collection.persisted`'s options): `versions` oldest first, one `step` between each pair. `discard` marks a cache, whose rows that don't migrate are deleted and counted. `first` is the version of `versions[0]`. |
| `synced({ id, version, schema, family? })`                                 | A collection a sync source fills. A new version drops its rows and the source sends them again; `family` covers `<id>:<anything>`.                                                                                                                   |
| `payload({ key, versions, migrations? })`                                  | The rows an outbox write carries for collection `key`.                                                                                                                                                                                               |
| `retired({ id, kind, version, family? })`                                  | A store this build no longer keeps; a local one's rows are set aside.                                                                                                                                                                                |
| `step(from, to, migrate)`                                                  | A pure migration; it returns the next row or `Unmigratable`, and never changes the key.                                                                                                                                                              |
| `member(store, name)`                                                      | `<id>:<name>`, a family's collection.                                                                                                                                                                                                                |
| `registry({ stores, retired?, outbox? })`                                  | Every declaration, checked: two with one id, or an unstamped version no payload has, is an `InvalidDeclaration`. Its `epoch` grows with every change.                                                                                                |
| `apply(registry, sql)`                                                     | Brings the device store on `sql` to the registry's versions, one transaction per local collection; synced ones are left to the persistence, which drops their rows. Answers a `Report`; fails with `MigrationFailed`.                                |
| `prepare(registry)`                                                        | `{ epoch, success: Report, run }`, which `@smthrs/platform-browser`'s leader runs as `device/prepare` before it serves the database.                                                                                                                 |
| `outbox(registry)`                                                         | The `OutboxUpgrade` `Outbox.layer` takes: `stamp`, and `write(stored)`, which answers `Current`, `Upgraded` or `Parked` with a reason.                                                                                                               |
| `promiseSql(database)`                                                     | `Sql` over a database with a `Promise` `execute`.                                                                                                                                                                                                    |
| `fingerprint(schema)`, `lock(registry, previous)`, `check(registry, lock)` | The lock: each version's fingerprint, recorded without ever rewriting one, and the `Problem`s a registry has against it.                                                                                                                             |
| `declarationOf`, `declared`                                                | The declaration a stored collection belongs to, and whether a collection is declared at a version and kind (`Undeclared` when not).                                                                                                                  |
| `KEPT_TABLE`                                                               | `device_kept`: rows set aside, with their collection, key, version, stored value, reason and time.                                                                                                                                                   |
| `migrations`, `rowsKept`, `applyMs`                                        | Counter `device_migrations` by `store` and `outcome`; counter `device_rows_kept` by `store` and `reason`; histogram `device_migrate_ms`.                                                                                                             |
| `Unmigratable`, `InvalidDeclaration`, `Undeclared`, `MigrationFailed`      | The errors: a migration refused a row; a declaration can't hold; a collection opened undeclared; a statement failed and its collection rolled back.                                                                                                  |
