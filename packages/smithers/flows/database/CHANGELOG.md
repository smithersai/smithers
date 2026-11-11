# @smthrs/database

## [Unreleased]

### Breaking Changes

- `PostgresDatabase.layer` requires `driver`, the `@effect/sql-pg` module
  (`import * as Pg from "@effect/sql-pg"`, then `driver: Pg`). The adapter
  imports only its types, so it bundles for browsers and Workers supply the
  sockets. `NodeDatabase`, `BunDatabase` and `TestDatabase` load the driver
  themselves, as before.

### Added

- `DurableWriter.afterRollback(undo, client?)` registers an undo of
  process-local state that runs when the managed write does not commit: a
  failed or interrupted body, a rejected COMMIT, or an attempt the writer
  retries. A successful savepoint hands its undos to its parent.
- `PostgresDatabase` is exported from the root entry point, with
  `UnsupportedDatabase`, `UnsupportedDatabaseCode` and `isUnsupportedDatabase`
  re-exported on it. The `postgres/PostgresDatabase` subpath is the same module.
- `DatabaseMetrics.writerLockWait`, the timer `flows_db_writer_lock_wait`: how
  long each PostgreSQL write transaction waited for its schema's writer lock.
- `test/WriterLock.bench.ts` and `pnpm bench`: durable writes per second
  through the writer lock, through PgBouncer and directly.
- `Dialect.readTransaction(sql, effect)` runs `effect` as one read transaction
  that reads one snapshot and takes no writer lock: a deferred `BEGIN` on
  SQLite and `REPEATABLE READ READ ONLY` on PostgreSQL, which
  `PostgresDatabase` opens itself because every statement on its reserved
  connections runs as its own transaction. It replaces the read transaction
  `@smthrs/engine-store` opened on a reserved connection, which failed on
  `PostgresDatabase` with `SET TRANSACTION ISOLATION LEVEL must be called
  before any query`.

### Fixed

- `PostgresDatabase` is correct behind transaction-pooling proxies such as
  Cloudflare Hyperdrive and PgBouncer with `pool_mode=transaction`. It no longer
  runs `SET search_path` or `SET default_transaction_read_only` on a session:
  every statement runs in a transaction that sets the schema with `SET LOCAL`
  and states `READ WRITE` or `READ ONLY`, and a statement outside
  `withTransaction` gets a transaction of its own. Before, a proxy could run a
  statement on a connection set to another schema, or none.
- The writer lock is keyed by the configured schema name rather than
  `current_schema()`. The key is unchanged while the schema exists; once it is
  dropped, `current_schema()` is `NULL` and the old statement took no lock.
- A transaction whose body caught a failed statement now fails with
  `PostgresDatabase: COMMIT rolled back an aborted transaction` instead of
  reporting the write committed when PostgreSQL rolled it back.

- The defect channel now demands the same `SqlError` provenance the typed
  channel does, so an application `Effect.die` whose message quotes lock text
  is no longer replayed. A driver rollback failure still qualifies: Effect's
  transaction wrapper runs `Effect.orDie` over a step whose error channel is
  `SqlError`, so the defect carries one.

## [1.0.0-rc.0] - 2026-08-31

### Breaking Changes

- Renamed the `Database` service to `DurableWriter` and removed its `sql`
  member: queries go through Effect's own `SqlClient` service, and the writer
  exposes only `write`. `DurableWriter.layer(options?)` composes over the
  context's `SqlClient`.
- `NodeDatabase.layer` now provides only the `SqlClient` (connection options
  only); retry tuning moved to `DurableWriter.layer`. `TestDatabase.layer`
  provides both the client and the writer.
- Removed the `unsupportedSql` proxy from `makeNoop`; the noop writer only
  fails `write` with `unsupported`.
- Removed the provisional Cloudflare Durable Object adapter and its Node fake.
  Real workerd rejects `SAVEPOINT`, so it cannot satisfy `DurableWriter`'s
  nested-write contract for arbitrary suspending Effects. Cloudflare engine and
  storage hosting remain outside 1.0.0-rc.0 core.

### Added

- `NodeDatabase.layer` refuses three opens before it creates a connection and
  raises `UnsupportedDatabase` as a defect for each: `unsupported_runtime` under
  Bun, `unsupported_database_file` for a 0.x `smithers.db`, and
  `database_locked` for a file a peer held for the whole open ladder.
  `UnsupportedDatabaseCode` and `isUnsupportedDatabase` are exported with them.
- `UnsupportedBackend.ignoredNames` and `UnsupportedBackend.ignoredNotice`
  report the `SMITHERS_TEST_PG_URL` and `SMITHERS_POSTGRES_*` names 1.0.0-rc.0
  ignores, so a project migrating from PostgreSQL is not left believing it ran
  against one.
- `Migrations` composes per-package migration sets over the single
  `flows_migrations` table, with `table`, `idBlock`, `MigrationSet`, `loader`,
  `run`, and `layer`.
- `DatabaseMetrics.writeRetries` counts write transaction replays as
  `flows_db_write_retries`.
- `WriteRetryOptions` is re-exported from `DurableWriter`, so the options type
  the public constructors accept has a public name.
- Package-owned documentation under `docs/`: the `api.md` reference, the
  concept pages, and the guides. The site projects them with
  `apps/site/scripts/sync-api-docs.mjs`.

### Changed

- A `write` nested inside the client's open transaction now joins it as a
  savepoint without its own retry; only the outermost transaction replays a
  transient conflict.
- The retry classifier follows `cause` chains, so a domain error wrapping a
  transient SQL failure keeps the outermost transaction replaying.
- Retry exhaustion now surfaces the original `Cause` rather than a single
  extracted value, so a defect stays a defect, an interrupt stays an interrupt,
  and a parallel non-database failure is no longer discarded.
- A typed failure must carry an Effect `SqlError` in its cause chain to be
  retried, so an application error whose message quotes database text is no
  longer replayed. A rollback defect stays matched on the defect channel.
- `fromSqlError` and `isRetryableWriteError` read one classifier, so the whole
  SQLite busy vocabulary normalizes to `busy` instead of retrying under a code
  that reports `unknown`, and an I/O failure that carries a busy cause beneath
  it is reported as `io` and never replayed, in either nesting order.
- The retry decision reads every reason a `Cause` carries, so a parallel failure
  that pairs a transient SQL error with an application error replays whichever
  half arrived first.
- `affectedRows` accepts an exact `bigint` count, which is what `node:sqlite`
  returns under `SqlClient.SafeIntegers`, reads only own data properties, and
  reports the shape of an unreadable result rather than attaching the result
  itself to the error.
- The open guard inspects a SQLite `file:` URI filename, which previously
  bypassed the 0.x `smithers.db` refusal, and probes it by path alone so a URI
  carrying `mode=rw` cannot slip past the read-only probe.
- The migration loader rejects an unaligned or unsafe `idOffset` and a local
  migration id outside its block, instead of failing later in a neighbouring
  package. Both diagnostics name the offending key, and two keys in one set that
  realize the same id are reported as the collision they are.

### Fixed

- `Migrations.run` decodes applied migration ids by value, so the idempotent
  re-run under `SqlClient.SafeIntegers` no longer dies converting a `bigint`,
  and an unreadable `migration_id` fails as a `BadState` `MigrationError`
  naming the value instead of a raw `TypeError`. `MigrationSet.migrations` is
  `Readonly`, and the loader snapshots the plan when it is built, so mutating
  the record after `run` returned its Effect cannot change which migrations
  execute.
- An I/O failure anywhere in a parallel `Cause` now vetoes the replay
  cause-wide, so a write that raced an I/O failure against a busy conflict is
  never replayed, in either arrival order. Retry classification no longer
  executes arbitrary error property getters, so a throwing `code`, `message`,
  or `cause` accessor keeps the typed failure on the typed channel instead of
  replacing it with a defect.
- The open guard skips the file probe for a SQLite `mode=memory` URI, which
  names a pure in-memory database, so a memory-mode name that collides with an
  on-disk 0.x file is no longer refused.
- README links to repository documentation are absolute, so they resolve on
  npm.
- The entry-point table in `docs/api.md` lists the root-module subpaths
  (`DurableWriter`, `DatabaseMetrics`, `Migrations`), so every module the
  export map publishes has a documented import path.

## [0.1.0] - 2026-08-05

### Added

- Added the thin Effect SQL service, Node SQLite layer, in-memory test layer, and bounded transient-write retry policy.
