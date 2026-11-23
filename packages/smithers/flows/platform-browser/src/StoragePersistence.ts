/**
 * Persistent storage for the origin, as an Effect service.
 *
 * A browser may clear an origin's storage under pressure, and Safari clears a
 * site's storage after seven days without a visit, OPFS and the engine's step
 * record included. Asking for persistent storage exempts the origin from
 * both. Only a window may ask (`StorageManager.persist` is not exposed in
 * workers), so the tab-side `BrowserEngine` asks when it starts.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * The slice of `StorageManager` this service uses.
 *
 * @category models
 * @since 1.0.0
 */
export interface StorageManagerLike {
  readonly persist?: (() => Promise<boolean>) | undefined
}

/**
 * Storage operations.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  /**
   * Asks for persistent storage and answers whether the origin has it. A
   * context without the API, or a browser that refuses to answer, has not.
   */
  readonly persist: Effect.Effect<boolean>
}

/**
 * Service tag for persistent storage.
 *
 * @category services
 * @since 1.0.0
 */
export class StoragePersistence extends Context.Service<StoragePersistence, Service>()(
  "@smthrs/platform-browser/StoragePersistence"
) {}

/**
 * The name of what `persist()` rejected with. A browser rejects with a
 * `DOMException`, but a promise may reject with anything, `undefined`
 * included, and that has no name to record.
 */
const nameOf = (thrown: unknown): string => {
  const name = (thrown as { readonly name?: unknown } | null | undefined)?.name
  return typeof name === "string" ? name : "unknown"
}

/**
 * Builds the service over a storage manager, or none.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (storage: StorageManagerLike | undefined): Service =>
  StoragePersistence.of({
    persist: storage?.persist === undefined
      ? Effect.succeed(false)
      : Effect.tryPromise(() => storage.persist!()).pipe(
        Effect.catch((error) =>
          Effect.logWarning("browser.storage.persist").pipe(
            Effect.annotateLogs({ outcome: "refused", "error.type": nameOf(error.cause) }),
            Effect.as(false)
          )
        )
      )
  })

/**
 * Provides the service over `navigator.storage`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<StoragePersistence> = Layer.sync(
  StoragePersistence,
  () => make((globalThis.navigator as { readonly storage?: StorageManagerLike } | undefined)?.storage)
)
