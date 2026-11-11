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
export * as Bank from "./Bank.vibe"

/**
 * @category database
 * @since 0.1.0
 */
export * as Database from "./Database.vibe"

/**
 * @category embeddings @since 0.1.0
 */
export * as Embedding from "./Embedding.vibe"

/**
 * @category flows @since 0.1.0
 */
export * as Flows from "./Flows.vibe"

/**
 * @category maintenance @since 0.1.0
 */
export * as Maintenance from "./Maintenance.vibe"

/**
 * @category errors @since 0.1.0
 */
export * as MemoryError from "./MemoryError.vibe"

/**
 * @category services @since 0.1.0
 */
export * as MemoryStore from "./MemoryStore.vibe"

/**
 * @category patterns
 * @since 0.1.0
 */
export * as MemoryTrellis from "./MemoryTrellis.ts"

/**
 * @category migrations
 * @since 1.0.0
 */
export * as Migrations from "./Migrations.vibe"

/**
 * @category models @since 0.1.0
 */
export * as Namespace from "./Namespace.vibe"

/**
 * @category recall @since 0.1.0
 */
export * as Recall from "./Recall.vibe"

/**
 * @category recall @since 0.1.0
 */
export * as RecallFts from "./RecallFts.vibe"

/**
 * @category recall @since 0.1.0
 */
export * as RecallKeyword from "./RecallKeyword.vibe"

/**
 * @category recall @since 0.1.0
 */
export * as RecallSemantic from "./RecallSemantic.vibe"

/**
 * @category assembly @since 0.1.0
 */
export * as Source from "./Source.ts"

/**
 * @category services @since 0.1.0
 */
export * as SnapshotRecorder from "./SnapshotRecorder.vibe"

/**
 * @category patterns
 * @since 0.1.0
 */
export * as WithMemory from "./WithMemory.vibe"

/**
 * @category services
 * @since 1.0.0
 */
export * as Opening from "./Opening.vibe"
