/**
 * The error every cache tier reports, and its stable codes.
 *
 * It lives beneath the service module so the admission policy, the SQL tier,
 * and the HTTP tier can all raise it without importing one another.
 * `@smthrs/step-cache/CacheStore` re-exports it as part of the public contract.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
/**
 * Stable error codes returned by cache persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export declare const CacheStoreErrorCode: Schema.Literals<readonly ["invalid_cache", "constraint", "decode_failed", "persistence_failed", "unknown"]>;
/**
 * Stable error codes returned by cache persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheStoreErrorCode = typeof CacheStoreErrorCode.Type;
declare const CacheStoreError_base: Schema.Class<CacheStoreError, Schema.TaggedStruct<"@smthrs/step-cache/CacheStoreError", {
    readonly code: Schema.Literals<readonly ["invalid_cache", "constraint", "decode_failed", "persistence_failed", "unknown"]>;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * Error raised by cache persistence operations.
 *
 * The identity names the package and the error, the convention
 * `@smthrs/database`'s `DatabaseError` follows, so it stays fixed wherever the
 * class is defined and no persisted or journaled tag changes with a move.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class CacheStoreError extends CacheStoreError_base {
}
/**
 * Builds a {@link CacheStoreError}, omitting `cause` when there is none.
 *
 * @private
 * @since 0.1.0
 */
export declare const error: (code: CacheStoreErrorCode, message: string, cause?: unknown) => CacheStoreError;
export {};
