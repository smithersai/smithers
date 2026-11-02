/**
 * Stable memory failures.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
/**
 * Stable codes returned by memory operations.
 *
 * @category models
 * @since 0.1.0
 */
export declare const MemoryErrorCode: Schema.Literals<readonly ["not_found", "fts_not_enabled", "invalid_namespace", "invalid_tag", "invalid_argument", "supersede_conflict", "idempotency_conflict", "compaction_conflict", "embedding_unavailable", "vector_model_mismatch", "store"]>;
/**
 * Stable memory failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type MemoryErrorCode = typeof MemoryErrorCode.Type;
declare const MemoryError_base: Schema.Class<MemoryError, Schema.TaggedStruct<"flows/memory/MemoryError", {
    readonly code: Schema.Literals<readonly ["not_found", "fts_not_enabled", "invalid_namespace", "invalid_tag", "invalid_argument", "supersede_conflict", "idempotency_conflict", "compaction_conflict", "embedding_unavailable", "vector_model_mismatch", "store"]>;
    readonly message: Schema.String;
    readonly path: Schema.optional<Schema.$Array<Schema.String>>;
    readonly cause: Schema.optional<Schema.Defect>;
}>, import("effect/Cause").YieldableError>;
/**
 * Error raised by memory validation, storage, search, or projection.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class MemoryError extends MemoryError_base {
}
export {};
