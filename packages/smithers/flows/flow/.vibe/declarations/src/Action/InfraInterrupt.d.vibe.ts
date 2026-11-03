/**
 * Defines the `InfraInterrupt` action failure.
 *
 * The `_tag` string was settled under `@smthrs/flow/` for 1.0.0-rc.0. The RC
 * makes no compatibility promise to 0.x journals, and the tag freezes when
 * the RC ships.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
declare const InfraInterrupt_base: Schema.Class<InfraInterrupt, Schema.TaggedStruct<"@smthrs/flow/InfraInterrupt", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"infra_interrupt">>;
    readonly reason: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * Marker an action implementation or adapter raises for an infrastructure
 * event it wants the action's `interruptRetryPolicy` to retry. Shipped engines
 * do not synthesize it from ordinary fiber interruption.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class InfraInterrupt extends InfraInterrupt_base {
}
export {};
