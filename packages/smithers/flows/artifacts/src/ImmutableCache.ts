/**
 * An immutable cache: bytes stored under a content address and never changed.
 *
 * A key names content that cannot change, such as a repository's file at a
 * commit SHA, so an entry never goes stale and the cache has no invalidation,
 * no expiry and no versioning beyond its own format. A backend may still
 * evict an entry; a later `get` then misses and the caller reads the source
 * again.
 *
 * - {@link ImmutableCache} is the service: `get` and `put`. {@link readThrough}
 *   is the usual call: answer from the cache, else compute, store and answer.
 *   A failure is never stored, and a cache that fails never fails the read.
 * - Entries are bounded: `bytes` up to `maxEntryBytes` (default 8 MiB) and
 *   string `metadata` up to 1,024 bytes of JSON. A larger `put` stores nothing
 *   and answers `too_large`.
 * - The backend is any object with the Web Cache API's `match` and `put`, so
 *   one implementation serves every host. {@link layerMemory} keeps entries in
 *   memory with a total bound, for Node and tests. `@smthrs/platform-cloudflare`
 *   provides the Workers Cache API (`EdgeCache.layer`) and
 *   `@smthrs/platform-browser` provides Cache Storage (`BrowserCache.layer`).
 * - Each call is one span, `ImmutableCache.get` or `ImmutableCache.put`, one
 *   count on {@link requests} and, on a hit or a store, its bytes on
 *   {@link bytes}. Telemetry carries the backend, the key's namespace, the
 *   operation and the outcome, never a key's parts or an entry's content.
 *
 * ```ts
 * import { ImmutableCache } from "@smthrs/artifacts"
 *
 * const blob = (repo: string, sha: string, path: string) =>
 *   ImmutableCache.readThrough(
 *     ImmutableCache.key("repo.blob", repo, sha, path),
 *     readFromSource(repo, sha, path) // an Effect of { bytes, metadata }
 *   )
 * ```
 *
 * @since 1.0.0
 */

import { digestSync } from "@smthrs/crypto"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * A content address: a `namespace` for the kind of content, such as
 * `repo.blob`, and the `parts` that name one item, such as a repository, a
 * commit SHA and a path.
 *
 * The namespace is a short constant label, because telemetry carries it: a
 * lowercase letter, then lowercase letters and digits, optionally joined by
 * `.`, `_` or `-`, at most 64 characters. A call with any other namespace dies.
 * The parts are free text and never leave the cache: the backend sees only
 * their SHA-256.
 *
 * @category models
 * @since 1.0.0
 */
export interface Key {
  readonly namespace: string
  readonly parts: ReadonlyArray<string>
}

/**
 * Builds a {@link Key}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const key = (namespace: string, ...parts: ReadonlyArray<string>): Key => ({ namespace, parts })

/**
 * What a key holds: the content's `bytes` and small string `metadata`, such
 * as the content's own hash or type.
 *
 * @category models
 * @since 1.0.0
 */
export interface Entry {
  readonly bytes: Uint8Array
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * What a `put` did: `stored`, or `too_large` when the entry is over the
 * cache's bounds and nothing was stored.
 *
 * @category models
 * @since 1.0.0
 */
export type PutOutcome = "stored" | "too_large"

/**
 * A cache call that failed.
 *
 * - `operation`: `open` (building the layer), `get` or `put`.
 * - `reason`: `unavailable` (the host has no cache, or refused to open it),
 *   `failed` (the backend refused the call, for example over its quota) or
 *   `corrupt` (a stored entry this cache cannot read).
 * - `errorName`: the backend's error name, such as `QuotaExceededError`,
 *   when it threw one. Never its message.
 *
 * @category errors
 * @since 1.0.0
 */
export class ImmutableCacheError extends Schema.TaggedError<ImmutableCacheError>()(
  "@smthrs/artifacts/ImmutableCacheError",
  {
    backend: Schema.String,
    operation: Schema.Literals(["open", "get", "put"]),
    reason: Schema.Literals(["unavailable", "failed", "corrupt"]),
    errorName: Schema.optional(Schema.String)
  }
) {
  /**
   * The backend, the operation, the reason and any error name.
   *
   * @since 1.0.0
   */
  override get message(): string {
    return `Immutable cache (${this.backend}) ${this.operation} ${this.reason}${
      this.errorName === undefined ? "" : ` (${this.errorName})`
    }`
  }
}

/**
 * The cache's operations.
 *
 * - `get`: the entry at `key`, or `None` on a miss.
 * - `put`: stores `entry` at `key`, or answers `too_large` and stores nothing.
 *   Storing a key again replaces it with what must be the same content.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  readonly get: (key: Key) => Effect.Effect<Option.Option<Entry>, ImmutableCacheError>
  readonly put: (key: Key, entry: Entry) => Effect.Effect<PutOutcome, ImmutableCacheError>
}

/**
 * The immutable cache, as a service.
 *
 * @category services
 * @since 1.0.0
 */
export class ImmutableCache extends Context.Service<ImmutableCache, Service>()("@smthrs/artifacts/ImmutableCache") {}

/**
 * The slice of the Web Cache API a backend must answer. A browser's
 * `caches.open(name)` and a Worker's `caches.default` both do, and so does
 * {@link makeMemoryWebCache}. Keys are `https:` URLs; values are `200`
 * responses with a `Cache-Control` the Workers cache honors.
 *
 * @category models
 * @since 1.0.0
 */
export interface WebCache {
  readonly match: (url: string) => Promise<Response | undefined>
  readonly put: (url: string, response: Response) => Promise<void>
}

/**
 * Bounds and the telemetry label for a cache over a {@link WebCache}.
 *
 * - `backend`: the label telemetry and errors carry, such as `cloudflare`.
 * - `maxEntryBytes`: the largest `bytes` a `put` stores. Defaults to
 *   {@link defaultMaxEntryBytes}.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly backend: string
  readonly maxEntryBytes?: number | undefined
}

/**
 * The default bound on an entry's bytes: 8 MiB, which holds a 50,000-path
 * tree listing.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultMaxEntryBytes = 8 * 1024 * 1024

/**
 * The bound on an entry's metadata, as UTF-8 JSON: 1,024 bytes.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxMetadataBytes = 1024

/**
 * The default bound on everything {@link layerMemory} holds: 64 MiB.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultMaxTotalBytes = 64 * 1024 * 1024

/**
 * Cache calls: `immutable_cache_requests`, by `backend`, `namespace`,
 * `operation` (`get` or `put`) and `outcome` (`hit`, `miss`, `stored`,
 * `too_large`, `failed` or `interrupted`).
 *
 * @category observability
 * @since 1.0.0
 */
export const requests: Metric.Counter<number> = Metric.counter("immutable_cache_requests", {
  description: "Immutable cache calls, by backend, namespace, operation and outcome",
  incremental: true
})

/**
 * Entry bytes moved: `immutable_cache_bytes`, by `backend`, `namespace` and
 * `operation`. A `get` counts the bytes of a hit; a `put` counts the bytes it
 * stored.
 *
 * @category observability
 * @since 1.0.0
 */
export const bytes: Metric.Counter<number> = Metric.counter("immutable_cache_bytes", {
  description: "Immutable cache entry bytes served on a hit or stored, by backend, namespace and operation",
  incremental: true
})

const namespacePattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const metadataHeader = "x-immutable-cache-metadata"
const encoder = new TextEncoder()
const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))

/** The backend's error name, when it is one: never free text. */
const nameOf = (cause: unknown): { readonly errorName?: string } => {
  const name = (cause as { readonly name?: unknown } | null | undefined)?.name
  return typeof name === "string" && /^[A-Za-z]{1,64}$/.test(name) ? { errorName: name } : {}
}

/** The URL a key is stored at: its namespace and the SHA-256 of its parts, so no part reaches the backend. */
const address = (key: Key): Effect.Effect<string> =>
  key.namespace.length <= 64 && namespacePattern.test(key.namespace)
    ? Effect.succeed(`https://immutable-cache.invalid/v1/${key.namespace}/${digestSync(JSON.stringify(key.parts))}`)
    : Effect.die(new TypeError("an ImmutableCache key's namespace must be a short lowercase label"))

/**
 * Builds the service over `cache`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (cache: WebCache, options: Options): Service => {
  const backend = options.backend
  const maxEntryBytes = options.maxEntryBytes ?? defaultMaxEntryBytes

  const attempt = <A>(operation: "get" | "put", run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new ImmutableCacheError({ backend, operation, reason: "failed", ...nameOf(cause) })
    })

  /** One span, one request count and the bytes moved, labelled by namespace only. */
  const observe = <A>(
    operation: "get" | "put",
    key: Key,
    outcome: (value: A) => { readonly outcome: string; readonly bytes: number },
    effect: Effect.Effect<A, ImmutableCacheError>
  ) => {
    const labels = { backend, namespace: key.namespace, operation }
    return effect.pipe(
      Effect.onExit((exit) => {
        const result = Exit.isSuccess(exit)
          ? outcome(exit.value)
          : { outcome: Exit.hasInterrupts(exit) ? "interrupted" : "failed", bytes: 0 }
        return Effect.all([
          Metric.update(Metric.withAttributes(requests, { ...labels, outcome: result.outcome }), 1),
          Metric.update(Metric.withAttributes(bytes, labels), result.bytes),
          Effect.annotateCurrentSpan({
            "immutable_cache.outcome": result.outcome,
            "immutable_cache.bytes": result.bytes
          })
        ], { discard: true })
      }),
      Effect.withSpan(`ImmutableCache.${operation}`, {
        attributes: { "immutable_cache.backend": backend, "immutable_cache.namespace": key.namespace }
      })
    )
  }

  return ImmutableCache.of({
    get: (key) =>
      Effect.flatMap(address(key), (url) =>
        observe(
          "get",
          key,
          Option.match({
            onNone: () => ({ outcome: "miss", bytes: 0 }),
            onSome: (entry) => ({ outcome: "hit", bytes: entry.bytes.byteLength })
          }),
          Effect.gen(function*() {
            const response = yield* attempt("get", () => cache.match(url))
            if (response === undefined) return Option.none<Entry>()
            const body = new Uint8Array(yield* attempt("get", () => response.arrayBuffer()))
            const metadata = decodeMetadata(decodeURIComponentOrNull(response.headers.get(metadataHeader)))
            if (Option.isNone(metadata)) {
              return yield* new ImmutableCacheError({ backend, operation: "get", reason: "corrupt" })
            }
            return Option.some<Entry>({ bytes: body, metadata: metadata.value })
          })
        )),

    put: (key, entry) =>
      Effect.flatMap(address(key), (url) =>
        observe(
          "put",
          key,
          (outcome: PutOutcome) => ({ outcome, bytes: outcome === "stored" ? entry.bytes.byteLength : 0 }),
          Effect.gen(function*() {
            const metadata = JSON.stringify(entry.metadata)
            if (entry.bytes.byteLength > maxEntryBytes || encoder.encode(metadata).byteLength > maxMetadataBytes) {
              return "too_large" as const
            }
            // `slice` copies, so the caller may reuse its array once `put` starts.
            const response = new Response(entry.bytes.slice(), {
              headers: {
                "cache-control": "public, max-age=31536000, immutable",
                "content-type": "application/octet-stream",
                [metadataHeader]: encodeURIComponent(metadata)
              }
            })
            yield* attempt("put", () => cache.put(url, response))
            return "stored" as const
          })
        ))
  })
}

/** A percent-encoded header's text, or `null` when it is absent or malformed. */
const decodeURIComponentOrNull = (value: string | null): string | null => {
  if (value === null) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/**
 * Provides the service over the cache `open` answers. When it answers
 * `undefined`, rejects or throws, the layer fails with `unavailable`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerWebCache = (
  options: Options & { readonly open: () => Promise<WebCache | undefined> }
): Layer.Layer<ImmutableCache, ImmutableCacheError> =>
  Layer.effect(
    ImmutableCache,
    Effect.gen(function*() {
      const unavailable = (cause?: unknown) =>
        new ImmutableCacheError({
          backend: options.backend,
          operation: "open",
          reason: "unavailable",
          ...nameOf(cause)
        })
      const cache = yield* Effect.tryPromise({ try: options.open, catch: unavailable })
      if (cache === undefined) return yield* unavailable()
      return make(cache, options)
    })
  )

/**
 * A {@link WebCache} in memory, holding at most `maxTotalBytes` of bodies.
 * Over that bound it evicts the least recently used entries. It keeps a copy
 * of each body and answers each `match` with a new response.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeMemoryWebCache = (maxTotalBytes: number = defaultMaxTotalBytes): WebCache => {
  const stored = new Map<string, { readonly body: Uint8Array; readonly headers: Array<[string, string]> }>()
  let total = 0
  const remove = (url: string) => {
    const found = stored.get(url)
    if (found === undefined) return undefined
    stored.delete(url)
    total -= found.body.byteLength
    return found
  }
  return {
    match: async (url) => {
      const found = remove(url)
      if (found === undefined) return undefined
      // Taken out and put back: the most recently used entry is the last one.
      stored.set(url, found)
      total += found.body.byteLength
      return new Response(found.body.slice(), { headers: found.headers })
    },
    put: async (url, response) => {
      const body = new Uint8Array(await response.arrayBuffer())
      remove(url)
      if (body.byteLength > maxTotalBytes) return
      stored.set(url, { body, headers: [...response.headers] })
      total += body.byteLength
      for (const oldest of stored.keys()) {
        if (total <= maxTotalBytes) break
        remove(oldest)
      }
    }
  }
}

/**
 * Bounds for {@link layerMemory}: `maxEntryBytes` (default
 * {@link defaultMaxEntryBytes}, and never more than the total) and
 * `maxTotalBytes` (default {@link defaultMaxTotalBytes}).
 *
 * @category models
 * @since 1.0.0
 */
export interface MemoryOptions {
  readonly maxEntryBytes?: number | undefined
  readonly maxTotalBytes?: number | undefined
}

/**
 * Provides the service in memory, labelled `memory`, for Node and tests.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerMemory = (options: MemoryOptions = {}): Layer.Layer<ImmutableCache> =>
  Layer.sync(ImmutableCache, () => {
    const maxTotalBytes = options.maxTotalBytes ?? defaultMaxTotalBytes
    return make(makeMemoryWebCache(maxTotalBytes), {
      backend: "memory",
      maxEntryBytes: Math.min(options.maxEntryBytes ?? defaultMaxEntryBytes, maxTotalBytes)
    })
  })

/**
 * Answers `key` from the cache, else runs `compute`, stores its entry and
 * answers it.
 *
 * - A failed `compute` fails the read and stores nothing.
 * - A cache that fails is a miss on `get` and is skipped on `put`, with one
 *   warning log naming the backend, namespace, operation and reason; the read
 *   still answers.
 * - An entry over the bounds is answered and not stored.
 *
 * @category combinators
 * @since 1.0.0
 */
export const readThrough = <E, R>(
  key: Key,
  compute: Effect.Effect<Entry, E, R>
): Effect.Effect<Entry, E, R | ImmutableCache> =>
  Effect.gen(function*() {
    const cache = yield* ImmutableCache
    const cached = yield* cache.get(key).pipe(
      Effect.catch((error) => Effect.as(warn(error, key), Option.none<Entry>()))
    )
    if (Option.isSome(cached)) return cached.value
    const entry = yield* compute
    yield* cache.put(key, entry).pipe(Effect.catch((error) => warn(error, key)))
    return entry
  })

const warn = (error: ImmutableCacheError, key: Key) =>
  Effect.logWarning("immutable cache call failed; reading through").pipe(
    Effect.annotateLogs({
      backend: error.backend,
      namespace: key.namespace,
      operation: error.operation,
      reason: error.reason,
      ...(error.errorName === undefined ? {} : { "error.type": error.errorName })
    })
  )
