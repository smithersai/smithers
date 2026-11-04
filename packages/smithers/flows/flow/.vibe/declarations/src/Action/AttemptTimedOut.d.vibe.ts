/**
 * Defines the defect an action attempt settles with when it outlives its
 * declared `attemptTimeoutMs` or misses its `heartbeatTimeoutMs`.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
declare const AttemptTimedOut_base: Schema.Class<AttemptTimedOut, Schema.TaggedStruct<"@smthrs/flow/AttemptTimedOut", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"attempt_timed_out">>;
    readonly actionName: Schema.String;
    readonly attempt: Schema.Number;
    /** Which bound expired: the whole attempt, or the gap between heartbeats. */
    readonly bound: Schema.Literals<readonly ["attempt", "heartbeat"]>;
    readonly timeoutMs: Schema.Number;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * One attempt of an action ran past a declared time bound and was
 * interrupted.
 *
 * It is a defect rather than a typed failure because the bound belongs to the
 * dispatch, not to the action's declared error channel. The engine's retry
 * decision point still counts it as a retryable attempt failure under the
 * action's `retryPolicy`, and a policy can refuse it by listing this tag in
 * `nonRetryable`.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class AttemptTimedOut extends AttemptTimedOut_base {
}
export {};
