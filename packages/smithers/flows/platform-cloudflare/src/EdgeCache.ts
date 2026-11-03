/**
 * The edge cache: `@smthrs/artifacts`' `ImmutableCache` over the Workers
 * Cache API.
 *
 * A Worker's cache lives in the data center that served the request and is
 * not replicated, so a hit costs no read from the source and a miss in
 * another data center reads it once more. Entries are immutable, so nothing
 * here invalidates them; Cloudflare may evict one at any time.
 *
 * - It uses `caches.default`, which the zone's `fetch` shares, or the named
 *   cache `caches.open(name)` answers, which holds only what this layer stores.
 * - Each call counts toward the Worker's subrequest limit (50 a request on
 *   Workers Free, 1,000 on Paid), as `fetch` does.
 * - The layer reads the global `caches` unless `options.caches` injects one,
 *   which is how tests give it a cache that refuses.
 *
 * ```ts
 * import { ImmutableCache } from "@smthrs/artifacts"
 * import { EdgeCache } from "@smthrs/platform-cloudflare"
 * import * as Effect from "effect/Effect"
 *
 * const tree = ImmutableCache.readThrough(ImmutableCache.key("repo.tree", repo, sha), readTree(repo, sha)).pipe(
 *   Effect.provide(EdgeCache.layer({ name: "repo" }))
 * )
 * ```
 *
 * @since 1.0.0
 */

import { ImmutableCache } from "@smthrs/artifacts"
import type * as Layer from "effect/Layer"

/**
 * The slice of a Worker's `CacheStorage` the layer uses.
 *
 * @category models
 * @since 1.0.0
 */
export interface CacheStorage {
  readonly default?: ImmutableCache.WebCache | undefined
  readonly open: (name: string) => Promise<ImmutableCache.WebCache>
}

/**
 * - `name`: a named cache; omitted, `caches.default`.
 * - `maxEntryBytes`: the largest entry stored. Defaults to
 *   `ImmutableCache.defaultMaxEntryBytes`, 8 MiB.
 * - `caches`: the `CacheStorage` to use instead of the global one.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly name?: string | undefined
  readonly maxEntryBytes?: number | undefined
  readonly caches?: CacheStorage | undefined
}

/**
 * Provides `ImmutableCache` over the Workers Cache API, labelled
 * `cloudflare`. A runtime without `caches`, or without `caches.default` when
 * no name is given, fails the layer with `unavailable`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  options: Options = {}
): Layer.Layer<ImmutableCache.ImmutableCache, ImmutableCache.ImmutableCacheError> =>
  ImmutableCache.layerWebCache({
    backend: "cloudflare",
    maxEntryBytes: options.maxEntryBytes,
    open: async () => {
      const storage = options.caches ?? (globalThis as { readonly caches?: CacheStorage }).caches
      if (storage === undefined) return undefined
      return options.name === undefined ? storage.default : storage.open(options.name)
    }
  })
