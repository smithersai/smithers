/**
 * The SQLite seam: the two things a migration asks of a SQLite file, as an
 * Effect service a host provides.
 *
 * The scanners read a Smithers 0.x database to decide whether a project has
 * work in flight, and an apply takes a SQLite writer lock so one process owns
 * the project. Both need a SQLite engine, which a browser and a Worker do not
 * have. This module names the capability and holds no engine, so importing
 * `@smthrs/migrate` loads no host module. `@smthrs/migrate/SqliteStoreNode`
 * is the Node implementation.
 *
 * {@link SqliteStore} has a default, so no scanner gains a requirement. The
 * default fails every call with `reason: "unavailable"`, and both callers fail
 * closed on it: a database that cannot be read blocks the migration, and an
 * apply that cannot take the lock does not start.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"

/**
 * One result row, by column name.
 *
 * @category models
 * @since 1.0.0
 */
export type Row = Readonly<Record<string, unknown>>

/**
 * Runs one statement against an open read-only database and returns every
 * row. Valid only inside the `use` callback of {@link Service.read}.
 *
 * @category models
 * @since 1.0.0
 */
export type Query = (sql: string, ...parameters: ReadonlyArray<string | number>) => ReadonlyArray<Row>

/**
 * A SQLite failure.
 *
 * `busy` means another connection holds the lock the call needed. `failed` is
 * every other engine error: a missing, locked, or corrupt file. `unavailable`
 * means the host provided no SQLite engine. `cause` is the engine's own error.
 *
 * @category errors
 * @since 1.0.0
 */
export class SqliteError extends Data.TaggedError("SqliteError")<{
  readonly reason: "busy" | "failed" | "unavailable"
  readonly cause: unknown
}> {}

/**
 * A held writer lock. `release` rolls the transaction back and closes the
 * connection; releasing twice is a no-op.
 *
 * @category models
 * @since 1.0.0
 */
export interface Lease {
  readonly release: Effect.Effect<void>
}

/**
 * What a host's SQLite engine does for a migration.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  /**
   * Opens `file` read only, hands `use` a {@link Query}, and closes the
   * database when `use` returns or throws. Never creates or writes the file.
   */
  readonly read: <A>(file: string, use: (query: Query) => A) => Effect.Effect<A, SqliteError>
  /**
   * Takes the reserved writer lock on `file` without waiting, creating the
   * file if it is missing. Fails with `busy` when another connection, in this
   * process or another, already holds it.
   */
  readonly lock: (file: string) => Effect.Effect<Lease, SqliteError>
}

const unavailable = Effect.fail(
  new SqliteError({
    reason: "unavailable",
    cause: "this host provides no SQLite engine; on Node, provide `layer` from @smthrs/migrate/SqliteStoreNode"
  })
)

/**
 * The host's SQLite engine. Without a provided layer every call fails with
 * `reason: "unavailable"`.
 *
 * @category services
 * @since 1.0.0
 */
export const SqliteStore = Context.Reference<Service>("@smthrs/migrate/SqliteStore", {
  defaultValue: () => ({ read: () => unavailable, lock: () => unavailable })
})
