/** Execution identity refusals shared by authoring and engine layers.
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
declare const ExecutionIdentityConflict_base: Schema.Class<ExecutionIdentityConflict, Schema.TaggedStruct<"@smthrs/engine/ExecutionIdentityConflict", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"execution_identity_conflict">>;
    readonly executionId: Schema.String;
    readonly field: Schema.Literals<readonly ["flow", "payload", "capabilities", "lineage", "round", "parent", "retry"]>;
    readonly expected: Schema.String;
    readonly actual: Schema.String;
    readonly status: Schema.withConstructorDefault<Schema.Literals<readonly ["pending", "running", "suspended", "completed", "failed", "cancelled", "unknown"]>>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A caller reused an execution id for different persisted run identity.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class ExecutionIdentityConflict extends ExecutionIdentityConflict_base {
}
export {};
