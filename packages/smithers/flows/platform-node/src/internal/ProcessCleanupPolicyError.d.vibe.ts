/**
 * A process cleanup policy that cannot be honoured: a termination signal the
 * platform does not define or cannot deliver, or a grace that overflows a
 * native timer. `policy` reports one as the `cause` of a `PlatformError`.
 *
 * @since 1.0.0
 */
import { Schema } from "effect";
/**
 * Which part of the policy was refused.
 *
 * @category models
 * @since 1.0.0
 */
export declare const ProcessCleanupPolicyErrorCode: Schema.Literals<readonly ["kill_signal_unsupported", "grace_out_of_range"]>;
declare const ProcessCleanupPolicyError_base: Schema.Class<ProcessCleanupPolicyError, Schema.TaggedStruct<"@smthrs/platform-node/ProcessCleanupPolicyError", {
    readonly code: Schema.Literals<readonly ["kill_signal_unsupported", "grace_out_of_range"]>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A cleanup policy outside what a native timer and the platform allow.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class ProcessCleanupPolicyError extends ProcessCleanupPolicyError_base {
    readonly name = "ProcessCleanupPolicyError";
}
export {};
