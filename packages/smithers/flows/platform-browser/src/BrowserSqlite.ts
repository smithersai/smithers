/**
 * SQLite on the origin private file system (OPFS), through Effect SQL.
 *
 * The durable engine keeps its step record in SQLite. In a browser that file
 * lives in OPFS, opened through `@journeyapps/wa-sqlite`'s synchronous build
 * (its API is asynchronous; the build's VFS calls are not) and its
 * access-handle pool VFS. `createSyncAccessHandle` exists only in a
 * dedicated worker, so {@link layerSqlite} runs there and nowhere else: a tab,
 * a shared worker and a service worker cannot open it.
 *
 * The worker hands {@link layerSqlite} the build as a {@link Build}: lazy
 * imports of the build's JavaScript and its wasm. Nothing in this package
 * imports the build, so an app's tab bundle, which imports this package from
 * its root, neither loads nor emits the 1.1 MB wasm; only the worker that
 * opens a database does.
 *
 * The loaded module and its registered VFS are the {@link Sqlite} service, so
 * an app opens one build and one VFS and hands it to every store in the
 * worker; each store opens its own database file on it with {@link layer}.
 *
 * {@link make} turns any open wa-sqlite database into a `SqlClient`, the one
 * the engine stores are written against. A write's `.raw` result reports
 * `{ changes }`, which `@smthrs/database`'s `DurableWriter.affectedRows`
 * reads; `@effect/sql-sqlite-wasm` 4.0.5 returns rows there instead, so a
 * store's compare-and-set would read every write as a no-op. Integers outside
 * 32 bits bind as SQLite integers, never as doubles, so an epoch-millisecond
 * column keeps its integer type.
 *
 * @since 1.0.0
 */

import type { AccessHandlePoolVFS } from "#access-handle-pool-vfs"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Client from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import type { SqlError } from "effect/sql/SqlError"
import * as Statement from "effect/sql/Statement"
import * as Stream from "effect/Stream"
import * as Statements from "./internal/Statements.ts"

/**
 * An open wa-sqlite database: the API built from the module, and the
 * database handle `open_v2` returned.
 *
 * @category models
 * @since 1.0.0
 */
export type Database = Statements.Database

/**
 * A loaded synchronous wa-sqlite build with a VFS registered under `vfs`,
 * which every database {@link layer} opens uses. With `exclusive`, the VFS
 * has one owner and one connection per file, as {@link layerSqlite}'s
 * access-handle pool does, and {@link open} journals each database in a
 * write-ahead log under an exclusive lock; without it, SQLite's default
 * rollback journal, which connections sharing a file need.
 *
 * @category services
 * @since 1.0.0
 */
export class Sqlite extends Context.Service<Sqlite, {
  readonly sqlite3: SQLiteAPI
  readonly vfs: string
  readonly exclusive?: boolean
}>()("@smthrs/platform-browser/BrowserSqlite/Sqlite") {}

/**
 * The default export of `@journeyapps/wa-sqlite/dist/wa-sqlite.mjs`: builds
 * the emscripten module over the wasm bytes it is given.
 *
 * @category models
 * @since 1.0.0
 */
export type Factory = (options: { readonly wasmBinary: BufferSource }) => Promise<unknown>

/**
 * The synchronous wa-sqlite build, loaded only when {@link layerSqlite} opens
 * the pool. A worker passes lazy imports, so the build reaches only the
 * worker's own bundle:
 *
 * ```ts
 * import wasmUrl from "@journeyapps/wa-sqlite/dist/wa-sqlite.wasm?url"
 *
 * const build: BrowserSqlite.Build = {
 *   module: () => import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs"),
 *   wasm: () => fetch(wasmUrl).then((response) => response.arrayBuffer())
 * }
 * ```
 *
 * @category models
 * @since 1.0.0
 */
export interface Build {
  /** Imports the build's JavaScript, `@journeyapps/wa-sqlite/dist/wa-sqlite.mjs`. */
  readonly module: () => Promise<{ readonly default: Factory }>
  /**
   * Loads the bytes of `@journeyapps/wa-sqlite/dist/wa-sqlite.wasm`. The layer
   * never fetches; it calls this.
   */
  readonly wasm: () => Promise<BufferSource>
}

/**
 * The build and the OPFS directory {@link layerSqlite} opens.
 *
 * @category models
 * @since 1.0.0
 */
export interface SqliteOptions {
  readonly build: Build
  /**
   * The OPFS directory the pool keeps every database file in, such as
   * `"smithers/app"`. The VFS is registered under the same name.
   */
  readonly directory: string
}

/**
 * Builds a `SqlClient` over an open database. Statements run one at a time
 * through a one-permit semaphore, transactions begin with `BEGIN IMMEDIATE`,
 * and a failed COMMIT is rolled back before the connection is lent again.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (database: Database): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function*() {
    // A statement runs to its end once started: the connection is lent to
    // the next statement only after this one has stopped touching it.
    const run = (operation: string, sql: string, params: ReadonlyArray<unknown>, shape: "object" | "array") =>
      Effect.uninterruptible(Effect.tryPromise({
        try: () => Statements.runAll(database, sql, params, shape),
        catch: (cause) => Statements.failed(cause, "Failed to execute statement", operation)
      }))
    const rows = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.map(run("execute", sql, params, "object"), (result) => result.rows as Array<object>)
    const values = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.map(run("executeValues", sql, params, "array"), (result) => result.rows as Array<ReadonlyArray<unknown>>)
    const connection: Connection = {
      // The client is built without name transforms, so it never passes
      // `transformRows`.
      execute: rows,
      executeRaw: (sql, params) =>
        Effect.map(
          run("execute", sql, params, "object"),
          (result): unknown => result.columns > 0 ? result.rows : { changes: database.sqlite3.changes(database.db) }
        ),
      executeValues: values,
      executeValuesUnprepared: values,
      executeUnprepared: rows,
      executeStream: () => Stream.die("executeStream not implemented")
    }
    const { acquirer, borrower, onCommitFailure, transactionAcquirer } = Client.makeSqliteAcquirers({
      connection: Effect.succeed(connection),
      semaphore: yield* Semaphore.make(1)
    })
    return yield* Client.make({
      acquirer,
      borrower,
      compiler: Statement.makeCompilerSqlite(),
      transactionAcquirer,
      onCommitFailure,
      releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
      beginTransaction: "BEGIN IMMEDIATE",
      spanAttributes: [["db.system.name", "sqlite"]]
    })
  })

/** Whether a failure is OPFS refusing a file another context still holds. */
const isHeldElsewhere = (error: SqlError): boolean =>
  (error.reason.cause as { readonly name?: unknown } | undefined)?.name === "NoModificationAllowedError"

/**
 * A worker that takes over from one that just stopped can find its access
 * handles not yet released. The pool is opened again, from scratch, for
 * as long as the previous worker holds them, until this acquisition is cancelled.
 */
const heldSchedule = Schedule.exponential(Duration.millis(20)).pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.millis(Math.min(500, Duration.toMillis(duration)))))
)

/** The access-handle pool VFS's constructor. */
type Pool = typeof AccessHandlePoolVFS

/** Opens the pool directory, holding every access handle until the scope closes. */
const openPool = (directory: string, module: unknown, Vfs: Pool) =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      const vfs = new Vfs(directory, module)
      return Effect.tryPromise({
        try: () => vfs.isReady(),
        catch: (cause) => Statements.failed(cause, "Failed to open the OPFS directory", "connect")
      }).pipe(
        // A failed open keeps the handles it did take; give them back before
        // the next attempt asks for them again.
        Effect.tapError(() => Effect.promise(() => vfs.close())),
        Effect.as(vfs)
      )
    }),
    (vfs) => Effect.promise(() => vfs.close())
  ).pipe(Effect.retry({ schedule: heldSchedule, while: isHeldElsewhere }))

/** Imports wa-sqlite's API, the pool VFS and the build, and instantiates the build. */
const load = async (build: Build) => {
  const [api, pool, glue, wasm] = await Promise.all([
    import("@journeyapps/wa-sqlite"),
    import("#access-handle-pool-vfs"),
    build.module(),
    build.wasm()
  ])
  // Bytes that are not WebAssembly never reach emscripten, whose abort
  // would leave an unhandled rejection behind the one this reports.
  if (!WebAssembly.validate(wasm)) throw new WebAssembly.CompileError("the bytes are not a WebAssembly module")
  return { Factory: api.Factory, Vfs: pool.AccessHandlePoolVFS, module: await glue.default({ wasmBinary: wasm }) }
}

/**
 * Loads the build and opens the OPFS pool `directory`, holding its access
 * handles until the scope closes. Must run in a dedicated worker.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerSqlite = (options: SqliteOptions): Layer.Layer<Sqlite, SqlError> =>
  Layer.effect(
    Sqlite,
    Effect.gen(function*() {
      const { Factory, module, Vfs } = yield* Effect.tryPromise({
        try: () => load(options.build),
        catch: (cause) => Statements.failed(cause, "Failed to load wa-sqlite", "connect")
      })
      const sqlite3 = Factory(module)
      const vfs = yield* openPool(options.directory, module, Vfs)
      sqlite3.vfs_register(vfs as unknown as SQLiteVFS, false)
      // The pool's one worker holds every file, and opens each once: `engine.db` and the app's database.
      return { sqlite3, vfs: options.directory, exclusive: true }
    })
  )

/**
 * wa-sqlite's `open_v2` hands the new handle back through one pointer shared
 * by the whole build, so two opens at once can both read the second one's
 * handle. Opens on one build run one at a time.
 */
const openings = new WeakMap<SQLiteAPI, Semaphore.Semaphore>()
const opening = (sqlite3: SQLiteAPI): Semaphore.Semaphore => {
  let semaphore = openings.get(sqlite3)
  if (semaphore === undefined) {
    semaphore = Semaphore.makeUnsafe(1)
    openings.set(sqlite3, semaphore)
  }
  return semaphore
}

/**
 * How a database on an `exclusive` VFS keeps its writes: in a write-ahead log,
 * which commits a transaction by appending to the log and syncing it once,
 * where SQLite's default rollback journal creates, syncs and deletes a journal
 * file around every commit. On the access-handle pool that default cost a cold
 * app start about 4 ms a transaction. The pool has no shared memory and no
 * locks, so the connection keeps the WAL index itself and holds the file until
 * it closes (`EXCLUSIVE`): correct only while it is the file's one connection,
 * as the pool's one worker guarantees. `FULL` syncs the log at every commit, as
 * `@smthrs/database`'s Node and Bun hosts do. A build without this cannot open
 * a database left in write-ahead mode.
 */
const JOURNAL = "PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;"

/**
 * Opens `filename` on the {@link Sqlite} service's VFS and closes it with the
 * scope; on an `exclusive` VFS, journaled in a write-ahead log under an
 * exclusive lock. Opens on one build run one at a time.
 *
 * @category constructors
 * @since 1.0.0
 */
export const open = (filename: string): Effect.Effect<Database, SqlError, Sqlite | Scope.Scope> =>
  Effect.gen(function*() {
    const { exclusive, sqlite3, vfs } = yield* Sqlite
    const db = yield* Effect.acquireRelease(
      opening(sqlite3).withPermits(1)(Effect.tryPromise({
        try: () => sqlite3.open_v2(filename, undefined, vfs),
        catch: (cause) => Statements.failed(cause, "Failed to open database", "connect")
      })),
      (db) => Effect.promise(() => sqlite3.close(db))
    )
    if (exclusive === true) {
      yield* Effect.tryPromise({
        try: () => Statements.runAll({ sqlite3, db }, JOURNAL, [], "array"),
        catch: (cause) => Statements.failed(cause, "Failed to journal database", "connect")
      })
    }
    return { sqlite3, db }
  })

/**
 * Provides a `SqlClient` over `filename`, opened on the {@link Sqlite}
 * service's VFS, until the layer's scope closes.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: { readonly filename: string }): Layer.Layer<Client.SqlClient, SqlError, Sqlite> =>
  Layer.effect(Client.SqlClient, Effect.flatMap(open(options.filename), make)).pipe(Layer.provide(Reactivity.layer))
