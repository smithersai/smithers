/**
 * `@smthrs/memory` stores durable cross-run facts, message threads, and notes,
 * ranks them for recall, and exposes the two callable flows a model drives:
 * `remember` and `recall`.
 *
 * Storage is SQLite through `@smthrs/database`. Recall is a replaceable slot
 * with three bindings in the box: keyword, SQLite full text, and in-process
 * semantic. A memory policy attached to a flow decides which namespace its tree
 * reads and writes, and whether recall runs at all.
 *
 * @since 0.1.0
 */

/**
 * @category constructors @since 0.1.0
 */
export * as Bank from "./Bank.ts"

/**
 * @category database
 * @since 0.1.0
 */
export * as Database from "./Database.ts"

/**
 * @category embeddings @since 0.1.0
 */
export * as Embedding from "./Embedding.ts"

/**
 * @category flows @since 0.1.0
 */
export * as Flows from "./Flows.ts"

/**
 * @category maintenance @since 0.1.0
 */
export * as Maintenance from "./Maintenance.ts"

/**
 * @category errors @since 0.1.0
 */
export * as MemoryError from "./MemoryError.ts"

/**
 * @category services @since 0.1.0
 */
export * as MemoryStore from "./MemoryStore.ts"

/**
 * @category patterns
 * @since 0.1.0
 */
export * as MemoryTrellis from "./MemoryTrellis.ts"

/**
 * @category migrations
 * @since 1.0.0
 */
export * as Migrations from "./Migrations.ts"

/**
 * @category models @since 0.1.0
 */
export * as Namespace from "./Namespace.ts"

/**
 * @category recall @since 0.1.0
 */
export * as Recall from "./Recall.ts"

/**
 * @category recall @since 0.1.0
 */
export * as RecallFts from "./RecallFts.ts"

/**
 * @category recall @since 0.1.0
 */
export * as RecallKeyword from "./RecallKeyword.ts"

/**
 * @category recall @since 0.1.0
 */
export * as RecallSemantic from "./RecallSemantic.ts"

/**
 * @category assembly @since 0.1.0
 */
export * as Source from "./Source.ts"

/**
 * @category services @since 0.1.0
 */
export * as SnapshotRecorder from "./SnapshotRecorder.ts"

/**
 * @category patterns
 * @since 0.1.0
 */
export * as WithMemory from "./WithMemory.ts"
