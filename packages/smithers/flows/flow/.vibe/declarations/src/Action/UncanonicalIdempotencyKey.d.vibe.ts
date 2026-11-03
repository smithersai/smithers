/**
 * Defines the `UncanonicalIdempotencyKey` action failure.
 *
 * The `_tag` string was settled under `@smthrs/flow/` for 1.0.0-rc.0. The RC
 * makes no compatibility promise to 0.x journals, and the tag freezes when
 * the RC ships.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
declare const UncanonicalIdempotencyKey_base: Schema.Class<UncanonicalIdempotencyKey, Schema.TaggedStruct<"@smthrs/flow/UncanonicalIdempotencyKey", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"uncanonical_idempotency_key">>;
    readonly actionName: Schema.String;
    /** Stable reason identifying an RFC 8785 canonicalization failure. */
    readonly reason: Schema.String;
    /** The path of the offending value inside the declared identity. */
    readonly path: Schema.String;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A caller-declared object-form `idempotencyKey` carried material canonical
 * serialization rejects. The declaration can be fixed, and the error is
 * non-retryable: the same declaration
 * derives the same rejection on every attempt, so the body never runs.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class UncanonicalIdempotencyKey extends UncanonicalIdempotencyKey_base {
}
export {};
