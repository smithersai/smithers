/// <reference types="bun" />

// The platform code of BunSqliteClient.vibe, which a .vibe file does not import as a value (EK4402).

import type { SqliteClientConfig } from "@effect/sql-sqlite-bun/SqliteClient"
import { constants, Database } from "bun:sqlite"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Client from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/sql/SqlError"
import * as Statement from "effect/sql/Statement"
import * as Stream from "effect/Stream"

const MAX_BUSY_TIMEOUT = 2_147_483_647
const NANOS_PER_MILLI = BigInt(1_000_000)
const failed = (cause: unknown, message: string, operation: string): SqlError =>
  new SqlError({ reason: classifySqliteError(cause, { message, operation }) })
/** The connection, and whether SQLite still holds a transaction open on it. */
interface BunConnection extends Connection {
  readonly isTransaction: () => boolean
}
export const make = (
  options: SqliteClientConfig
): Effect.Effect<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function*() {
    const readonly = options.readonly === true
    const readwrite = readonly ? false : options.readwrite ?? true
    const create = readonly ? false : options.create ?? true
    const db = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          new Database(
            options.filename,
            // Bun reads a `file:` name as a URI only when the open flags say so.
            options.filename.startsWith("file:")
              ? constants.SQLITE_OPEN_URI |
                (readonly ? constants.SQLITE_OPEN_READONLY : 0) |
                (readwrite || create ? constants.SQLITE_OPEN_READWRITE : 0) |
                (create ? constants.SQLITE_OPEN_CREATE : 0)
              : { readonly, readwrite, create }
          ),
        catch: (cause) => failed(cause, "Failed to open database", "connect")
      }),
      (db) => Effect.sync(() => db.close())
    )
    const busyTimeout = Math.min(
      MAX_BUSY_TIMEOUT,
      Math.max(0, Math.round(Duration.toMillis(options.busyTimeout ?? Duration.seconds(5))))
    )
    const configure = (sql: string) =>
      Effect.try({
        try: () => db.run(sql),
        catch: (cause) => failed(cause, "Failed to configure database", "connect")
      })
    yield* configure(`PRAGMA busy_timeout = ${busyTimeout};`)
    if (options.disableWAL !== true && !readonly) {
      // Switching to WAL can fail with SQLITE_BUSY without invoking the busy
      // handler, so retry it until busyTimeout has elapsed. Each attempt's
      // native busy wait is limited to the remaining time.
      const deadline = (yield* Clock.monotonicTimeNanos) + BigInt(busyTimeout) * NANOS_PER_MILLI
      const remainingMillis = Effect.map(
        Clock.monotonicTimeNanos,
        (now) => Math.max(0, Number((deadline - now) / NANOS_PER_MILLI))
      )
      yield* remainingMillis.pipe(
        Effect.flatMap((remaining) => configure(`PRAGMA busy_timeout = ${remaining};`)),
        Effect.andThen(configure("PRAGMA journal_mode = WAL;")),
        Effect.retry({
          while: (error) =>
            error.reason._tag === "LockTimeoutError" && Effect.map(remainingMillis, (remaining) => remaining > 0),
          schedule: Schedule.spaced("10 millis")
        })
      )
      yield* configure(`PRAGMA busy_timeout = ${busyTimeout};`)
    }

    const execute = <A>(
      operation: string,
      sql: string,
      params: ReadonlyArray<unknown>,
      run: (statement: ReturnType<Database["query"]>, params: Array<any>) => A
    ) =>
      Effect.withFiber<A, SqlError>((fiber) => {
        try {
          const statement = db.query(sql)
          statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
          return Effect.succeed(run(statement, params as Array<any>))
        } catch (cause) {
          return Effect.fail(failed(cause, "Failed to execute statement", operation))
        }
      })

    const rows = (sql: string, params: ReadonlyArray<unknown> = []) =>
      execute("execute", sql, params, (statement, values) => statement.all(...values) as Array<any>)
    const values = (sql: string, params: ReadonlyArray<unknown> = []) =>
      execute("executeValues", sql, params, (statement, values) => (statement.values(...values) ?? []) as Array<any>)
    const raw = (sql: string, params: ReadonlyArray<unknown> = []) =>
      execute("execute", sql, params, (statement, values): unknown => {
        if (statement.columnNames.length > 0) return statement.all(...values)
        const result = statement.run(...values)
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
      })

    const connection: BunConnection = {
      isTransaction: () => db.inTransaction,
      execute: (sql, params, transformRows) =>
        transformRows ? Effect.map(rows(sql, params), transformRows) : rows(sql, params),
      executeRaw: raw,
      executeValues: values,
      executeValuesUnprepared: values,
      executeUnprepared: (sql, params, transformRows) => connection.execute(sql, params, transformRows),
      executeStream: () => Stream.die("executeStream not implemented")
    }

    const { acquirer, onCommitFailure, transactionAcquirer } = Client.makeSqliteAcquirers({
      connection: Effect.succeed(connection),
      semaphore: yield* Semaphore.make(1),
      isTransaction: (conn) => conn.isTransaction()
    })
    return yield* Client.make({
      driver: "sqlite-bun",
      acquirer,
      compiler: Statement.makeCompilerSqlite(options.transformQueryNames),
      transactionAcquirer,
      onCommitFailure,
      releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
      beginTransaction: readonly ? "BEGIN" : "BEGIN IMMEDIATE",
      spanAttributes: [
        ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
        ["db.system.name", "sqlite"]
      ],
      transformRows: options.transformResultNames
        ? Statement.defaultTransforms(options.transformResultNames).array
        : undefined
    })
  })
