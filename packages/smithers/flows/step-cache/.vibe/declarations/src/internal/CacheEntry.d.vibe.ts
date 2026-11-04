/**
 * The durable cache entry model: its key grammar, its provenance, and the
 * entry schema itself.
 *
 * Every tier reads and writes this one shape, so it lives beneath the service
 * module where the admission policy and the SQL and HTTP tiers can share it
 * without importing one another. `@smthrs/step-cache/CacheStore` re-exports it
 * as part of the public contract.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
/**
 * A non-negative integer no larger than `Number.MAX_SAFE_INTEGER`.
 *
 * @private
 * @since 0.1.0
 */
export declare const NonNegativeSafeInt: Schema.Int;
/**
 * Maximum number of characters accepted in one cache-key digest.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumKeyDigestLength = 256;
/**
 * One URL-segment-safe cache-key digest.
 *
 * The cache key is accepted at both SQL and HTTP boundaries. Restricting it
 * to this grammar makes `.` / `..`, separators, controls, and ill-formed
 * Unicode unrepresentable before either boundary is touched.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const KeyDigest: Schema.String;
/**
 * A validated cache-key digest.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type KeyDigest = typeof KeyDigest.Type;
/**
 * Maximum number of UTF-16 code units accepted in a recording run id.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumRecordedRunIdLength = 1024;
/**
 * Run id carried by an immutable cache provenance record.
 *
 * Non-empty, well-formed text without a NUL, of at most
 * {@link maximumRecordedRunIdLength} code units. Other control characters are
 * admitted deliberately: the id is opaque here, it reaches SQL as a bound
 * parameter and the wire as a percent-encoded query value, and every stored
 * ledger row is read back through this schema, so narrowing it would make a row
 * an earlier build persisted undecodable.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const RecordedRunId: Schema.NonEmptyString;
/**
 * Exact journal event that recorded a cache result.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const RecordedBy: Schema.Struct<{
    readonly runId: Schema.NonEmptyString;
    readonly eventSeq: Schema.Int;
}>;
/**
 * Exact journal event that recorded a cache result.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type RecordedBy = typeof RecordedBy.Type;
/**
 * The durable data recorded for a cache key.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const CacheEntry: Schema.Struct<{
    readonly keyDigest: Schema.String;
    readonly result: Schema.Unknown;
    readonly meta: Schema.Unknown;
    readonly createdAtMs: Schema.Int;
    readonly recordedRunId: Schema.NonEmptyString;
    readonly recordedEventSeq: Schema.Int;
}>;
/**
 * The durable data recorded for a cache key.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheEntry = typeof CacheEntry.Type;
