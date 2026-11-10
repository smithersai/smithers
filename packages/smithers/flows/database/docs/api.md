---
title: "API reference"
description: "Every public export of @smthrs/database: the DurableWriter service and its layers, the DatabaseError vocabulary, the Migrations composer, the PostgreSQL adapter, the Node SQLite driver, the in-memory test layer, and the metric handles."
---

The root entry point bundles for browsers. It carries the PostgreSQL adapter,
whose `@effect/sql-pg` driver the caller injects. The SQLite drivers are
platform specific and live at explicit subpaths.

| Import                                       | Exports                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@smthrs/database`                           | `DurableWriter`, `Migrations`, `DatabaseMetrics`, `UnsupportedBackend`, `PostgresDatabase` as namespaces |
| `@smthrs/database/DurableWriter`             | the write boundary, its errors, and its layers                                                           |
| `@smthrs/database/Migrations`                | the migration composer                                                                                   |
| `@smthrs/database/DatabaseMetrics`           | the write-retry counter and the writer-lock wait timer                                                   |
| `@smthrs/database/UnsupportedBackend`        | the ignored connection-string names                                                                      |
| `@smthrs/database/Dialect`                   | SQL fragments that read the same on SQLite and PostgreSQL                                                |
| `@smthrs/database/node/NodeDatabase`         | Node only. The `node:sqlite` client layer                                                                |
| `@smthrs/database/bun/BunDatabase`           | Bun only. The `bun:sqlite` client layer                                                                  |
| `@smthrs/database/postgres/PostgresDatabase` | The same module as the root's `PostgresDatabase`; import it from the root                                |
| `@smthrs/database/test/TestDatabase`         | Node only. The isolated test client and writer, and fixture helpers                                      |

`@smthrs/database/internal/*` is blocked by the export map.

## Example

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as SqlClient from "effect/sql/SqlClient"

const insertNote = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter.DurableWriter
  yield* writer.write(sql`INSERT INTO notes (id, body) VALUES ('first', 'hello')`)
})
```

## DurableWriter

The write boundary shared by the durable stores, free of journal or host
knowledge. Queries go through Effect's `SqlClient` directly; only writes come
here.

### DurableWriter

```ts
class DurableWriter extends Context.Service<DurableWriter, Service>()("@smthrs/database/DurableWriter") {}
```

The service tag. `yield* DurableWriter.DurableWriter` resolves the writer.

### Service

```ts
interface Service {
  readonly write: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, Exclude<E, SqlError.SqlError> | DatabaseError, R>
}
```

`write` runs `effect` inside one transaction with transaction-scoped retries,
and widens the error channel with `DatabaseError`. Every `SqlError` in a failed
cause is normalized to a `DatabaseError` on the way out.

Two guarantees are contract rather than implementation detail:

- **Serialization.** Two concurrent `write` transactions are mutually
  serialized. They may not both commit results computed from snapshots that
  exclude each other's writes.
- **Acquisition.** Outermost writes sharing one writer queue for its permit
  before entering SQL, at the caller's own interruptibility. An interruptible
  caller cancelled or timed out while queued acquires nothing; a caller that
  masked interruption keeps waiting, so a finalizer's cleanup write still
  commits.
- **Nesting.** A `write` inside the client's open transaction joins it as a
  savepoint and does not retry. Only the outermost `write` retries, replaying
  the whole transaction body verbatim against committed state. Its
  classification follows `cause` chains, so a nested store's domain error that
  preserves `cause` still keeps the outermost transaction replaying.

See [the write boundary](./concepts/write-boundary.md).

### afterCommit

```ts
const afterCommit: (update: Effect.Effect<void>, client?: SqlClient.SqlClient) => Effect.Effect<boolean>
```

Registers a short, non-failing process-local update inside a managed `write`.
The outermost successful commit runs it once, outside SQL retries. Failed
attempts and rolled-back savepoints discard their registrations. The update
runs uninterruptibly; it must not block or perform external deliveries.

`client` scopes the registration to that client's managed write. A store passes
its captured client, `DurableWriter.afterCommit(publish, sql)`, so an update
that belongs to one database cannot ride the commit of a nested write to
another one: the call answers `false` when the open scope belongs to a
different client. Omitting `client` accepts whichever managed write is open.

Returns `false` without running the update when the current transaction is not
owned by the writer, including raw SQL transactions/savepoints. Skip optional
cache publication in that case; never publish uncommitted data as a fallback.
See [commit ownership](./concepts/write-boundary.md#process-local-state-follows-the-outer-commit).

### make

```ts
const make: (sql: SqlClient.SqlClient, options?: WriteRetryOptions | undefined) => Service
```

Builds the writer around an existing SQL client. Accepts any Effect
`SqlClient`, which is why the retry classification is dialect blind.

### layer

```ts
const layer: (options?: WriteRetryOptions | undefined) => Layer.Layer<DurableWriter, never, SqlClient.SqlClient>
```

Provides the writer over the context's SQL client. Compose it above a driver
layer with `Layer.provideMerge` so both services stay in the output.

### makeNoop

```ts
const makeNoop: () => Service
```

A writer stub whose every write fails with `DatabaseError` code `unsupported`.

### layerNoop

```ts
const layerNoop: Layer.Layer<DurableWriter>
```

Provides the unsupported writer stub.

### WriteRetryOptions

```ts
interface WriteRetryOptions {
  readonly maxAttempts?: number | undefined
  readonly baseDelayMs?: number | undefined
  readonly maxDelayMs?: number | undefined
}
```

| Field         | Default | Meaning                                                |
| ------------- | ------- | ------------------------------------------------------ |
| `maxAttempts` | `10`    | Total attempts, including the initial write.           |
| `baseDelayMs` | `50`    | Initial exponential backoff delay, in milliseconds.    |
| `maxDelayMs`  | `10000` | Upper bound for a single retry delay, in milliseconds. |

Jitter is applied before the cap, so `maxDelayMs` bounds the delay that is
actually slept. Any value that is not a safe integer of at least 1 clamps to 1.
Delays use Effect's `Clock`, so `TestClock` drives them.

### DatabaseErrorCode

```ts
const DatabaseErrorCode: Schema.Literals<["busy", "constraint", "io", "schema", "unsupported", "unknown"]>
type DatabaseErrorCode = typeof DatabaseErrorCode.Type
```

The stable failure categories this package exposes.

### DatabaseError

```ts
class DatabaseError extends Schema.TaggedError<DatabaseError>()("@smthrs/database/DatabaseError", {
  code: DatabaseErrorCode,
  cause: Schema.optional(Schema.Defect())
}) {}
```

A normalized database failure, suitable for consumers outside a driver. Narrow
it with `Schema.is(DatabaseError)` or catch it by its tag
`@smthrs/database/DatabaseError`.

| Code          | Meaning                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `busy`        | A transient lock or serialization conflict. The only category that is replayed.        |
| `constraint`  | A constraint or unique violation. Never replayed: it is the first-writer-wins signal.  |
| `io`          | An I/O failure. Normalized but never replayed, even when a busy cause sits beneath it. |
| `schema`      | A statement named a table or column the database lacks: a store older than the binary. |
| `unsupported` | The noop writer, or a raw result with no readable affected-row count.                  |
| `unknown`     | A SQL failure in none of the above categories.                                         |

### fromSqlError

```ts
const fromSqlError: (error: SqlError.SqlError) => DatabaseError
```

Converts an Effect SQL error into the stable vocabulary. The category comes
from the same classifier the retry decision reads, so the code a caller is told
and the decision to replay cannot disagree about one error.

Classification, in precedence order: a lock timeout is `busy`; a constraint or
unique violation is `constraint`; an I/O cause is `io`; a busy cause is `busy`;
a missing table or column is `schema`; anything else is `unknown`.

The busy vocabulary is `SQLITE_BUSY*`, `SQLITE_LOCKED*`, SQLSTATE `40001`,
`40P01`, `55P03`, and the texts `database is locked`, `database is busy`,
`could not serialize access`, `deadlock detected`, and
`cannot rollback - no transaction is active`. The I/O vocabulary is
`SQLITE_IOERR*` and the text `disk i/o error`. The schema vocabulary is
SQLSTATE `42P01`, `42703`, and the texts `no such table` and `no such column`.

### codeOf

```ts
const codeOf: (error: unknown) => DatabaseErrorCode | undefined
```

The code a failure carries, found by following `cause` chains through the
domain errors that wrap a structured SQL error or a normalized
`DatabaseError`, including one a store redacted to its code alone. `undefined`
when the chain has no SQL provenance.

### affectedRows

```ts
const affectedRows: (raw: unknown) => Effect.Effect<number, DatabaseError>
```

Reads how many rows a write statement affected from a driver's raw result,
which `SqlClient` exposes as `.raw`. Reads an own `changes` property (SQLite
drivers) or an own `rowCount` property (node-postgres).

A count is accepted as a non-negative safe integer, or as an exact `bigint` in
that range, which is what `node:sqlite` returns when `SqlClient.SafeIntegers`
is enabled. Only an own data property counts, so an inherited field is ignored
and an accessor is never executed.

Fails with code `unsupported` when neither field is readable. The failure's
`cause` carries the shape of the result and never its values: its type, up to
eight key names, and its length if it was an array.

See [Read a write's affected-row count](./guides/count-affected-rows.md).

## Migrations

Composes per-package SQL migration sets over one migrations table.

### table

```ts
const table: "flows_migrations"
```

The single table every Smithers package records its applied migrations in. Its
presence is also what tells the Node driver that a file is a Smithers 1.0
database.

### idBlock

```ts
const idBlock: 1000
```

The spacing between the migration id blocks packages reserve with
`MigrationSet.idOffset`. A package may ship this many migrations before it
would reach its neighbour.

### MigrationSet

```ts
interface MigrationSet {
  readonly namespace: string
  readonly idOffset: number
  readonly migrations: Readonly<Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>>
}
```

One package's migrations, namespaced so they cannot collide with another
package's.

| Field        | Meaning                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`  | Prefixes every migration name in the ledger. Unique among the sets composed together.                                                             |
| `idOffset`   | A non-negative safe integer multiple of `idBlock`, unique among the sets composed together. Lifts the set's local ids into the block it reserves. |
| `migrations` | Keyed `<localId>_<name>`, with the local id in `0..idBlock - 1`.                                                                                  |

### loader

```ts
const loader: (sets: ReadonlyArray<MigrationSet>) => Migrator.Loader<SqlClient.SqlClient>
```

Builds a `Migrator` loader from namespaced sets, resolved into one list ordered
by global migration id rather than by the order the sets were given.

The set list and each migration record are snapshotted when this function is
called, so later caller mutation cannot change a loader already returned.

It fails the migration, as a `Migrator.MigrationError` of kind `BadState`,
rather than returning a list the migrator would quietly mishandle:

| Rejected                             | Message                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Duplicate namespace                  | `Duplicate migration namespace: <namespace>`                                                                   |
| Duplicate offset                     | `Duplicate migration id offset <offset> for namespace <namespace>`                                             |
| Negative or fractional offset        | `... an id offset must be a non-negative integer`                                                              |
| Unsafe integer offset                | `... an id offset must be a safe integer in the range 0..<max>`                                                |
| Misaligned offset                    | `... an id offset must be a multiple of idBlock (1000)`                                                        |
| Malformed key                        | `Malformed migration key "<key>" in namespace <namespace>`                                                     |
| Local id at or above `idBlock`       | `Local migration id <id> ... is outside the block range 0..999 and would claim a neighbouring package's block` |
| Two keys realizing one id            | `Migration id <id> is claimed twice: <owner> and <claimant>`                                                   |
| A historical hole or new lower block | `Migration <id>_<name> would be skipped: the database has already applied migration id <highWater> ...`        |
| A recorded id/name mismatch          | `Migration <id> was recorded as <name>, but this package declares <otherName>`                                 |
| An unreadable ledger id              | `flows_migrations contains an invalid migration_id: <value>`                                                   |

On a fresh database the loader applies global id zero itself, inside the
migrator's transaction, because the migrator's high-water mark starts at zero
and would silently skip it. A caller wiring the loader into its own `Migrator`
therefore gets id zero applied. The loader also applies forward additions to
an installed package block below the global high-water mark. Each such block
must include a declaration matching an already recorded id and name. Earlier
holes, changed recorded names, and newly introduced lower blocks are refused.
All applications share the migrator transaction. The upstream migrator's
completed list omits loader-applied entries; use `run` to receive the complete
list.

### run

```ts
const run: (sets: ReadonlyArray<MigrationSet>) => Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  SqlClient.SqlClient
>
```

Runs every migration in the given sets that has not been applied yet, and
answers the `[id, name]` pairs it applied on this pass, including id zero and installed lower-block appends. A
pass with nothing to do answers an empty array.

The whole migrator pass, the `BEGIN IMMEDIATE`, the loader, and the pending
migrations, retries on the same transient-lock vocabulary the durable writer
uses, so two connections migrating one SQLite file serialize instead of failing
on the peer's write lock.

A failing migration takes the whole pass with it: the partial DDL and the
ledger rows roll back, and it surfaces as a `Failed` `MigrationError` on the
defect channel.

### layer

```ts
const layer: (sets: ReadonlyArray<MigrationSet>) => Layer.Layer<
  never,
  Migrator.MigrationError | SqlError,
  SqlClient.SqlClient
>
```

Runs the given migration sets before exposing the database to durable services.

See [the migration ladder](./concepts/migration-ladder.md) and
[Add a migration](./guides/add-a-migration.md).

## DatabaseMetrics

Metric definitions for the durable write boundary. This module defines handles
only. No exporter ships here: provide one, for example from
[`@smthrs/observability`](/api/observability), and the metrics appear in it.

### writeRetries

```ts
const writeRetries: Metric.Counter<number>
```

Counter `flows_db_write_retries`, described as "Durable write transaction
replays after transient conflicts". Incremented once per scheduled retry of a
recognized transient conflict, across every store that writes through the
boundary. The attempt that finally fails past the retry budget is not counted:
it surfaces on the error channel instead.

### writerLockWait

```ts
const writerLockWait: Metric.Histogram<Duration.Duration>
```

Timer `flows_db_writer_lock_wait`, in milliseconds, described as "Time a
PostgreSQL durable write waited for its schema's writer lock". It measures from
the write's first attempt to holding the lock, across every wait that ran out
and every backoff between them. A writable `PostgresDatabase`
client records one observation per transaction it begins: each outermost
`DurableWriter.write` and each `withTransaction`. Read-only clients, statements
outside a transaction, and SQLite record nothing. Writes to one schema commit
one at a time, so a rising wait means that schema's write rate is at the lock's
ceiling; see [the writer lock](./concepts/sqlite-only.md#the-writer-lock).

### connectionWait

```ts
const connectionWait: Metric.Histogram<Duration.Duration>
```

Timer `flows_db_connection_wait`, in milliseconds, described as "Time a
PostgreSQL statement or transaction waited for a pooled connection". A
`PostgresDatabase` client records one observation per connection it takes from
its pool, and a wait that runs past `acquireWarning` also logs
`postgres.connection.waiting` while it waits. A rising wait means the pool is
too small for the work sent through it, or the pooler in front of the server
grants no connection.

### loginFailures

```ts
const loginFailures: Metric.Counter<number>
```

Counter `flows_db_login_failures`, described as "PostgreSQL connections that
failed to open or log in". A `PostgresDatabase` client adds one for each
connection that was refused or timed out while opening (`ConnectionError`) or
whose login the server refused (`AuthenticationError`), and logs a
`postgres.login.failed` warning with the error's kind as `db.error`, and a
connection failure's driver text as `db.error.message`. A rising rate means
the server or a pooler in front of it is refusing clients, such as a compute
out of connections.

### writerLockTimeouts

```ts
const writerLockTimeouts: Metric.Counter<number>
```

Counter `flows_db_writer_lock_timeouts`, described as "PostgreSQL writer-lock
waits that reached the timeout and released their server connection". A
writable `PostgresDatabase` client adds one each time a write's wait for the
writer lock reaches its `writerLockTimeout`, rolls back and backs off. A quiet
system reads zero; a rising rate means more writers queue on one schema than
the timeout covers.

## UnsupportedBackend

Notices for unsupported legacy configuration names. This string-only module
is browser safe.

### ignoredNames

```ts
const ignoredNames: (environment: Readonly<Record<string, string | undefined>>) => ReadonlyArray<string>
```

Production ignores `SMITHERS_TEST_PG_URL` and legacy `SMITHERS_POSTGRES_*`
knobs other than `SMITHERS_POSTGRES_URL` and `SMITHERS_POSTGRES_SCHEMA`. Sorted, so an operator reading two runs
compares two identical lists. An exported-but-blank name counts as unset.

The separator is part of the prefix, so `SMITHERS_POSTGRESQL_URL`, a name
neither release reads, is not announced.

### ignoredNotice

```ts
const ignoredNotice: (name: string) => string
```

The one line an ignored name gets:

```text
ignored: SMITHERS_TEST_PG_URL has no effect in 1.0.0-rc.17 (use SMITHERS_POSTGRES_URL to select PostgreSQL)
```

It is a notice, not a refusal: it changes no exit code and no result.

## NodeDatabase

Node only. `import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"`.

Defaults to `node:sqlite` through `@effect/sql-sqlite-node`; a configured
PostgreSQL URL selects `PostgresDatabase` instead. The write policy lives in `DurableWriter.layer`, composed on top.

### layer

```ts
const layer: (options: NodeDatabaseOptions) => Layer.Layer<SqlClient.SqlClient>
```

Provides the SQL client. WAL is enabled by the underlying client by default.

The error channel is `never` by design, so every durable package composes it
unchanged. A refused open is raised as a defect carrying `UnsupportedDatabase`,
and a lock during construction is retried on a fixed ladder of 40 attempts with
a 5 ms base delay capped at 250 ms. That ladder is not configurable: it bounds a
driver-internal race during layer construction, before any service exists to
configure.

### postgresLocation

```ts
const postgresLocation: (filename: string) => { readonly url: string; readonly schema: string } | undefined
```

Where `layer` would open `filename` on PostgreSQL: the connection URL without
its `schema` parameter, and the schema. It is `undefined` for a store SQLite
keeps, and it raises the same `UnsupportedDatabase` refusals `layer` does.
`postgres://…?schema=<schema>` opens that exact schema, so a caller that copies
a store into another schema addresses the copy by URL.

### NodeDatabaseOptions

```ts
interface NodeDatabaseOptions {
  readonly filename: string
  readonly mode?: number | undefined
  readonly busyTimeout?: Duration.Input | undefined
  readonly sqlite?: Omit<SqliteClient.SqliteClientConfig, "filename"> | undefined
  readonly readOnly?: boolean | undefined
}
```

| Field         | Meaning                                                                                                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filename`    | The SQLite database filename. A `file:` URI is accepted, and `:memory:` opens a private in-memory database. The parent directory is not created.                                                                                              |
| `mode`        | Creation permissions for a new plain-path database, masked by the process umask. Defaults to `0o600`; WAL and SHM sidecars inherit the main file's mode. Existing files, `file:` URIs, temporary databases and read-only opens are unchanged. |
| `busyTimeout` | Synchronous SQLite lock wait. Defaults to `0` so open and durable-write retries wait cooperatively, and to one second for a read-only open. Overrides `sqlite.busyTimeout` when supplied.                                                     |
| `sqlite`      | Additional driver configuration. WAL remains enabled unless explicitly disabled. An explicit `sqlite.busyTimeout` is honored when `busyTimeout` is absent.                                                                                    |
| `readOnly`    | Opens an existing store for reading only. SQLite opens read-only without converting to WAL; PostgreSQL skips schema creation and runs every transaction `READ ONLY`. Nothing is created, migrated or locked for writing.                      |

### UnsupportedDatabaseCode

```ts
const UnsupportedDatabaseCode: Schema.Literals<[
  "unsupported_runtime",
  "unsupported_database_file",
  "database_locked",
  "postgres_url_missing",
  "postgres_url_invalid",
  "postgres_schema_invalid"
]>
type UnsupportedDatabaseCode = typeof UnsupportedDatabaseCode.Type
```

### UnsupportedDatabase

```ts
class UnsupportedDatabase extends Schema.TaggedError<UnsupportedDatabase>()(
  "@smthrs/database/UnsupportedDatabase",
  { code: UnsupportedDatabaseCode, message: Schema.String }
) {}
```

A refusal to open a durable database in 1.0.0-rc.17, raised as a defect rather
than a typed failure because neither refusal is recoverable at run time.
`NodeDatabase`, `BunDatabase` and `PostgresDatabase` re-export the same
constructor, code schema and refinement.

| Code                        | Refused when                                                       | Message                                                                                                        |
| --------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `unsupported_runtime`       | `process.versions.bun` is set                                      | `Use @smthrs/database/bun/BunDatabase under Bun; NodeDatabase requires Node.js >=22.19.0`                      |
| `unsupported_database_file` | the file has at least one table and no `flows_migrations` table    | `<path> is not a Smithers 1.0 database (1.0.0-rc.17 does not load a 0.x smithers.db)`                          |
| `database_locked`           | a peer held the file for the whole open ladder                     | `<path> could not be inspected because another process holds it`                                               |
| `postgres_url_missing`      | `SMITHERS_BACKEND=postgres` with no PostgreSQL URL set             | `PostgreSQL requires SMITHERS_POSTGRES_URL or DATABASE_URL`                                                    |
| `postgres_url_invalid`      | the selected URL is not a parseable `postgres://` URL              | `PostgreSQL configuration requires a postgres:// or postgresql:// URL`, or `Invalid PostgreSQL connection URL` |
| `postgres_schema_invalid`   | `PostgresDatabase.layer` gets an empty, NUL or over-63-byte schema | `PostgreSQL schema must contain 1 to 63 UTF-8 bytes and no NUL`                                                |

### isUnsupportedDatabase

```ts
const isUnsupportedDatabase: (input: unknown) => input is UnsupportedDatabase
```

Narrows an unknown defect to this driver's refusal. Use it in
`Effect.catchDefect` and re-raise anything else unchanged.

## BunDatabase

Bun only. `import * as BunDatabase from "@smthrs/database/bun/BunDatabase"`.

`layer(options: BunDatabaseOptions): Layer.Layer<SqlClient.SqlClient>` provides
a `bun:sqlite` client with the same schema guard, bounded open retries and
failed-commit recovery as NodeDatabase. As on Node, `.raw` on a write without
result columns returns `{ changes, lastInsertRowid }`, so `affectedRows` reads
its count; the upstream `@effect/sql-sqlite-bun` client returns `[]` there.
Options contain `filename`, optional
`sqlite` settings from that Bun driver, and `readOnly`, which behaves as on
NodeDatabase. A new plain-path database is created
with mode `0o600`, masked by the process umask, and its WAL and SHM sidecars
inherit that mode. Existing files, `file:` URIs, temporary databases and opens
whose settings disable creation are left to SQLite. Install its matching optional peer;
consumers using only Node do not need it. It re-exports the same
`UnsupportedDatabase` constructor and refinement as `NodeDatabase`.

## TestDatabase

Node only. `import * as TestDatabase from "@smthrs/database/test/TestDatabase"`.

### layer

```ts
const layer: Layer.Layer<DurableWriter.DurableWriter | SqlClient.SqlClient>
```

Provides the production client and the production durable writer over a fresh,
isolated database. By default that is an in-memory SQLite database:
`:memory:` is private to a connection, so both halves share one connection and
serialization comes from the client's in-process transaction mutex rather than
from the database. When `SMITHERS_TEST_PG_URL` is set, the layer instead creates
a schema named `test_<uuid>` on that server and drops it when the layer's scope
closes. Never set `SMITHERS_TEST_PG_URL` to a production server.

`sqliteLayer` is the in-memory SQLite form alone, whatever the environment says.

### Fixture helpers

Each helper takes the test's `SqlClient` and works on SQLite and PostgreSQL.
They exist to build states production code refuses to write; never call them on
a production database.

| Helper                      | What it does                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks(sql, enabled)`      | Turns `CHECK` constraints off and back on. PostgreSQL drops the current schema's checks and re-adds them `NOT VALID`, so rows written while they were off stay.                    |
| `foreignKeys(sql, enabled)` | The same for foreign keys, so a fixture can hold orphaned rows.                                                                                                                    |
| `dropTrigger(sql, name)`    | Drops the trigger `name` wherever it is in the current schema. Unlike `Dialect.dropTrigger`, it needs no table name.                                                               |
| `catalog(sql)`              | A relation with SQLite's `sqlite_master` columns (`name`, `tbl_name`, `type`, `sql`) for asserting on tables, indexes and triggers.                                                |
| `explain(sql, statement)`   | The query plan of `statement` as `{ detail }` rows. On PostgreSQL sequential scans are disabled for the plan, so a small fixture still shows whether an index can serve the query. |
| `until(predicate)`          | Polls `predicate` every 2 ms and dies after 2000 polls without `true`.                                                                                                             |
| `dropSchema(sql, schema)`   | Drops a PostgreSQL test schema after taking its writer lock, so it waits for an in-flight transaction instead of deadlocking with it.                                              |

See [Test against a database](./guides/test-against-a-database.md).

## PostgresDatabase

`import { PostgresDatabase } from "@smthrs/database"`. The module bundles for
browsers and imports no socket code: the caller passes the `@effect/sql-pg`
module as `driver`. That driver connects through `node:net` and `node:tls`,
which Node, Bun and Cloudflare Workers with `nodejs_compat` provide.

### layer

```ts
const layer: (options: PostgresDatabaseOptions) => Layer.Layer<SqlClient.SqlClient>
```

Provides `SqlClient` over a connection pool. Compose `DurableWriter.layer()`
and the owning migration set on top, as with SQLite. A writable client creates
`schema` when it is absent. An invalid schema throws `UnsupportedDatabase`
with `postgres_schema_invalid` when `layer` is called; a connection failure
while the layer builds is a defect.

The client never changes session state, so it is correct behind a
transaction-pooling proxy such as Cloudflare Hyperdrive or PgBouncer with
`pool_mode=transaction`. Every statement runs inside a transaction that sets
`search_path` to `schema` for that transaction only (`SET LOCAL`):

| Statement                        | Transaction                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| inside `withTransaction`         | `READ COMMITTED READ WRITE`, then the schema's writer lock, taken before any statement of the body            |
| inside `withTransaction`, nested | a savepoint in the enclosing transaction                                                                      |
| outside a transaction            | its own `READ COMMITTED READ WRITE` transaction, without the writer lock; a stream commits after its last row |
| any, on a `readOnly` client      | `REPEATABLE READ READ ONLY`, never the writer lock                                                            |

A statement outside a transaction therefore costs `BEGIN`, the schema and
`COMMIT` around it. A statement prepared by name is session state too, so
every statement goes out unnamed. Cloudflare Hyperdrive drops a connection
that closes a named statement, which `@effect/sql-pg` does once its
100-statement cache is full. PostgreSQL answers `COMMIT` in a transaction a caught
statement failure aborted with `ROLLBACK`; the client fails that transaction
with `SqlError` instead of reporting it committed.

A write waits for the writer lock at most `writerLockTimeout` at a time, so a
long queue of writers never holds every server connection a pooler grants.
A wait that runs out rolls the transaction back, letting its connection go,
counts once in `DatabaseMetrics.writerLockTimeouts`, and tries again after a
jittered backoff from half the timeout to four times it. The limit is
`SET LOCAL lock_timeout`, so any lock the write waits on longer afterwards fails
with `lock_not_available`, which `DurableWriter` retries.

### defaultAcquireWarning

```ts
const defaultAcquireWarning: Duration.Duration
```

Ten seconds: how long a wait for a pooled connection runs before it logs a
`postgres.connection.waiting` warning, unless `acquireWarning` says otherwise.
`DatabaseMetrics.connectionWait` times every wait.

### defaultWriterLockTimeout

```ts
const defaultWriterLockTimeout: Duration.Duration
```

Two seconds: how long one wait for the writer lock holds a server connection
unless `writerLockTimeout` says otherwise. It is well under the 15 seconds
Cloudflare Hyperdrive lets a client wait for a connection before closing it.

### PostgresDatabaseOptions

```ts
interface PostgresDatabaseOptions {
  readonly url: string
  readonly driver: Driver
  readonly schema?: string | undefined
  readonly postgres?:
    | Omit<Pg.PgClient.PgPoolConfig, "url" | "types" | "prepare" | "preparedStatementCacheSize">
    | undefined
  readonly readOnly?: boolean | undefined
  readonly writerLockTimeout?: Duration.Input | undefined
  readonly acquireWarning?: Duration.Input | undefined
}
```

| Field               | Meaning                                                                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`               | The connection URL. It reaches the driver as a `Redacted` value. For Hyperdrive, pass the binding's `connectionString`.                                                                                                                                                                   |
| `driver`            | The `@effect/sql-pg` module: `import * as Pg from "@effect/sql-pg"`, then `driver: Pg`.                                                                                                                                                                                                   |
| `schema`            | Defaults to `smithers_flows`. It must be 1 to 63 UTF-8 bytes without NUL.                                                                                                                                                                                                                 |
| `postgres`          | Effect PostgreSQL pool and connection options. Smithers owns the type registry, which reads integers back as exact JavaScript numbers, and turns named prepared statements off.                                                                                                           |
| `readOnly`          | Reads an existing schema without creating it or taking the writer lock; every transaction is `READ ONLY`.                                                                                                                                                                                 |
| `writerLockTimeout` | How long one wait for the writer lock may hold a server connection; `defaultWriterLockTimeout` when unset. A zero duration tries the lock once per attempt; an infinite one waits without limit.                                                                                          |
| `acquireWarning`    | How long a statement or transaction waits for a pooled connection before a `postgres.connection.waiting` warning says so; `defaultAcquireWarning` when unset. The wait goes on, with the caller's interruptibility, so a finalizer's write still commits after its caller is interrupted. |

### Driver

```ts
type Driver = Pick<typeof Pg, "PgClient" | "PgTypes">
```

The two `@effect/sql-pg` modules the adapter drives: `PgClient` for the pool
and statement compiler, and `PgTypes` for the numeric codecs.

`UnsupportedDatabase`, `UnsupportedDatabaseCode` and `isUnsupportedDatabase`
are re-exported here, so a Worker matches a refusal without a SQLite driver.

```ts
import * as Pg from "@effect/sql-pg"
import { DurableWriter, PostgresDatabase } from "@smthrs/database"
import { Layer } from "effect"

const database = (connectionString: string) =>
  Layer.provideMerge(
    DurableWriter.layer(),
    PostgresDatabase.layer({ url: connectionString, driver: Pg, schema: "smithers_flows" })
  )
```

See [configuration and isolation](./concepts/sqlite-only.md).

## Dialect

`import * as Dialect from "@smthrs/database/Dialect"`.

SQL fragments that let one store and one migration run on SQLite and
PostgreSQL. Each takes the store's `SqlClient` and emits the form for its
backend. Fragments that accept names, paths or trigger text splice them into
SQL unescaped: pass only constants the store owns.

| Export                          | SQLite                                      | PostgreSQL                                                |
| ------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `isPostgres(sql)`               | `false`                                     | `true`                                                    |
| `isReadOnly(sql)`               | `true` for a `readOnly` open                | `true` for a `readOnly` open                              |
| `integer(sql)`                  | `INTEGER`                                   | `NUMERIC`, so a fractional write is kept and rejected     |
| `isInteger(sql, value)`         | `typeof(value) = 'integer'`                 | `trunc(value) = value`                                    |
| `jsonValid(sql, value)`         | `json_valid(value)`                         | `value IS JSON`                                           |
| `jsonText(sql, value, path)`    | `json_extract(value, path)`                 | `value::jsonb #>> '{…}'`                                  |
| `identity(sql)`                 | `INTEGER PRIMARY KEY AUTOINCREMENT`         | `BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`     |
| `rowId(sql)`                    | empty: every table has a `rowid`            | `rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,`       |
| `greatest(sql)`                 | `MAX`                                       | `GREATEST`                                                |
| `indexHint(sql, name)`          | `INDEXED BY name`                           | empty                                                     |
| `tables(sql)`                   | tables in `sqlite_master`                   | tables in the current schema                              |
| `columns(sql, table)`           | `PRAGMA table_info`                         | `information_schema.columns` in the current schema        |
| `trigger(sql, options)`         | `CREATE TRIGGER … BEGIN … END`              | a `<name>_fn` function and a row trigger                  |
| `dropTrigger(sql, name, table)` | `DROP TRIGGER name`                         | `DROP TRIGGER name ON table`                              |
| `query(sql, template, values)`  | runs `template` with `?` placeholders       | rewrites each `?` to `$1`, `$2`, …                        |
| `readTransaction(sql, effect)`  | a deferred `BEGIN` on a reserved connection | `REPEATABLE READ READ ONLY`, opened by `PostgresDatabase` |

`jsonText` reads a string member as the same text on both backends. Other
scalars differ: SQLite returns JSON `true` as the integer `1` and numbers as
numbers, PostgreSQL returns the text `'true'` and `'7'`. Compare a boolean
member against both forms.

`readTransaction` runs `effect` as one read transaction: every statement in it
reads one snapshot, and it takes no writer lock, so a writer may commit while
it reads. Inside a transaction already, `effect` joins it. Every statement on a
`PostgresDatabase` reserved connection runs as its own transaction, so that
client opens the read transaction itself; any other PostgreSQL client reads at
`REPEATABLE READ READ ONLY` on a reserved connection. Keep writes out of
`effect`: PostgreSQL refuses them, and on SQLite one takes the write lock.

`registerReadTransaction(sql, open)` is for a driver whose SQL cannot say
`BEGIN`: `readTransaction` on that client runs `open(effect)` instead. A
Durable Object's SQLite storage is one; `@smthrs/platform-cloudflare`'s
`ObjectDatabase` registers `storage.transaction()` there.

`trigger` rejects a row with `reject` as its message (a constraint failure on
both backends), skips it with `ignore: true`, or runs `body`; `when` limits it
to rows where the condition holds. `query` does not parse SQL, so its template
must not contain `?` anywhere but a placeholder.

A native SQL defect before a write body starts is a typed `DatabaseError`,
including failed transaction acquisition and its rollback. Intentional SQL
defects raised by the write body keep their original channel. A lost PostgreSQL
connection therefore leaves the engine’s attempt available for recovery.
