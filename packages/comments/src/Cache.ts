/**
 * Content-addressed verdict cache key computation and in-memory or file-backed Effect cache layers.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Fs from "node:fs/promises"
import type { Mode } from "./Config.ts"
import { atomicWrite, canonicalJson, compare, isMissing, sha256 } from "./internal/FsSafe.ts"
import type { CommentStyle, LanguageFamily } from "./Lexer.ts"
import type { Diagnostic } from "./Validator.ts"

/**
 * Content-addressed inputs hashed to produce a deterministic comment cache key.
 *
 * @since 1.0.0
 * @category models
 */
export interface CacheKeyInput {
  readonly path: string
  readonly language: LanguageFamily
  readonly mode: Mode
  readonly commentId: string
  readonly commentStyle: CommentStyle
  readonly commentBody: string
  readonly anchoredCodeRegion: string
  readonly rubric: string
  readonly modelId: string
}

/**
 * Persisted validation outcome stored under a content-addressed cache key.
 *
 * @since 1.0.0
 * @category models
 */
export interface CacheVerdict {
  readonly ok: boolean
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly suggestedBody?: string
  readonly updatedAt: string
}

/**
 * Computes the deterministic SHA-256 cache key for a comment and anchored code region.
 *
 * @since 1.0.0
 * @category caching
 */
export const computeCacheKey = (input: CacheKeyInput): string =>
  sha256(
    canonicalJson({
      schemaVersion: 1,
      path: input.path,
      language: input.language,
      mode: input.mode,
      commentId: input.commentId,
      commentStyle: input.commentStyle,
      commentBody: input.commentBody,
      anchoredCodeRegion: input.anchoredCodeRegion,
      rubric: input.rubric,
      modelId: input.modelId
    })
  )

/**
 * Service contract for reading, writing, sizing, and flushing comment verdicts.
 *
 * @since 1.0.0
 * @category services
 */
export interface CommentCacheStoreShape {
  readonly get: (key: string) => Effect.Effect<CacheVerdict | undefined>
  readonly set: (key: string, verdict: CacheVerdict) => Effect.Effect<void>
  readonly size: () => Effect.Effect<number>
  readonly flush: () => Effect.Effect<void>
}

/**
 * Effect Context service tag for the incremental comment verdict cache.
 *
 * @since 1.0.0
 * @category services
 */
export class CommentCacheStore extends Context.Service<CommentCacheStore, CommentCacheStoreShape>()(
  "smithers-comments/CommentCacheStore"
) {}

/**
 * Creates an ephemeral in-memory CommentCacheStore layer.
 *
 * @since 1.0.0
 * @category layers
 */
export const memoryCacheLayer = (): Layer.Layer<CommentCacheStore> =>
  Layer.sync(CommentCacheStore, () => {
    const entries = new Map<string, CacheVerdict>()
    return {
      get: (key) => Effect.sync(() => entries.get(key)),
      set: (key, verdict) =>
        Effect.sync(() => {
          entries.set(key, verdict)
        }),
      size: () => Effect.sync(() => entries.size),
      flush: () => Effect.void
    }
  })

interface PersistedCache {
  readonly version: 1
  readonly entries: Record<string, CacheVerdict>
}

/**
 * Creates an atomically persisted JSON file-backed CommentCacheStore layer.
 *
 * @since 1.0.0
 * @category layers
 */
export const fileCacheLayer = (cacheFilePath: string): Layer.Layer<CommentCacheStore> =>
  Layer.effect(
    CommentCacheStore,
    Effect.gen(function*() {
      const entries = new Map<string, CacheVerdict>()
      let dirty = false

      const raw = yield* Effect.tryPromise({
        try: () => Fs.readFile(cacheFilePath, "utf8"),
        catch: (cause) => cause
      }).pipe(
        Effect.catch((cause) => {
          if (isMissing(cause)) return Effect.succeed<string | undefined>(undefined)
          return Effect.succeed<string | undefined>(undefined)
        })
      )

      if (raw !== undefined) {
        try {
          const parsed = JSON.parse(raw) as Partial<PersistedCache>
          if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
            for (const [key, verdict] of Object.entries(parsed.entries)) {
              entries.set(key, verdict)
            }
          }
        } catch {
          // Ignore corrupted cache file; fresh entries will overwrite cleanly on flush
        }
      }

      return {
        get: (key) => Effect.sync(() => entries.get(key)),
        set: (key, verdict) =>
          Effect.sync(() => {
            entries.set(key, verdict)
            dirty = true
          }),
        size: () => Effect.sync(() => entries.size),
        flush: () =>
          Effect.gen(function*() {
            if (!dirty) return
            const sorted: Record<string, CacheVerdict> = {}
            for (const key of [...entries.keys()].sort(compare)) {
              sorted[key] = entries.get(key)!
            }
            const payload: PersistedCache = { version: 1, entries: sorted }
            yield* Effect.tryPromise({
              try: () => atomicWrite(cacheFilePath, JSON.stringify(payload, null, 2) + "\n"),
              catch: (cause) => cause
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  dirty = false
                })
              ),
              Effect.catch((error) => Effect.logWarning("Failed to persist comments cache", error))
            )
          })
      }
    })
  )
