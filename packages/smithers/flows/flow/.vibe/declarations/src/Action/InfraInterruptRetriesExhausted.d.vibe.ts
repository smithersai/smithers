/**
 * Defines the `InfraInterruptRetriesExhausted` action failure.
 *
 * The `_tag` string was settled under `@smthrs/flow/` for 1.0.0-rc.0. The RC
 * makes no compatibility promise to 0.x journals, and the tag freezes when
 * the RC ships.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
import { InfraInterrupt } from "./InfraInterrupt.vibe";
declare const InfraInterruptRetriesExhausted_base: Schema.Class<InfraInterruptRetriesExhausted, Schema.TaggedStruct<"@smthrs/flow/InfraInterruptRetriesExhausted", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"infra_interrupt_retries_exhausted">>;
    readonly actionName: Schema.String;
    readonly attempts: Schema.Number;
    readonly interrupt: typeof InfraInterrupt;
    /**
     * The sentence an operator reads out of a rendered cause. The typed fields
     * beside it are what a log pipeline keys on.
     */
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * An action spent its infrastructure-interrupt retry policy without reaching
 * an ordinary success or failure.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class InfraInterruptRetriesExhausted extends InfraInterruptRetriesExhausted_base {
}
export {};
