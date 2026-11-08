/** Private control persistence over the selected native SQL adapter.
 * @since 1.0.0
 */

import * as DurableWriter from "@smthrs/database/DurableWriter"
import { NodeRuntime } from "@smthrs/platform-node"
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as CliError from "../CliError.ts"
import * as Migrations from "./ControlDatabaseMigrations.ts"

/** Uses injected filesystem and path services, and opens only the supplied SQL adapter.
 * @since 1.0.0
 * @private
 */
export const make = (database: (filename: string) => Layer.Layer<SqlClient>) => (file: string) => {
  // Memoize the entire asynchronous adapter construction. Layer.unwrap only
  // memoizes its factory effect; its generated dependency graph can otherwise
  // acquire a distinct client for the journal, writer and runtime.
  const sql = Layer.suspend(() =>
    Layer.unwrap(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = path.dirname(file)
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
      return NodeRuntime.publishFreshDatabase(file, database, Migrations.layer)
    }))
  )
  return Layer.provideMerge(Migrations.layer, Layer.provideMerge(DurableWriter.layer(), sql)).pipe(
    Layer.tap(() =>
      Effect.gen(function*() {
        if (process.platform === "win32") return
        const fs = yield* FileSystem.FileSystem
        for (const filename of [file, `${file}-wal`, `${file}-shm`]) {
          if (yield* fs.exists(filename)) yield* fs.chmod(filename, 0o600)
        }
      })
    )
  )
}

/** Opens an existing store with the supplied read-only SQL adapter: no directory,
 * migration or permission change.
 * @since 1.0.0
 * @private
 */
export const observe = (database: (filename: string) => Layer.Layer<SqlClient>) => (file: string) =>
  Layer.provideMerge(DurableWriter.layer(), database(file)).pipe(Layer.tap((context) =>
    Effect.gen(function*() {
      const sql = Context.get(context, SqlClient)
      const tables = yield* sql.onDialectOrElse({
        pg: () => sql<{ readonly found: boolean }>`SELECT to_regclass('flows_migrations') IS NOT NULL AS found`,
        orElse: () =>
          sql<
            { readonly found: number }
          >`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'flows_migrations'`
      })
      if (!tables[0]?.found) return yield* Effect.die(StoreInitializing.new())
      const applied = yield* sql`SELECT migration_id FROM flows_migrations LIMIT 1`
      if (applied.length === 0) return yield* Effect.die(StoreInitializing.new())
    }).pipe(Effect.orDie)
  ))

/** An interrupted or in-progress creation, not a store written by an older binary.
 * Observing orchestration may answer empty until a creator publishes its schema.
 * @since 1.0.0
 * @private
 */
export class StoreInitializing extends CliError.Refused {
  static new(): StoreInitializing {
    return new StoreInitializing({
      fault: "infra",
      code: "store_initializing",
      message: "The store is still being initialized"
    })
  }
}
