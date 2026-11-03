/** Observational health contracts shared by durable runs and native sessions.
 * @since 1.0.0
 */
import type * as Evaluator from "@smthrs/model/Evaluator";
import { Cause, Effect, Schema } from "effect";
import type { ControlEvent, RunSummary } from "../../../src/ControlSchema.ts";
/** Authoritative subject lifecycle.
 * @category schemas
 * @since 1.0.0
 */
export declare const SubjectState: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
/** Authoritative subject lifecycle.
 * @category models
 * @since 1.0.0
 */
export type SubjectState = typeof SubjectState.Type;
/** Health vocabulary shared with Monitor.
 * @category schemas
 * @since 1.0.0
 */
export declare const HealthState: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
/** Derived subject health.
 * @category models
 * @since 1.0.0
 */
export type HealthState = typeof HealthState.Type;
/** Only explicit semantic checks establish activity.
 * @category schemas
 * @since 1.0.0
 */
export declare const Activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
/** Semantic activity.
 * @category models
 * @since 1.0.0
 */
export type Activity = typeof Activity.Type;
/** Attention never confers permission to act. `needs-resume` is a run parked over
 * executions its owner released: nothing restarts them until `smthrs runs resume`.
 * @category schemas
 * @since 1.0.0
 */
export declare const Attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
/** Human attention.
 * @category models
 * @since 1.0.0
 */
export type Attention = typeof Attention.Type;
/** Whether a successful reading still describes this subject.
 * @category schemas
 * @since 1.0.0
 */
export declare const Freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
/** Reading freshness.
 * @category models
 * @since 1.0.0
 */
export type Freshness = typeof Freshness.Type;
/** Public reasons; arbitrary exception text and terminal bytes never cross this boundary.
 * @category schemas
 * @since 1.0.0
 */
export declare const ReasonCode: Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>;
/** Public reason code.
 * @category models
 * @since 1.0.0
 */
export type ReasonCode = typeof ReasonCode.Type;
/** Validated checker output, containing no authority or ordering fields.
 * @category schemas
 * @since 1.0.0
 */
export declare const ProbeReport: Schema.Struct<{
    readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
    readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
}>;
/** Validated checker output.
 * @category models
 * @since 1.0.0
 */
export type ProbeReport = typeof ProbeReport.Type;
/** A host-stamped observation; its journal sequence is supplied by the durable writer.
 * @category schemas
 * @since 1.0.0
 */
export declare const HealthObservation: Schema.Struct<{
    readonly subjectId: Schema.String;
    readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
    readonly checkerId: Schema.String;
    readonly monitorId: Schema.String;
    readonly incarnation: Schema.String;
    readonly evidenceSeq: Schema.Int;
    readonly observedAt: Schema.Int;
    readonly expiresAt: Schema.Int;
    readonly durationMs: Schema.Int;
    readonly baseHealth: Schema.optional<Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>>;
    readonly outcome: Schema.Literals<readonly ["ok", "timeout", "error", "interrupted", "discarded"]>;
    readonly report: Schema.optional<Schema.Struct<{
        readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
        readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
    }>>;
    readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
}>;
/** A host-stamped observation.
 * @category models
 * @since 1.0.0
 */
export type HealthObservation = typeof HealthObservation.Type;
/** One observation with its authoritative publication order.
 * @category models
 * @since 1.0.0
 */
export interface RecordedObservation {
    readonly observation: HealthObservation;
    readonly sequence: number;
}
/** The additive wire contract rendered by every status surface.
 * @category schemas
 * @since 1.0.0
 */
export declare const StatusRollup: Schema.Struct<{
    readonly subjectId: Schema.String;
    readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
    readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
    readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
    readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
    readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
    readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
    readonly provenance: Schema.optional<Schema.Struct<{
        readonly checkerId: Schema.String;
        readonly monitorId: Schema.String;
        readonly observedAt: Schema.Int;
        readonly expiresAt: Schema.Int;
        readonly evidenceSeq: Schema.Int;
        readonly incarnation: Schema.String;
        readonly version: Schema.Int;
    }>>;
    readonly updatedAt: Schema.Int;
}>;
/** The additive wire contract.
 * @category models
 * @since 1.0.0
 */
export type StatusRollup = typeof StatusRollup.Type;
/** Durable event type for observational health.
 * @category constants
 * @since 1.0.0
 */
export declare const statusObservedEventType = "control.status.observed";
/** Opaque identity of the authoritative run ownership and lifecycle point being observed.
 * Equality is meaningful; lexical or numeric ordering is not.
 * @category getters
 * @since 1.0.0
 */
export declare const runIncarnation: (run: RunSummary) => string;
/** Read-only evidence, deliberately excluding mutation ports and terminal text by default.
 * Checkers are trusted host TypeScript, not a sandbox: captured ambient authority remains their author's responsibility.
 * @category models
 * @since 1.0.0
 */
export interface ProbeContext {
    readonly subjectId: string;
    readonly state: SubjectState;
    readonly events: ReadonlyArray<ControlEvent>;
    readonly summary?: RunSummary | undefined;
    readonly session?: {
        readonly alive: boolean;
        readonly exitCode: number | null;
        readonly outputCursor: number;
        readonly outputTail?: string | undefined;
    } | undefined;
    readonly sinceCursor: number;
}
/** Bounded polling, expiry and failure backoff.
 * @category models
 * @since 1.0.0
 */
export interface CheckPolicy {
    readonly intervalMs: number;
    readonly timeoutMs: number;
    readonly ttlMs: number;
    /** Grace for silent work before the flow host considers missing progress unhealthy. */
    readonly stallAfterMs: number;
    readonly backoff: {
        readonly initialMs: number;
        readonly maxMs: number;
        readonly factor: number;
    };
}
/** Trusted host checker; supply service requirements around its Effect before registration.
 * @category models
 * @since 1.0.0
 */
export interface HealthChecker<C = unknown> {
    readonly id: string;
    readonly configSchema?: Schema.Codec<C, unknown> | undefined;
    readonly defaults?: Partial<CheckPolicy> | undefined;
    readonly probe: (context: ProbeContext, config: C) => Effect.Effect<ProbeReport, unknown>;
}
/** Data may select a registered checker but never executable code.
 * @category models
 * @since 1.0.0
 */
export interface HealthBinding {
    readonly checkerId: string;
    readonly config?: unknown;
    readonly policy?: Partial<CheckPolicy> | undefined;
    readonly exposeOutput?: boolean | undefined;
}
/** Trusted host health configuration.
 * @category models
 * @since 1.0.0
 */
export interface HealthConfig {
    readonly checkers?: ReadonlyArray<HealthChecker<any>> | undefined;
    readonly bindings?: Readonly<Record<string, HealthBinding>> | undefined;
    readonly limits?: {
        readonly maxSubjects?: number;
        readonly maxConcurrentProbes?: number;
    } | undefined;
}
/** Fully admitted checker binding.
 * @category models
 * @since 1.0.0
 */
export interface ResolvedCheck {
    readonly checker: HealthChecker<any>;
    readonly config: unknown;
    readonly policy: CheckPolicy;
    readonly exposeOutput: boolean;
}
/** Host registry, built once before admitting subjects.
 * @category models
 * @since 1.0.0
 */
export interface Registry {
    readonly resolve: (key: string) => ResolvedCheck;
    readonly limits: {
        readonly maxSubjects: number;
        readonly maxConcurrentProbes: number;
    };
}
declare const HealthConfigurationError_base: Schema.Class<HealthConfigurationError, Schema.TaggedStruct<"HealthConfigurationError", {
    readonly reason: Schema.Literals<readonly ["invalid-policy", "invalid-checker", "invalid-config"]>;
}>, Cause.YieldableError>;
/** Invalid trusted configuration fails startup instead of silently running another policy.
 * @category errors
 * @since 1.0.0
 */
export declare class HealthConfigurationError extends HealthConfigurationError_base {
}
/** Safe cadence used by unconfigured hosts.
 * @category constants
 * @since 1.0.0
 */
export declare const defaultPolicy: CheckPolicy;
/** A known engine wait is a lifecycle fact, not missing progress.
 * @category getters
 * @since 1.0.0
 */
export declare const waitReason: (state: SubjectState, waitingReason?: string) => ReasonCode | undefined;
/** Flow default observes lifecycle without inventing semantic activity.
 * @category constants
 * @since 1.0.0
 */
export declare const lifecycleRunChecker: HealthChecker;
/** Session default never interprets silence or output movement as task activity.
 * @category constants
 * @since 1.0.0
 */
export declare const lifecycleSessionChecker: HealthChecker;
/** Checkers every host may bind by id, beyond the lifecycle default it always has.
 *
 * Registration is not a binding. A host opts in by naming one of these as a
 * `HealthBinding.checkerId`; a host that names none keeps the lifecycle
 * default, and no entry here is ever consulted for an unbound subject.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const registeredCheckers: ReadonlyArray<HealthChecker<any>>;
/** Admit a host registry and all configured bindings. Unknown checker ids use the lifecycle default.
 * @category constructors
 * @since 1.0.0
 */
export declare const makeRegistry: (config?: HealthConfig, kind?: "run" | "session", evaluator?: Evaluator.Evaluator) => Registry;
/** Failure delay, bounded even when a subject has failed for a long time.
 * @category getters
 * @since 1.0.0
 */
export declare const nextDelay: (policy: CheckPolicy, consecutiveFailures: number) => number;
/** Host-only ordering stamp captured before a probe.
 * @category models
 * @since 1.0.0
 */
export interface ObservationStamp {
    readonly monitorId: string;
    readonly incarnation: string;
    readonly evidenceSeq: number;
}
/** Evaluate one trusted checker with bounded timeout and safe failure values. Scope interruption propagates.
 * The host must still compare current ownership/lifecycle before durably publishing the returned observation.
 * @category constructors
 * @since 1.0.0
 */
export declare const evaluate: (check: ResolvedCheck, context: ProbeContext, stamp: ObservationStamp) => Effect.Effect<HealthObservation>;
/** Select evidence for the current opaque owner incarnation, breaking equal evidence ties by durable sequence.
 * @category projections
 * @since 1.0.0
 */
export declare const latestObservation: (candidates: ReadonlyArray<RecordedObservation>, subjectId: string, incarnation: string) => RecordedObservation | undefined;
/** Authoritative facts supplied independently of checker output.
 * @category models
 * @since 1.0.0
 */
export interface RollupInput {
    readonly subjectId: string;
    readonly state: SubjectState;
    readonly incarnation: string;
    readonly waitingReason?: string | undefined;
    readonly exitCode?: number | null | undefined;
    readonly baseHealth?: HealthState | undefined;
    readonly latest?: RecordedObservation | undefined;
    readonly evidenceSeq?: number | undefined;
    readonly now: number;
    readonly updatedAt: number;
}
/** Pure precedence: lifecycle and approvals win, and stale probes never establish activity.
 * @category projections
 * @since 1.0.0
 */
export declare const rollup: (input: RollupInput) => StatusRollup;
export {};
