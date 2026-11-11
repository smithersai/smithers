/**
 * The step result cache: which sealed results may be reused.
 *
 * `CacheStore` is a keyed memoization of sealed action results whose entries
 * may be evicted. It shares nothing with the journal or the run store beyond
 * the database beneath it. See the
 * {@link https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/docs/concepts/step-keys.md | step-key contract} and
 * {@link https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/journal/docs/README.md | journal architecture}.
 *
 * This entry point is browser-bundleable: the service is written against the
 * driver-neutral `@smthrs/database` contract. The test double, which binds a
 * Node SQLite database, lives under an explicit subpath:
 *
 * ```ts
 * import { CacheStore } from "@smthrs/step-cache"
 * import * as TestCacheStore from "@smthrs/step-cache/test/TestCacheStore"
 * ```
 *
 * @since 0.1.0
 */

/**
 * @category services
 * @since 0.1.0
 */
export * as CacheStore from "./CacheStore.vibe"

/**
 * @category metrics
 * @since 0.1.0
 */
export * as CacheStoreMetrics from "./CacheStoreMetrics.vibe"

/**
 * @category services
 * @since 0.1.0
 */
export * as CombinedCacheStore from "./CombinedCacheStore.vibe"

/**
 * @category migrations
 * @since 0.1.0
 */
export * as Migrations from "./Migrations.vibe"

/**
 * @category services
 * @since 0.1.0
 */
export * as RemoteCacheStore from "./RemoteCacheStore.vibe"
