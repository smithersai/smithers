/**
 * `@smthrs/artifacts`' `ImmutableCache` over the browser's Cache Storage.
 *
 * Cache Storage belongs to the origin and outlives the tab and the browser,
 * so content read once at a commit SHA opens again without the network,
 * which is what the local-first read path wants. A window, a dedicated worker
 * and a service worker of the origin all reach the same named cache.
 *
 * - The browser may evict the origin's storage under pressure unless the
 *   origin has persistent storage (`StoragePersistence`); a `get` then misses.
 * - A `put` over the origin's quota fails with `QuotaExceededError` as its
 *   `errorName`; `ImmutableCache.readThrough` still answers the read.
 * - Cache Storage needs a secure context: `https:` or `localhost`.
 * - The layer reads the global `caches` unless `options.caches` injects one,
 *   which is how tests give it a cache that refuses.
 *
 * ```ts
 * import { ImmutableCache } from "@smthrs/artifacts"
 * import { BrowserCache } from "@smthrs/platform-browser"
 * import * as Effect from "effect/Effect"
 *
 * const tree = ImmutableCache.readThrough(ImmutableCache.key("repo.tree", repo, sha), fetchTree(repo, sha)).pipe(
 *   Effect.provide(BrowserCache.layer())
 * )
 * ```
 *
 * @since 1.0.0
 */

import { ImmutableCache } from "@smthrs/artifacts"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Schema from "effect/Schema"

/**
 * The slice of `CacheStorage` the layer uses.
 *
 * @category models
 * @since 1.0.0
 */
export interface CacheStorage {
  readonly open: (name: string) => Promise<ImmutableCache.WebCache>
}

/**
 * - `name`: the cache to open. Defaults to {@link defaultName}.
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
 * The cache the layer opens when no name is given.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultName = "smithers-immutable-cache"

/**
 * Provides `ImmutableCache` over Cache Storage, labelled `browser`. A context
 * without `caches`, or one that refuses to open the cache, fails the layer
 * with `unavailable`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  options: Options = {}
): Layer.Layer<ImmutableCache.ImmutableCache, ImmutableCache.ImmutableCacheError> =>
  ImmutableCache.layerWebCache({
    backend: "browser",
    maxEntryBytes: options.maxEntryBytes,
    open: async () => {
      const storage = options.caches ?? (globalThis as { readonly caches?: CacheStorage }).caches
      return storage?.open(options.name ?? defaultName)
    }
  })

/**
 * A binary response from Cache Storage or the network.
 * @category models
 * @since 1.0.0
 */
export type AssetResponse = Pick<Response, "ok" | "status" | "arrayBuffer">

/**
 * The worker's asset sources. Faults are supplied as Effects, without replacing globals.
 * @category services
 * @since 1.0.0
 */
export class AssetSource extends Context.Service<AssetSource, {
  readonly match: (url: string) => Effect.Effect<AssetResponse | undefined, unknown>
  readonly fetch: (url: string) => Effect.Effect<AssetResponse, unknown>
}>()("@smthrs/platform-browser/BrowserCache/AssetSource") {}

/**
 * The asset could not be read; no URL or response content enters the error.
 * @category errors
 * @since 1.0.0
 */
export class AssetUnavailable
  extends Schema.TaggedError<AssetUnavailable>()("@smthrs/platform-browser/AssetUnavailable", {
    phase: Schema.Literals(["network", "http", "body"]),
    code: Schema.String
  })
{}

const assetCode = (error: unknown): string => error instanceof Error ? error.name : "unknown"

/**
 * Binary asset reads, by source and outcome, never by URL.
 * @category metrics
 * @since 1.0.0
 */
export const assetReads = Metric.counter("browser_cached_asset_reads", {
  description: "Worker binary assets read, by source and outcome",
  incremental: true
})

/**
 * The native worker's Cache Storage and fetch. Lookup spans every named cache,
 * including the PWA's precache. WebKit worker fetch does not inherit that cache.
 * @category layers
 * @since 1.0.0
 */
export const layerAssets = (options: {
  readonly caches?: Pick<globalThis.CacheStorage, "match">
  readonly fetch?: typeof globalThis.fetch
} = {}): Layer.Layer<AssetSource> =>
  Layer.succeed(AssetSource, {
    match: (url) =>
      Effect.tryPromise({
        try: async () => (options.caches ?? globalThis.caches)?.match(url),
        catch: (error) => error
      }),
    fetch: (url) =>
      Effect.tryPromise({
        try: (signal) => (options.fetch ?? globalThis.fetch)(url, { signal }),
        catch: (error) => error
      })
  })

/**
 * Reads an immutable, versioned binary asset before asking the network. Dedicated workers
 * can therefore reopen SQLite offline even when native fetch bypasses the PWA.
 * Cache lookup refusal falls through to the real network; a failed read is typed.
 * @category reading
 * @since 1.0.0
 */
export const readAsset = (url: string): Effect.Effect<ArrayBuffer, AssetUnavailable, AssetSource> =>
  Effect.gen(function*() {
    const io = yield* AssetSource
    const cached = yield* Effect.result(io.match(url))
    if (cached._tag === "Failure") {
      yield* Effect.logWarning("browser.cache.asset.lookup").pipe(
        Effect.annotateLogs({ outcome: "unavailable", errorCode: assetCode(cached.failure) })
      )
    }
    const hit = cached._tag === "Success" && cached.success?.ok === true ? cached.success : undefined
    const source = hit === undefined ? "network" : "cache"
    const response = hit === undefined
      ? io.fetch(url).pipe(
        Effect.mapError((error) => new AssetUnavailable({ phase: "network", code: assetCode(error) }))
      )
      : Effect.succeed(hit)
    return yield* response.pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.tryPromise({
            try: () => response.arrayBuffer(),
            catch: (error) => new AssetUnavailable({ phase: "body", code: assetCode(error) })
          })
          : Effect.fail(new AssetUnavailable({ phase: "http", code: `HTTP_${response.status}` }))
      ),
      Effect.onExit((exit) => {
        const outcome = exit._tag === "Success" ? "loaded" : Exit.hasInterrupts(exit) ? "cancelled" : "failed"
        const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
        const failure = error instanceof AssetUnavailable ? { phase: error.phase, errorCode: error.code } : {}
        return Metric.update(Metric.withAttributes(assetReads, { source, outcome }), 1).pipe(
          Effect.andThen(
            (outcome === "failed" ? Effect.logWarning : Effect.logInfo)("browser.cache.asset").pipe(
              Effect.annotateLogs({ source, outcome, ...failure })
            )
          )
        )
      })
    )
  }).pipe(Effect.withSpan("browser.cache.asset"))
