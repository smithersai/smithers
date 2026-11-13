/// <reference types="bun" />
/** Bun SQLite driver using the same SQL, migration and write contracts as Node.
 * @since 1.0.0
 */

import { constants, Database } from "bun:sqlite"
import { type Duration, Effect, Layer } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import { statSync } from "node:fs"
import * as BunSqliteClient from "../internal/BunSqliteClient.ts"
import * as PostgresSelection from "../internal/PostgresSelection.ts"
import * as SqliteOpen from "../internal/SqliteOpen.ts"

export { isUnsupportedDatabase, UnsupportedDatabase, UnsupportedDatabaseCode } from "../internal/UnsupportedDatabase.ts"

/** Connection settings; migrations and DurableWriter are composed above the driver.
 * @since 1.0.0
 * @category models
 */
export interface BunDatabaseOptions {
  readonly filename: string
  /** Synchronous lock wait. Defaults to one second for read-only opens, zero otherwise; overrides sqlite.busyTimeout when supplied. */
  readonly busyTimeout?: Duration.Input | undefined
  readonly sqlite?: Omit<BunSqliteClient.SqliteClientConfig, "filename"> | undefined
  /** Opens an existing store for reading only, as `NodeDatabase` does. */
  readonly readOnly?: boolean | undefined
}

const readTableNames = (filename: string): ReadonlyArray<string> | undefined => {
  // Filesystem errors quote caller-chosen paths, so lock text in a path is
  // not evidence of SQLite contention. Only classify the driver's errors.
  if (!filename.startsWith("file:")) {
    try {
      if (!statSync(filename, { throwIfNoEntry: false })?.isFile()) return undefined
    } catch {
      return undefined
    }
  }
  let db: Database | undefined
  try {
    // Bun reads a `file:` name as a URI only when the open flags say so. With
    // an options object it looks for a file literally named `file:...`, finds
    // none, and the guard would wave the real 0.x database through.
    db = new Database(
      filename,
      filename.startsWith("file:")
        ? constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_READONLY
        : { readonly: true, create: false }
    )
    return (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  } catch (error) {
    if (SqliteOpen.isLockedError(error)) throw error
    return undefined
  } finally {
    db?.close()
  }
}

/**
 * Creates the file after the guard has inspected an existing database, with
 * the same owner-only default as NodeDatabase. Bun's driver would otherwise
 * create it, and its sidecars, under the process umask.
 */
const client = (options: BunDatabaseOptions): Layer.Layer<SqlClient.SqlClient> =>
  Layer.unwrap(Effect.sync(() => {
    const sqlite = options.sqlite
    SqliteOpen.createDatabaseFile(
      options.filename,
      sqlite?.readonly !== true && sqlite?.readwrite !== false && sqlite?.create !== false
    )
    return BunSqliteClient.layer({
      ...sqlite,
      busyTimeout: options.busyTimeout ?? sqlite?.busyTimeout ??
        (options.readOnly || sqlite?.readonly ? 1_000 : 0),
      filename: options.filename
    }).pipe(
      // As on Node, a failed open or PRAGMA is a typed `SqlError`, and
      // `SqliteOpen` reads the driver's raw throw off the defect channel.
      Layer.catch((error): Layer.Layer<SqlClient.SqlClient> => Layer.effectContext(Effect.die(error.reason.cause)))
    )
  }))

/** Provides a scoped Bun SQL client; no Node subprocess or secondary ledger.
 * @since 1.0.0
 * @category layers
 */
export const layer = (options: BunDatabaseOptions): Layer.Layer<SqlClient.SqlClient> =>
  Layer.unwrap(Effect.sync(() => {
    const readOnly = options.readOnly === true
    return PostgresSelection.layer(options.filename, readOnly) ?? SqliteOpen.layer(
      options.filename,
      readTableNames,
      client(readOnly ? { ...options, sqlite: { ...options.sqlite, readonly: true, disableWAL: true } } : options),
      readOnly
    )
  }))
