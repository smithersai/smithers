/**
 * Failure raised when a flow execution has no explicit or derived identity.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
declare const ExecutionIdRequired_base: Schema.Class<ExecutionIdRequired, Schema.TaggedStruct<"@smthrs/flow/ExecutionIdRequired", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"execution_id_required">>;
    readonly flowName: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A flow execution has no selected identity.
 *
 * The opt-in `derived` execution-id source raises this when the payload
 * cannot be canonicalized, for example a non-finite number, a lone surrogate,
 * or a cycle. It dies with it before starting a run, so this is a defect and
 * not a typed failure a body catches. The default `fresh` source instead
 * mints a cryptographic UUID for every unkeyed invocation.
 *
 * A served resume raises it too: `FlowProxyServer` dies with it when the
 * `ExecutionIdScope` configured on a layer returns `undefined` for a resume
 * request, because the client value is not a fallback there.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class ExecutionIdRequired extends ExecutionIdRequired_base {
}
export {};
