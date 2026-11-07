/** PostgreSQL adapter for the same injected SQL and durable-write services.
 *
 * It is correct behind a transaction-pooling proxy such as Cloudflare
 * Hyperdrive or PgBouncer with `pool_mode=transaction`. Such a proxy runs each
 * transaction on whichever server connection is free, so a session setting is
 * lost for the client that made it, and a proxy that does not reset its
 * connections hands it to the next client. This adapter therefore changes no
 * session state: every statement runs inside a transaction that sets the
 * schema for itself alone.
 *
 * A named prepared statement is session state too, so every statement goes
 * out unnamed. `@effect/sql-pg` otherwise keeps up to 100 statements prepared
 * by name per connection and, past that, closes the oldest with a protocol
 * `Close` message. Cloudflare Hyperdrive drops the connection on that
 * message, so the 101st distinct statement on one connection failed with
 * `Connection closed`: the flow engine's schema, about 110 statements in one
 * transaction, never installed behind Hyperdrive (2026-10-21).
 *
 * A write waits for its schema's writer lock inside its transaction, so the
 * wait holds one of the proxy's server connections. Behind Hyperdrive, whose
 * configuration grants a fixed number of them, a queue of writers as long as
 * that number held every one, and Hyperdrive closed each other client after
 * waiting 15 seconds for a connection: alarms failed with `Connection closed`
 * under load (2026-10-22). A wait therefore lasts at most `writerLockTimeout`;
 * then the write rolls back, letting its server connection go, and tries
 * again after a jittered backoff.
 *
 * The socket driver is injected. `@effect/sql-pg` connects through `node:net`
 * and `node:tls`, which Node, Bun and Workers with `nodejs_compat` supply and
 * a browser does not, so the composition root passes the driver in and this
 * module imports only its types.
 * @since 1.0.0
 */

import type * as Pg from "@effect/sql-pg"
import { Cause, Clock, Duration, Effect, Exit, Fiber, Layer, Metric, Random, Redacted, Result, Stream } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as SqlClient from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import { isSqlError, SqlError, UnknownError } from "effect/sql/SqlError"
import type { Compiler } from "effect/sql/Statement"
import * as DatabaseMetrics from "../DatabaseMetrics.ts"
import * as ReadOnly from "../internal/ReadOnly.ts"
import * as ReadTransaction from "../internal/ReadTransaction.ts"
import { UnsupportedDatabase } from "../internal/UnsupportedDatabase.ts"
import * as WriteLock from "../internal/WriteLock.ts"
import * as WriteTally from "../internal/WriteTally.ts"
import { qualify } from "./QualifiedRead.ts"

export { isUnsupportedDatabase, UnsupportedDatabase, UnsupportedDatabaseCode } from "../internal/UnsupportedDatabase.ts"

/**
 * The `@effect/sql-pg` modules this adapter drives. Pass the package itself:
 * `import * as Pg from "@effect/sql-pg"`, then `driver: Pg`.
 *
 * @category models
 * @since 1.0.0
 */
export type Driver = Pick<typeof Pg, "PgClient" | "PgTypes">

/**
 * PostgreSQL connection and schema configuration.
 *
 * @category models
 * @since 1.0.0
 */
export interface PostgresDatabaseOptions {
  readonly url: string
  /** The `@effect/sql-pg` driver; see {@link Driver}. */
  readonly driver: Driver
  readonly schema?: string | undefined
  /**
   * Pool settings. Statements always go out unnamed (see the module
   * description), so the prepared-statement settings are not among them.
   */
  readonly postgres?:
    | Omit<Pg.PgClient.PgPoolConfig, "url" | "types" | "prepare" | "preparedStatementCacheSize">
    | undefined
  /**
   * Reads an existing schema only: no schema creation, no writer lock, and
   * every transaction is `READ ONLY`.
   */
  readonly readOnly?: boolean | undefined
  /**
   * How long one wait for the schema's writer lock may hold a server
   * connection; 2 seconds by default. A write that waits longer rolls back,
   * letting the connection go, and tries again after a jittered backoff that
   * grows from half this timeout to four times it, so a long queue of writers
   * never holds every connection a pooler grants. The limit stays set for the
   * rest of the write: any lock it waits on longer fails with
   * `lock_not_available`, which `DurableWriter` retries. A zero duration
   * tries the lock once per attempt; an infinite one waits without limit,
   * holding the connection throughout.
   */
  readonly writerLockTimeout?: Duration.Input | undefined
  /**
   * How long a statement or transaction waits for a connection from the pool
   * before a `postgres.connection.waiting` warning says so; 10 seconds by
   * default. The wait goes on: it keeps the caller's interruptibility, so a
   * finalizer's write still commits after its caller is interrupted.
   * `DatabaseMetrics.connectionWait` times every wait.
   */
  readonly acquireWarning?: Duration.Input | undefined
}

/**
 * The longest one wait for the writer lock holds a server connection unless
 * `writerLockTimeout` says otherwise: 2 seconds, well under the 15 seconds
 * Cloudflare Hyperdrive lets a client wait for a connection.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultWriterLockTimeout: Duration.Duration = Duration.seconds(2)

/**
 * How long a wait for a pooled connection runs before it logs a warning,
 * unless `acquireWarning` says otherwise: 10 seconds.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultAcquireWarning: Duration.Duration = Duration.seconds(10)

// Why `SET LOCAL` and not schema-qualified SQL: every store and migration over
// this client writes unqualified table names, and `Dialect.tables`,
// `Dialect.columns` and the test fixtures read `current_schema()`. Qualifying
// them would touch every store, and one missed name would silently read or
// write another schema. Setting the schema once per transaction keeps that
// guarantee in this file. `set_config(..., true)` is `SET LOCAL` in function
// form, so the schema reaches the server as a bound parameter, never as SQL text.
const scopeStatement = "SELECT set_config('search_path', quote_ident($1), true)"
// The writer lock is keyed by the schema's name. Earlier releases hashed
// `current_schema()`, which is that name while the schema exists, so processes
// on either release serialize against each other. `lock_timeout` is set before
// the lock in the same statement, so it bounds that wait, and stays set for
// the rest of the transaction.
const lockStatement = "SELECT set_config('search_path', quote_ident($1), true), " +
  "set_config('lock_timeout', $2, true), pg_advisory_xact_lock(hashtextextended($1, 2099))"

/** Whether `cause` is the server refusing a lock wait past `lock_timeout` (SQLSTATE `55P03`). */
const isLockTimeout = (cause: Cause.Cause<SqlError>): boolean => {
  const error = Cause.squash(cause)
  return isSqlError(error) && error.reason._tag === "LockTimeoutError"
}
// A write to one partition holds the schema's lock shared and its partition's
// exclusively (docs/decisions/0001-run-writer-locks.md). The partition lock is
// the two-key form, whose key space never meets the schema lock's one-key form.
// The target list runs left to right, so the schema lock always comes first.
const partitionStatement = "SELECT set_config('search_path', quote_ident($1), true), " +
  "set_config('lock_timeout', $3, true), pg_advisory_xact_lock_shared(hashtextextended($1, 2099)), pg_advisory_xact_lock(hashtext($1), hashtext($2))"
// What a savepoint adds to a partitioned transaction: the whole schema, or
// one more partition.
const widenStatement = "SELECT pg_advisory_xact_lock(hashtextextended($1, 2099))"
const joinStatement = "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))"

/**
 * One connection's savepoints: whether anything ran since the last real
 * savepoint, that savepoint, and what each id rolls back to (undefined: it
 * opened none).
 */
interface Frame {
  clean: boolean
  real: string | undefined
  /** How many real savepoints this transaction has opened. Each name is its own: a reused name would shadow one in use. */
  opened: number
  /** How many statements have started on this connection, so a savepoint can tell if one started while it was on the wire. */
  started: number
  readonly targets: Map<number, string | undefined>
}

/**
 * The writer locks one open write transaction holds: the whole schema, or its
 * partitions. Each records the savepoint depth it was taken at, because
 * rolling back to a savepoint releases the locks taken inside it.
 */
interface Held {
  schema: number | undefined
  readonly partitions: Map<string, number>
  /** Whether the transaction has held the schema's lock at all, so a tally counts it schema-wide once. */
  wide: boolean
}

/** Provides PostgreSQL with serialized transactions and exact safe-number reads.
 * A dedicated schema keeps flow state separate from backend product tables.
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: PostgresDatabaseOptions): Layer.Layer<SqlClient.SqlClient> => {
  const schema = options.schema ?? "smithers_flows"
  if (schema.length === 0 || schema.includes("\0") || new TextEncoder().encode(schema).length > 63) {
    throw new UnsupportedDatabase({
      code: "postgres_schema_invalid",
      message: "PostgreSQL schema must contain 1 to 63 UTF-8 bytes and no NUL"
    })
  }
  const { PgClient, PgTypes } = options.driver
  const readOnly = options.readOnly === true
  const types = PgTypes.makeRegistry()
  for (const oid of [PgTypes.OID.int8, PgTypes.OID.numeric]) {
    types.register(oid, {
      encode: (value: unknown) =>
        PgTypes.encode(oid === PgTypes.OID.numeric ? String(value) : BigInt(value as number), oid),
      decode: (bytes) =>
        Result.flatMap(PgTypes.decode(bytes, oid, 1), (value) => {
          const number = Number(value)
          return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER
            ? Result.succeed(number)
            : Result.fail(new PgTypes.CodecError({ message: "Stored SQL number exceeds the safe numeric range" }))
        })
    })
  }
  // A reader takes one snapshot and no writer lock. A lone statement on the
  // writable client runs read-write: its text does not say whether it writes.
  // READ WRITE is explicit because a pooler that never resets its connections
  // can hand over another client's `default_transaction_read_only`.
  const readBegin = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
  const begin = readOnly ? readBegin : "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE"
  const held = new WeakMap<Connection, Held>()
  const settled = (conn: Connection) =>
    Effect.sync(() => {
      held.delete(conn)
    })
  const rollback = (conn: Connection) =>
    conn.executeUnprepared("ROLLBACK", [], undefined).pipe(Effect.ensuring(settled(conn)))
  const open = (conn: Connection, scope: Effect.Effect<unknown, SqlError>, statement = begin) =>
    conn.executeUnprepared(statement, [], undefined).pipe(
      Effect.andThen(scope),
      Effect.onError(() => Effect.orDie(rollback(conn)))
    )
  const scoped = (conn: Connection) => open(conn, conn.execute(scopeStatement, [schema], undefined))
  // `Dialect.readTransaction` on either client: one snapshot, no writer lock.
  const snapshot = (conn: Connection) => open(conn, conn.execute(scopeStatement, [schema], undefined), readBegin)
  // `lock_timeout` in milliseconds; `0` is PostgreSQL's "no limit".
  const lockTimeout = Duration.fromInputUnsafe(options.writerLockTimeout ?? defaultWriterLockTimeout)
  const lockTimeoutMs = Duration.isFinite(lockTimeout) ? Math.max(1, Math.ceil(Duration.toMillis(lockTimeout))) : 0
  // After the n-th wait that ran out: from half the timeout, doubling, at most
  // four times it, each delay drawn between half and all of its bound.
  const backoff = (attempt: number) =>
    Effect.map(
      Random.nextBetween(0.5, 1),
      (jitter) => Duration.millis(Math.min(lockTimeoutMs * 4, lockTimeoutMs * 2 ** (attempt - 1) / 2) * jitter)
    )
  const requested = Effect.gen(function*() {
    return yield* WriteLock.Requested
  })
  // Times one lock statement into the metric and the open tallies.
  const lock = (statement: Effect.Effect<unknown, SqlError>, wait: WriteTally.Wait) =>
    Effect.flatMap(
      Effect.timed(statement),
      ([waited]) =>
        Effect.andThen(Metric.update(DatabaseMetrics.writerLockWait, waited), WriteTally.record(waited, wait))
    )
  // BEGIN takes the lock the opening write asks for: the whole schema, or its
  // partition beside every other partition's writers.
  const locked = (conn: Connection) =>
    Effect.gen(function*() {
      const partition = yield* requested
      const started = yield* Clock.currentTimeMillis
      for (let attempt = 1;; attempt++) {
        const exit = yield* Effect.exit(
          open(
            conn,
            partition === undefined
              ? conn.execute(lockStatement, [schema, String(lockTimeoutMs)], undefined)
              : conn.execute(partitionStatement, [schema, partition, String(lockTimeoutMs)], undefined)
          )
        )
        if (Exit.isSuccess(exit)) {
          const waited = Duration.millis((yield* Clock.currentTimeMillis) - started)
          yield* Metric.update(DatabaseMetrics.writerLockWait, waited)
          held.set(
            conn,
            partition === undefined
              ? { schema: 0, partitions: new Map(), wide: true }
              : { schema: undefined, partitions: new Map([[partition, 0]]), wide: false }
          )
          return yield* WriteTally.record(waited, partition === undefined ? "schema" : "partition")
        }
        if (!isLockTimeout(exit.cause)) return yield* exit
        // `open` rolled the transaction back, so the server connection is free
        // for other clients while this one waits.
        yield* Metric.update(DatabaseMetrics.writerLockTimeouts, 1)
        yield* Effect.interruptible(Effect.flatMap(backoff(attempt), Effect.sleep))
      }
    })
  // A nested write takes what its transaction lacks before its savepoint, so
  // the lock outlives a rollback of that savepoint: the whole schema when it
  // names no partition, or its own partition. A transaction that holds the
  // schema, or a read transaction, which holds nothing, takes nothing.
  // Consecutive savepoints with no statement between them mark one state, so
  // only the first costs a round trip: the rest roll back to it. A nested write
  // that only reads has nothing to undo and needs none (`WriteOptions.readOnly`).
  const frames = new WeakMap<Connection, Frame>()
  const frameOf = (conn: Connection): Frame => {
    const found = frames.get(conn)
    if (found !== undefined) return found
    const frame: Frame = { clean: false, real: undefined, opened: 0, started: 0, targets: new Map() }
    frames.set(conn, frame)
    return frame
  }
  // Marked when a statement runs, not when its effect is built: an effect can be built and run later.
  const tracked = (conn: Connection): Connection => {
    const dirty = Effect.sync(() => {
      const frame = frames.get(tracking)
      if (frame === undefined) return
      frame.clean = false
      frame.started++
    })
    const tracking: Connection = {
      execute: (sql, params, transformRows) => Effect.andThen(dirty, conn.execute(sql, params, transformRows)),
      executeRaw: (sql, params) => Effect.andThen(dirty, conn.executeRaw(sql, params)),
      executeValues: (sql, params) => Effect.andThen(dirty, conn.executeValues(sql, params)),
      executeValuesUnprepared: (sql, params) => Effect.andThen(dirty, conn.executeValuesUnprepared(sql, params)),
      executeUnprepared: (sql, params, transformRows) =>
        Effect.andThen(dirty, conn.executeUnprepared(sql, params, transformRows)),
      executeStream: (sql, params, transformRows) =>
        Stream.unwrap(Effect.as(dirty, conn.executeStream(sql, params, transformRows)))
    }
    return tracking
  }
  const savepoint = (conn: Connection, id: number) =>
    Effect.flatMap(requested, (partition) => {
      const state = held.get(conn)
      const widen = state !== undefined && state.schema === undefined && partition === undefined
      const join = state !== undefined && state.schema === undefined && partition !== undefined &&
        !state.partitions.has(partition)
      const take = widen
        ? lock(conn.execute(widenStatement, [schema], undefined), state.wide ? "more" : "widen").pipe(Effect.tap(() =>
          Effect.sync(() => {
            state.schema = id - 1
            state.wide = true
          })
        ))
        : join
        ? lock(conn.execute(joinStatement, [schema, partition], undefined), "more").pipe(Effect.tap(() =>
          Effect.sync(() => {
            state.partitions.set(partition, id - 1)
          })
        ))
        : Effect.void
      return Effect.flatMap(
        Effect.andThen(take, Effect.service(WriteLock.ReadOnlyBody)),
        (readOnlyBody) =>
          Effect.suspend((): Effect.Effect<unknown, SqlError> => {
            const frame = frameOf(conn)
            if (readOnlyBody) {
              frame.targets.set(id, undefined)
              return Effect.void
            }
            if (frame.clean && frame.real !== undefined) {
              frame.targets.set(id, frame.real)
              return Effect.void
            }
            const name = `effect_sql_${++frame.opened}`
            // Its own start counts once; any more means a statement started after it on this connection.
            const expected = frame.started + 1
            return conn.executeUnprepared(`SAVEPOINT ${name}`, [], undefined).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  frame.targets.set(id, name)
                  frame.real = name
                  frame.clean = frame.started === expected
                })
              )
            )
          })
      )
    })
  // Rolling back to savepoint `id` releases what was taken inside it.
  const rollbackSavepoint = (conn: Connection, id: number) => {
    const frame = frameOf(conn)
    // A read-only body opened none: nothing to undo, and the lock it took stays.
    const target = frame.targets.get(id)
    if (target === undefined) return Effect.void
    const expected = frame.started + 1
    return conn.executeUnprepared(`ROLLBACK TO SAVEPOINT ${target}`, [], undefined).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          frame.real = target
          frame.clean = frame.started === expected
          const state = held.get(conn)
          if (state === undefined) return
          if (state.schema !== undefined && state.schema >= id) state.schema = undefined
          for (const [partition, depth] of state.partitions) if (depth >= id) state.partitions.delete(partition)
        })
      )
    )
  }
  // PostgreSQL answers COMMIT in an aborted transaction with the tag ROLLBACK
  // and no error; that is a failed write, never a committed one.
  const commit = (conn: Connection) =>
    conn.executeRaw("COMMIT", []).pipe(
      Effect.flatMap((result) =>
        (result as Pg.PgConnection.Result).command === "ROLLBACK"
          ? Effect.fail(
            new SqlError({
              reason: new UnknownError({
                cause: new Error("COMMIT rolled back an aborted transaction"),
                message: "PostgresDatabase: COMMIT rolled back an aborted transaction",
                operation: "commit"
              })
            })
          )
          : Effect.void
      ),
      Effect.onError(() => Effect.orDie(rollback(conn))),
      Effect.ensuring(settled(conn))
    )
  // A statement outside `withTransaction` runs as the only statement of its own
  // transaction, which costs BEGIN, the schema and COMMIT around it.
  const alone = <A>(conn: Connection, run: Effect.Effect<A, SqlError>): Effect.Effect<A, SqlError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(
        restore(scoped(conn)),
        () =>
          Effect.flatMap(Effect.exit(restore(run)), (exit) =>
            Exit.isSuccess(exit)
              ? Effect.as(commit(conn), exit.value)
              : Effect.andThen(Effect.orDie(rollback(conn)), exit))
      )
    )
  // A plain read of the engine's own tables names their schema instead: one
  // round trip in place of four (`QualifiedRead`).
  const lone = <A>(
    conn: Connection,
    sql: string,
    run: (text: string) => Effect.Effect<A, SqlError>
  ): Effect.Effect<A, SqlError> => {
    const qualified = qualify(sql, schema)
    return qualified === undefined ? alone(conn, run(sql)) : run(qualified)
  }
  const statements = (conn: Connection): Connection => ({
    execute: (sql, params, transformRows) => lone(conn, sql, (text) => conn.execute(text, params, transformRows)),
    executeRaw: (sql, params) => lone(conn, sql, (text) => conn.executeRaw(text, params)),
    executeValues: (sql, params) => lone(conn, sql, (text) => conn.executeValues(text, params)),
    executeValuesUnprepared: (sql, params) => lone(conn, sql, (text) => conn.executeValuesUnprepared(text, params)),
    executeUnprepared: (sql, params, transformRows) =>
      lone(conn, sql, (text) => conn.executeUnprepared(text, params, transformRows)),
    // A stream commits after its last row; one abandoned early, failed or
    // interrupted rolls back when its scope closes.
    executeStream: (sql, params, transformRows) =>
      Stream.unwrap(Effect.suspend(() => {
        let settled = false
        const settle = Effect.sync(() => {
          settled = true
        })
        return Effect.acquireRelease(
          scoped(conn),
          () => settled ? Effect.void : Effect.orDie(rollback(conn))
        ).pipe(Effect.as(
          conn.executeStream(sql, params, transformRows).pipe(
            Stream.concat(Stream.fromEffectDrain(Effect.ensuring(commit(conn), settle)))
          )
        ))
      }))
  })
  const acquireWarning = Duration.fromInputUnsafe(options.acquireWarning ?? defaultAcquireWarning)
  // A wait that runs long says so while it waits, from a fiber of its own.
  const stillWaiting = Effect.andThen(
    Effect.sleep(acquireWarning),
    Effect.logWarning("postgres.connection.waiting").pipe(
      Effect.annotateLogs({ waitedMs: Duration.toMillis(acquireWarning) })
    )
  )
  return Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const pg = yield* PgClient.make({ ...options.postgres, url: Redacted.make(options.url), types, prepare: false })
      // Every connection this client uses comes from here, timed. The wait
      // stays in the caller's fiber with the caller's interruptibility. A
      // deadline would race it in another fiber, and a transaction acquires
      // inside an uninterruptible region: joining that fiber there kept an
      // interrupted caller waiting out the deadline, and making the join
      // interruptible dropped a finalizer's write (2026-10-22).
      const reserve = Effect.acquireUseRelease(
        Effect.forkDetach(stillWaiting),
        () => Effect.timed(pg.reserve),
        (warning) => Fiber.interrupt(warning)
      ).pipe(
        Effect.flatMap(([waited, conn]) => Effect.as(Metric.update(DatabaseMetrics.connectionWait, waited), conn)),
        // Taking a connection fails only when one would not open or log in:
        // counted, and logged by its kind. A connection failure's text is the
        // driver's, never a statement or a row; a refused login's stays out.
        Effect.tapError((error) =>
          Effect.andThen(
            Metric.update(DatabaseMetrics.loginFailures, 1),
            Effect.logWarning("postgres.login.failed").pipe(Effect.annotateLogs({
              "db.error": error.reason._tag,
              ...(error.reason._tag === "ConnectionError" ? { "db.error.message": error.reason.message } : {})
            }))
          )
        ),
        Effect.withSpan("PostgresDatabase.acquire", { kind: "internal" })
      )
      const baseCompiler = PgClient.makeCompiler()
      const compiler: Compiler = {
        dialect: "pg",
        withoutTransform: baseCompiler,
        compile: (statement, withoutTransform) => {
          const [query, parameters] = baseCompiler.compile(statement, withoutTransform)
          // The native driver infers unsafe integral numbers as float8, whose
          // numeric cast rounds to 15 digits and can evade a safe-integer CHECK.
          return [
            query,
            parameters.map((value) =>
              typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)
                ? PgTypes.numeric(String(value)) :
                value
            )
          ]
        }
      }
      Object.defineProperty(compiler, "withoutTransform", { value: compiler })
      const sql = yield* SqlClient.make({
        driver: "pg",
        acquirer: Effect.map(reserve, statements),
        compiler,
        spanAttributes: [["db.system.name", "postgresql"]]
      })
      const transactions = (start: (conn: Connection) => Effect.Effect<unknown, SqlError>) =>
        SqlClient.makeWithTransaction({
          transactionService: sql.transactionService,
          spanAttributes: [["db.system.name", "postgresql"]],
          acquireConnection: (restore) => Effect.map(restore(reserve), tracked),
          begin: start,
          savepoint,
          commit,
          rollback,
          rollbackSavepoint
        })
      // A transaction-scoped lock preserves SQLite's one-writer semantics across
      // processes, within each partition. READ COMMITTED takes each snapshot
      // after the lock is acquired.
      const withTransaction = transactions(readOnly ? scoped : locked)
      Object.assign(sql, { withTransaction })
      // Every statement of `sql.reserve` runs alone, so a caller cannot open a
      // read transaction on a reserved connection; this client opens its own.
      ReadTransaction.register(sql, transactions(snapshot))
      if (readOnly) ReadOnly.mark(sql)
      else {
        // A schema that exists costs no writer lock: every alarm of a Durable
        // Object builds this layer, and the schema's lock would hold up every
        // other execution's writes. A missing one is created under the lock,
        // so concurrent first opens create it once.
        const [found] = yield* sql<{ readonly found: boolean }>`
          SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${schema}) AS found
        `
        if (found?.found !== true) yield* sql.withTransaction(sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`)
      }
      return sql
    })
  ).pipe(Layer.provide(Reactivity.layer), Layer.orDie)
}
