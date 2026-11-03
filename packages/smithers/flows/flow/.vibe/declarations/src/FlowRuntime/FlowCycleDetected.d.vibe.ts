/**
 * Failure raised when executing a flow would close a cycle in the persisted
 * parent-execution chain.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
declare const FlowCycleDetected_base: Schema.Class<FlowCycleDetected, Schema.TaggedStruct<"@smthrs/flow/FlowCycleDetected", {
    /** Stable public error code. */
    readonly code: Schema.withConstructorDefault<Schema.Literal<"flow_cycle_detected">>;
    /** Ordered execution ids from the cycle's target back to itself. */
    readonly path: Schema.$Array<Schema.String>;
}>, import("effect/Cause").YieldableError>;
/**
 * Raised when executing a flow would close a cycle in the persisted
 * parent-execution chain, which is a child asking to execute an execution id
 * that already appears among its own ancestors.
 *
 * This is a **typed failure**, never a defect: the caller is expected to be
 * able to recover from it (see `docs/troubleshooting.md`,
 * "FlowRuntime.FlowCycleDetected"). Detection itself lives in
 * `@smthrs/engine-store`'s `DurableEngineState.recordRunParent`, which
 * inserts the durable parent edge and walks the parent chain in O(depth)
 * inside one storage transaction, rolling back on a hit; the error is
 * declared here because it is part of the `execute` contract this package
 * owns.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class FlowCycleDetected extends FlowCycleDetected_base {
}
export {};
