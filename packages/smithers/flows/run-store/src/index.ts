/**
 * Durable run state: what is running now, and who owns it.
 *
 * `RunStore` and `AttemptStore` hold the executable authoritative state that
 * recovery reads; `Ownership` supplies the liveness evidence and heartbeat
 * supervision that arbitrate it. The fencing token they trade in, `OwnerId`,
 * is defined by `@smthrs/journal`, because the journal is what it fences, and
 * is re-exported from `Ownership` here, so importing it needs no second
 * package.
 *
 * This entry point is browser-bundleable: every service here is written
 * against the driver-neutral `@smthrs/database` contract. The test double,
 * which binds a Node SQLite database, lives under an explicit subpath:
 *
 * ```ts
 * import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
 * import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"
 * ```
 *
 * @since 0.1.0
 */

/**
 * @category services
 * @since 0.1.0
 */
export * as RunStore from "./RunStore.ts"

/**
 * @category metrics
 * @since 0.1.0
 */
export * as RunStoreMetrics from "./RunStoreMetrics.vibe"

/**
 * @category ownership
 * @since 0.1.0
 */
export * as Ownership from "./Ownership.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as AttemptStore from "./AttemptStore.vibe"

/**
 * @category migrations
 * @since 0.1.0
 */
export * as Migrations from "./Migrations.vibe"
