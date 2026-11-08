import type { CacheStorage } from "./EdgeCache.vibe"

/** The cache storage of the current Worker, when available. */
export const cacheStorage = (): CacheStorage | undefined =>
  (globalThis as { readonly caches?: CacheStorage }).caches
