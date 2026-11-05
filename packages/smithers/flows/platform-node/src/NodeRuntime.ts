/** Node host composition over the shared, injected durable runtime.
 *
 * `layerHost` is how a Node program runs flows: it opens the SQLite file or
 * PostgreSQL URL it is given, guards flow bodies behind the capability kernel
 * on this host, and shuts down on `SIGINT` and `SIGTERM`. The engine itself is
 * `@smthrs/flows` `Runtime.layer`, and invalid options throw its
 * `Runtime.RuntimeConfigurationError`.
 *
 * @since 1.0.0
 */

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as Database from "@smthrs/database/node/NodeDatabase"
import * as Runtime from "@smthrs/flows/Runtime"
import { Context, Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { basename, dirname, join } from "node:path"
import * as NativeRuntime from "./NativeRuntime.ts"
import * as Host from "./NodeHost.ts"

export type { HostOptions, Options } from "./NativeRuntime.ts"

/**
 * Builds a fresh SQLite store privately, closes its driver (checkpointing the
 * WAL), then publishes the complete file with an exclusive hard link. A
 * concurrent creator never replaces the winner's inode. Interrupted private
 * directories are inert; subsequent creators use a new private directory.
 *
 * The initializer includes store-owned DDL after migrations, such as journal
 * generations. PostgreSQL and special SQLite names stay on their native
 * adapter; their complete initialization runs in one writer transaction.
 * Existing stores retain their identity and use the normal migration ladder.
 *
 * @since 1.0.0
 * @category layers
 */
export const publishFreshDatabase = <A, E>(
  filename: string,
  database: (filename: string) => Layer.Layer<SqlClient>,
  initialize: Layer.Layer<A, E, SqlClient>
): Layer.Layer<SqlClient> => {
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
          yield* Effect.scoped(Effect.gen(function*() {
            const file = yield* fs.open(staged, { flag: "r" })
            yield* file.sync
          }))
          yield* fs.link(staged, filename).pipe(Effect.catch((error) =>
            error.reason._tag === "AlreadyExists"
              ? Effect.gen(function*() {
                // A dangling symlink is not a competing, complete store. Never
                // fall through to an adapter that would create its target in place.
                if (!(yield* fs.exists(filename))) return yield* Effect.fail(error)
              })
              : Effect.fail(error)
          ))
          if (process.platform !== "win32") {
            yield* Effect.scoped(Effect.gen(function*() {
              const directory = yield* fs.open(dirname(filename), { flag: "r" })
              yield* directory.sync
            }))
          }
        }))
        return open(filename)
      }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie)
    )
  )
}

const runtime = NativeRuntime.make({
  name: "NodeRuntime",
  database: (filename) => publishFreshDatabase(filename, (file) => Database.layer({ filename: file }), Runtime.storage),
  host: Host,
  crypto: Host.NodeCrypto.layer
})

/** Provides the migrated stores over the native SQL driver.
 * @since 1.0.0
 * @category layers
 */
export const storage: NativeRuntime.Api["storage"] = runtime.storage
/** Builds the shared durable runtime in the caller’s Effect scope.
 * @since 1.0.0
 * @category layers
 */
export const make: NativeRuntime.Api["make"] = runtime.make
/** Provides the shared runtime with an explicitly supplied execution boundary.
 * @since 1.0.0
 * @category layers
 */
export const layer: NativeRuntime.Api["layer"] = runtime.layer
/** Provides the native host, guarded services, database and registered flows.
 * @since 1.0.0
 * @category layers
 */
export const layerHost: NativeRuntime.Api["layerHost"] = runtime.layerHost
/** Returns the conventional exit code for a native shutdown signal.
 * @since 1.0.0
 * @category layers
 */
export const signalExitCode: NativeRuntime.Api["signalExitCode"] = runtime.signalExitCode
/** Default graceful-shutdown deadline in milliseconds.
 * @since 1.0.0
 * @category layers
 */
export const defaultShutdownTimeoutMs: NativeRuntime.Api["defaultShutdownTimeoutMs"] = runtime.defaultShutdownTimeoutMs
/** Largest supported native shutdown timer delay.
 * @since 1.0.0
 * @category layers
 */
export const maximumShutdownTimeoutMs: NativeRuntime.Api["maximumShutdownTimeoutMs"] = runtime.maximumShutdownTimeoutMs
