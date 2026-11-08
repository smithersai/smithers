/**
 * Scoped durability for the initialized SQLite file before publication.
 * @since 1.0.0
 */

import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as Database from "@smthrs/database/node/NodeDatabase"
import { Context, Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { basename, dirname, join } from "node:path"

/**
 * Flush the closed SQLite initializer before publishing its inode.
 * Windows requires write access to flush; r+ retains the staged bytes.
 * @private
 * @since 1.0.0
 */
export const syncStagedDatabase = (filename: string) =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = yield* fs.open(filename, { flag: "r+" })
    yield* file.sync
  }))

/** The public Node boundary supplies its native filesystem and actual platform.
 * @private
 * @since 1.0.0
 */
export const publishFreshDatabaseLayer = <A, E>(
  filename: string,
  database: (filename: string) => Layer.Layer<SqlClient>,
  initialize: Layer.Layer<A, E, SqlClient>,
  platform: NodeJS.Platform
): Layer.Layer<SqlClient, never, FileSystem.FileSystem> => {
  const open = (file: string) =>
    database(file).pipe(
      Layer.tap((context) => {
        const sql = Context.get(context, SqlClient)
        // A fresh scope/memo map on every writer attempt also closes any stores
        // that registered finalizers before a failed initialization.
        return DurableWriter.make(sql).write(
          Effect.scoped(Layer.build(initialize)).pipe(Effect.provideContext(context))
        )
      }),
      Layer.orDie
    )
  return Layer.suspend(() =>
    Layer.unwrap(
      Effect.gen(function*() {
        if (
          Database.postgresLocation(filename) !== undefined || filename === "" ||
          filename === ":memory:" || filename.startsWith("file:")
        ) return open(filename)
        const fs = yield* FileSystem.FileSystem
        if (yield* fs.exists(filename)) return open(filename)
        yield* fs.makeDirectory(dirname(filename), { recursive: true, mode: 0o700 })
        yield* Effect.scoped(Effect.gen(function*() {
          const directory = yield* fs.makeTempDirectoryScoped({
            directory: dirname(filename),
            prefix: `.${basename(filename)}.initializing-`
          })
          const staged = join(directory, "store.db")
          // No SQL handle or WAL sidecar may survive publication under a new name.
          yield* Effect.scoped(Layer.build(open(staged)))
          yield* syncStagedDatabase(staged)
          yield* fs.link(staged, filename).pipe(Effect.catch((error) =>
            error.reason._tag === "AlreadyExists"
              ? Effect.gen(function*() {
                // A dangling symlink is not a competing, complete store. Never
                // fall through to an adapter that would create its target in place.
                if (!(yield* fs.exists(filename))) return yield* Effect.fail(error)
              })
              : Effect.fail(error)
          ))
          if (platform !== "win32") {
            yield* Effect.scoped(Effect.gen(function*() {
              const directory = yield* fs.open(dirname(filename), { flag: "r" })
              yield* directory.sync
            }))
          }
        }))
        return open(filename)
      }).pipe(Effect.orDie)
    )
  )
}
