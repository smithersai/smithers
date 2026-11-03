/**
 * Defines the `ImplementationVersionMismatch` action failure.
 *
 * The `_tag` string was settled under `@smthrs/flow/` for 1.0.0-rc.0. The RC
 * makes no compatibility promise to 0.x journals, and the tag freezes when
 * the RC ships.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
declare const ImplementationVersionMismatch_base: Schema.Class<ImplementationVersionMismatch, Schema.TaggedStruct<"@smthrs/flow/ImplementationVersionMismatch", {
    readonly actionName: Schema.String;
    readonly declaredVersion: Schema.NullOr<Schema.String>;
    readonly registeredVersion: Schema.NullOr<Schema.String>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A handler registration does not attest the declaration's implementation version.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class ImplementationVersionMismatch extends ImplementationVersionMismatch_base {
}
export {};
