/** Bun host composition over the shared, injected durable runtime.
 *
 * The same lifecycle as `@smthrs/platform-node` `NodeRuntime`, bound to Bun's
 * SQLite driver and host bundle. Invalid options raise
 * `Runtime.RuntimeConfigurationError` from `@smthrs/flows`.
 *
 * @since 1.0.0
 */

import { NativeRuntime } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Host from "./BunHost.ts"

/** Native process and host configuration for `layerHost`.
 * @since 1.0.0
 * @category models
 */
export type HostOptions = NativeRuntime.HostOptions
/** The injected runtime's options plus the database file and workspace root.
 * @since 1.0.0
 * @category models
 */
export type Options = NativeRuntime.Options

const runtime = NativeRuntime.make({
  name: "BunRuntime",
  // Loaded when a database opens: its driver imports `bun:sqlite`, which only
  // Bun resolves, and this package's root must still load wherever its other
  // modules are read.
  database: (filename) =>
    Layer.unwrap(
      Effect.map(
        Effect.promise(() => import("@smthrs/database/bun/BunDatabase")),
        (Database) => Database.layer({ filename })
      )
    ),
  host: Host,
  crypto: Host.BunCrypto.layer
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
