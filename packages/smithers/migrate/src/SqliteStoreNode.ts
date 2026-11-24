/**
 * The Node implementation of the SQLite seam, on `node:sqlite`.
 *
 * This is the one module in the package that loads a SQLite engine. It is
 * reached by subpath (`@smthrs/migrate/SqliteStoreNode`) and by the Node
 * compositions in `flow/Layers`, never from the package's root entry.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { DatabaseSync } from "node:sqlite"
import { type Service, SqliteError, SqliteStore } from "./SqliteStore.ts"

/** SQLite extended result codes retain BUSY (5) / LOCKED (6) in the low byte. */
const busy = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null || !("errcode" in cause)) return false
  const code = cause.errcode
  return typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6)
}

const failure = (cause: unknown): SqliteError => new SqliteError({ reason: busy(cause) ? "busy" : "failed", cause })

/**
 * `node:sqlite` throws on a locked or corrupt file rather than failing an
 * Effect, so every call is wrapped and the connection is closed on each path.
 *
 * @category services
 * @since 1.0.0
 */
export const service: Service = {
  read: (file, use) =>
    Effect.try({
      try: () => {
        const database = new DatabaseSync(file, { readOnly: true })
        try {
          return use((sql, ...parameters) => database.prepare(sql).all(...parameters))
        } finally {
          database.close()
        }
      },
      catch: failure
    }),
  lock: (file) =>
    Effect.try({
      try: () => {
        const connection = new DatabaseSync(file)
        try {
          // A reserved writer lock is exclusive across connections and
          // processes. The transaction stays open until the lease is released.
          connection.exec("BEGIN IMMEDIATE")
        } catch (cause) {
          connection.close()
          throw cause
        }
        // Closing rolls the transaction back and releases its locks. A second
        // close throws; a released lease has nothing left to release.
        return { release: Effect.try(() => connection.close()).pipe(Effect.ignore) }
      },
      catch: failure
    })
}

/**
 * Provides {@link SqliteStore} from `node:sqlite`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<never> = Layer.succeed(SqliteStore, service)
