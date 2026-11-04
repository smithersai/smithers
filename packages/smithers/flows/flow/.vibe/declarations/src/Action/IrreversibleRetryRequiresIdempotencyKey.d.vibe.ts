/**
 * Defines the `IrreversibleRetryRequiresIdempotencyKey` action failure.
 *
 * The `_tag` string was settled under `@smthrs/flow/` for 1.0.0-rc.0. The RC
 * makes no compatibility promise to 0.x journals, and the tag freezes when
 * the RC ships.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
declare const IrreversibleRetryRequiresIdempotencyKey_base: Schema.Class<IrreversibleRetryRequiresIdempotencyKey, Schema.TaggedStruct<"@smthrs/flow/IrreversibleRetryRequiresIdempotencyKey", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"irreversible_retry_requires_idempotency_key">>;
    readonly actionName: Schema.String;
    readonly attempt: Schema.Number;
}>, import("effect/Cause").YieldableError>;
/**
 * An irreversible action attempted a retry without declaring an
 * idempotency key.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class IrreversibleRetryRequiresIdempotencyKey extends IrreversibleRetryRequiresIdempotencyKey_base {
}
export {};
