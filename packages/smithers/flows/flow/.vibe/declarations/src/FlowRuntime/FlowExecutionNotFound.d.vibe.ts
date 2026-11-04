/**
 * Failure raised when `poll` addresses an execution the runtime has no record
 * of.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
declare const FlowExecutionNotFound_base: Schema.Class<FlowExecutionNotFound, Schema.TaggedStruct<"@smthrs/flow/FlowExecutionNotFound", {
    /** Stable public error code. */
    readonly code: Schema.withConstructorDefault<Schema.Literal<"execution_not_found">>;
    /** The execution id the runtime has no record of. */
    readonly executionId: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * Raised when `poll` is asked about an execution id the runtime never
 * recorded.
 *
 * This is a **typed failure**, never a defect, and never folded into the
 * success channel: `poll` answers `Option.none` for a known execution that has
 * not settled yet, so answering it for an unknown id as well would leave the
 * caller unable to distinguish "still running" from "no such execution". A
 * caller holding a stored execution id needs that distinction — a run that is
 * still in flight is waited on, one the runtime has no record of is a wiring
 * or retention problem to surface.
 *
 * The error is declared here because it is part of the `poll` contract this
 * package owns; every runtime — the in-memory engine and the durable
 * `@smthrs/engine-store` driver alike — raises it for an unknown id.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class FlowExecutionNotFound extends FlowExecutionNotFound_base {
    /** @since 0.1.0 */
    get message(): string;
}
export {};
