/**
 * Stable, schema-backed control-plane failures.
 *
 * @since 0.1.0
 */
import { NotificationError } from "@smthrs/notifications/NotificationQueue";
import { Schema } from "effect";
declare const RunNotFound_base: Schema.Class<RunNotFound, Schema.TaggedStruct<"/control/RunNotFound", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"run_not_found">>;
    readonly runId: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * No run with this id exists.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class RunNotFound extends RunNotFound_base {
    /**
     * The sentence an operator reads. Without one the CLI printed the bare
     * fields, `run_not_found runId=nope`, which names no next action.
     */
    get message(): string;
}
declare const PlanNotFound_base: Schema.Class<PlanNotFound, Schema.TaggedStruct<"/control/PlanNotFound", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"plan_not_found">>;
    readonly planId: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * No plan with this id exists.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class PlanNotFound extends PlanNotFound_base {
    /**
     * The sentence an operator reads. Every renderer in the tree prints
     * `message`, so a refusal without one does not explain the next action.
     */
    get message(): string;
}
declare const PlanDenied_base: Schema.Class<PlanDenied, Schema.TaggedStruct<"/control/PlanDenied", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"plan_denied">>;
    readonly planId: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * The plan was denied and cannot be launched.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class PlanDenied extends PlanDenied_base {
    /**
     * The sentence an operator reads. Every renderer in the tree prints
     * `message`, so a denial must state how to make a later launch possible.
     */
    get message(): string;
}
declare const FlowNotFound_base: Schema.Class<FlowNotFound, Schema.TaggedStruct<"/control/FlowNotFound", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"flow_not_found">>;
    readonly flowId: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * No flow with this id is registered.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class FlowNotFound extends FlowNotFound_base {
    /**
     * The sentence an operator reads, which names the command that lists the
     * flows a caller can start.
     */
    get message(): string;
}
declare const PlanDigestMismatch_base: Schema.Class<PlanDigestMismatch, Schema.TaggedStruct<"/control/PlanDigestMismatch", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"plan_digest_mismatch">>;
    readonly planId: Schema.String;
    readonly expected: Schema.String;
    readonly actual: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * The submitted plan does not hash to the digest the caller declared, so
 * the control plane refuses to store it.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class PlanDigestMismatch extends PlanDigestMismatch_base {
}
declare const EnvelopeMismatch_base: Schema.Class<EnvelopeMismatch, Schema.TaggedStruct<"/control/EnvelopeMismatch", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"envelope_mismatch">>;
    readonly planId: Schema.String;
    readonly expected: Schema.String;
    readonly actual: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * The plan's effect envelope differs from the one the caller declared.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class EnvelopeMismatch extends EnvelopeMismatch_base {
}
declare const ClaimLost_base: Schema.Class<ClaimLost, Schema.TaggedStruct<"/control/ClaimLost", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"claim_lost">>;
    readonly runId: Schema.String;
    readonly reason: Schema.optional<Schema.String>;
    readonly parkedBy: Schema.optional<Schema.Struct<{
        readonly hostId: Schema.String;
        readonly pid: Schema.Number;
    }>>;
}>, import("effect/Cause").YieldableError>;
/**
 * The caller's claim on this run lapsed or was fenced by a newer owner.
 *
 * `parkedBy` names the live process that parked the run: it, not the caller,
 * drives the run, so `Control.resume` hands the resume to it.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class ClaimLost extends ClaimLost_base {
}
declare const CodeDrift_base: Schema.Class<CodeDrift, Schema.TaggedStruct<"/control/CodeDrift", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"code_drift">>;
    readonly runId: Schema.String;
    readonly flowId: Schema.String;
    /** The execution digest the run started with; absent when only the engine changed. */
    readonly recorded: Schema.optional<Schema.String>;
    /** The flow's execution digest now; absent when the flow is gone or declares none. */
    readonly current: Schema.optional<Schema.String>;
    /** The engine version the run started on, when the engine changed. */
    readonly recordedEngine: Schema.optional<Schema.String>;
    /** The engine version resuming it, when the engine changed. */
    readonly currentEngine: Schema.optional<Schema.String>;
}>, import("effect/Cause").YieldableError>;
/**
 * The run's flow or engine changed since the run started, so resuming it would
 * run code the run did not start with. Pass `allowCodeDrift` to resume it
 * anyway; the run then records the code it resumed on.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class CodeDrift extends CodeDrift_base {
    get message(): string;
}
declare const AlreadyResolved_base: Schema.Class<AlreadyResolved, Schema.TaggedStruct<"/control/AlreadyResolved", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"already_resolved">>;
    readonly requestId: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * This request was already answered; a second answer is refused rather
 * than overwriting the first.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class AlreadyResolved extends AlreadyResolved_base {
}
declare const InvalidInput_base: Schema.Class<InvalidInput, Schema.TaggedStruct<"/control/InvalidInput", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"invalid_input">>;
    readonly issue: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * The request did not satisfy its schema or a stated precondition.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class InvalidInput extends InvalidInput_base {
}
declare const Unauthorized_base: Schema.Class<Unauthorized, Schema.TaggedStruct<"/control/Unauthorized", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"unauthorized">>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * The caller lacks a usable credential or authority for this operation.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class Unauthorized extends Unauthorized_base {
}
declare const Unavailable_base: Schema.Class<Unavailable, Schema.TaggedStruct<"/control/Unavailable", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"unavailable">>;
    readonly feature: Schema.String;
    readonly ticket: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * The operation is not implemented in this deployment. `ticket` names the
 * issue that tracks it, per `Concepts/Tickets Not Exceptions.md`.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class Unavailable extends Unavailable_base {
}
declare const TransportError_base: Schema.Class<TransportError, Schema.TaggedStruct<"/control/TransportError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"transport_error">>;
    readonly message: Schema.String;
    readonly retryable: Schema.Boolean;
    readonly cause: Schema.optional<Schema.Defect>;
}>, import("effect/Cause").YieldableError>;
/**
 * The request failed before a declared control response reached the caller.
 *
 * `retryable` classifies only the transport phase. Connection failures and
 * HTTP 5xx responses are retryable; local encode failures, response decode
 * failures, and HTTP 4xx responses are not. A caller may resend a retryable
 * mutation only when its idempotency key makes replay safe. A keyless request
 * can have reached the server even when its response was lost.
 *
 * `message` is a fixed operator-facing sentence. `cause` retains the original
 * client failure for diagnostics without copying its raw text into output.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class TransportError extends TransportError_base {
}
declare const PersistenceError_base: Schema.Class<PersistenceError, Schema.TaggedStruct<"/control/PersistenceError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"persistence_failed">>;
    readonly operation: Schema.String;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Defect>;
}>, import("effect/Cause").YieldableError>;
/**
 * A control-plane store operation failed.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class PersistenceError extends PersistenceError_base {
}
declare const LaunchFailed_base: Schema.Class<LaunchFailed, Schema.TaggedStruct<"/control/LaunchFailed", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"launch_failed">>;
    readonly runId: Schema.String;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Defect>;
}>, import("effect/Cause").YieldableError>;
/**
 * The executor refused or could not start the run.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class LaunchFailed extends LaunchFailed_base {
}
declare const NoMatchingWait_base: Schema.Class<NoMatchingWait, Schema.TaggedStruct<"/control/NoMatchingWait", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"no_matching_wait">>;
    readonly runId: Schema.String;
    readonly waitName: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A signal named a wait point the run does not have open.
 *
 * `Control.signal` completes the `WaitFor` deferred a run is parked on. A
 * signal whose name matches no open wait point completes nothing, and recording
 * it anyway would leave an operator watching a delivery that never lands, so it
 * is refused where it arrives.
 *
 * The signal's name is `waitName`, not `name`. A field spelled `name` on an
 * `Error` subclass shadows `Error.prototype.name`, which every renderer in the
 * tree reads: `smithers signal run-3 '{"name":"go"}'` against a timer-parked
 * run printed `go: ` to stderr and exited 1, because `bin.ts` reports
 * `${error.name}: ${error.message}` and this class had overwritten one and
 * defined neither (release validation, defect D3).
 *
 * @category errors
 * @since 0.1.0
 */
export declare class NoMatchingWait extends NoMatchingWait_base {
    /**
     * The sentence an operator reads. Every other renderer in the tree prints
     * `message`, so a refusal with none is a refusal with no reason.
     */
    get message(): string;
}
declare const CredentialConflict_base: Schema.Class<CredentialConflict, Schema.TaggedStruct<"/control/CredentialConflict", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"credential_conflict">>;
    readonly id: Schema.String;
    readonly expectedVersion: Schema.Number;
    readonly actualVersion: Schema.Number;
}>, import("effect/Cause").YieldableError>;
/**
 * A credential write lost a race: the record moved on before this writer
 * committed, so the update is refused rather than silently overwriting the
 * winner.
 *
 * @since 0.1.0
 * @category errors
 */
export declare class CredentialConflict extends CredentialConflict_base {
}
/**
 * Every stable failure emitted by the control plane, as one schema.
 *
 * This is the single membership list. The exported union type is derived from
 * it and `ControlClient.isControlError` is `Schema.is` of it, so an error class
 * added here reaches both. Two hand-maintained lists drifted: `ControlError`
 * omitted `CredentialConflict` while the README documented it as a member, and
 * `isControlError` repeated the same thirteen names a second time.
 *
 * @since 0.1.0
 * @category errors
 */
export declare const ControlErrorSchema: Schema.Union<readonly [typeof RunNotFound, typeof PlanNotFound, typeof PlanDenied, typeof FlowNotFound, typeof PlanDigestMismatch, typeof EnvelopeMismatch, typeof ClaimLost, typeof CodeDrift, typeof AlreadyResolved, typeof InvalidInput, typeof Unauthorized, typeof Unavailable, typeof TransportError, typeof PersistenceError, typeof LaunchFailed, typeof NoMatchingWait, typeof CredentialConflict, typeof NotificationError]>;
/**
 * Every stable failure emitted by the control plane.
 *
 * @since 0.1.0
 * @category errors
 */
export type ControlError = typeof ControlErrorSchema.Type;
export {};
