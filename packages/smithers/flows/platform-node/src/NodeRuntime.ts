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

import { Crypto } from "@smthrs/crypto"
import * as Database from "@smthrs/database/node/NodeDatabase"
import * as NativeRuntime from "./NativeRuntime.ts"
import * as Host from "./NodeHost.ts"

export type { HostOptions, Options } from "./NativeRuntime.ts"

const runtime = NativeRuntime.make({
  name: "NodeRuntime",
  database: (filename) => Database.layer({ filename }),
  host: Host,
  crypto: Crypto.layerFromDigest(Host.NodeCrypto.layerDigest)
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
