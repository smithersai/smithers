/**
 * Versioned control lifecycle facts and their shared read projection.
 * @since 1.0.0
 */
import { Journal } from "@smthrs/journal";
import { Effect, Schema } from "effect";
import type * as ControlRuntime from "../../../src/ControlRuntime.ts";
import * as ControlSchema from "../../../src/ControlSchema.ts";
/** This is the control producer contract, independent of the harness journal format.
 * @category facts
 * @since 1.0.0
 */
export declare const version = 1;
/** A committed control snapshot. A baseline claims no history before its sequence.
 * @category facts
 * @since 1.0.0
 */
export declare const RunFact: Schema.Struct<{
    readonly factVersion: Schema.Literal<1>;
    readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
    readonly run: Schema.Struct<{
        readonly executionObservation: Schema.optional<Schema.Literals<readonly ["observed", "missing"]>>;
        readonly executionView: Schema.optional<Schema.Struct<{
            readonly root: Schema.Struct<{
                readonly executionId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
                readonly flowName: Schema.NonEmptyString;
                readonly status: Schema.Literals<readonly ["pending", "running", "suspended", "completed", "failed", "cancelled"]>;
                readonly createdAtMs: Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">;
                readonly startedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
                readonly finishedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
                readonly parentRunId: Schema.NullOr<Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">>;
                readonly lineageId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
                readonly roundOrdinal: Schema.Int;
                readonly cancelRequestedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
                readonly treeVersion: Schema.optional<Schema.Literal<1>>;
                readonly parentPolicy: Schema.optional<Schema.Literals<readonly ["cancel", "detach"]>>;
                readonly waiting: Schema.NullOr<Schema.Struct<{
                    readonly reason: Schema.NonEmptyString;
                    readonly wakeAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
                    readonly tokenDigest: Schema.NullOr<Schema.NonEmptyString>;
                    readonly point: Schema.optional<Schema.NullOr<Schema.String>>;
                    readonly request: Schema.optional<Schema.NullOr<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
                }>>;
            }>;
            readonly current: Schema.Struct<{
                readonly executionId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
                readonly flowName: Schema.NonEmptyString;
                readonly status: Schema.Literals<readonly ["pending", "running", "suspended", "completed", "failed", "cancelled"]>;
                readonly createdAtMs: Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">;
                readonly startedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
                readonly finishedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
                readonly parentRunId: Schema.NullOr<Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">>;
                readonly lineageId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
                readonly roundOrdinal: Schema.Int;
                readonly cancelRequestedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
                readonly treeVersion: Schema.optional<Schema.Literal<1>>;
                readonly parentPolicy: Schema.optional<Schema.Literals<readonly ["cancel", "detach"]>>;
                readonly waiting: Schema.NullOr<Schema.Struct<{
                    readonly reason: Schema.NonEmptyString;
                    readonly wakeAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
                    readonly tokenDigest: Schema.NullOr<Schema.NonEmptyString>;
                    readonly point: Schema.optional<Schema.NullOr<Schema.String>>;
                    readonly request: Schema.optional<Schema.NullOr<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
                }>>;
            }>;
            readonly humanWaits: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly executionId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
                readonly flowName: Schema.NonEmptyString;
                readonly status: Schema.Literals<readonly ["pending", "running", "suspended", "completed", "failed", "cancelled"]>;
                readonly createdAtMs: Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">;
                readonly startedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
                readonly finishedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
                readonly parentRunId: Schema.NullOr<Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">>;
                readonly lineageId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
                readonly roundOrdinal: Schema.Int;
                readonly cancelRequestedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
                readonly treeVersion: Schema.optional<Schema.Literal<1>>;
                readonly parentPolicy: Schema.optional<Schema.Literals<readonly ["cancel", "detach"]>>;
                readonly waiting: Schema.NullOr<Schema.Struct<{
                    readonly reason: Schema.NonEmptyString;
                    readonly wakeAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
                    readonly tokenDigest: Schema.NullOr<Schema.NonEmptyString>;
                    readonly point: Schema.optional<Schema.NullOr<Schema.String>>;
                    readonly request: Schema.optional<Schema.NullOr<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
                }>>;
            }>>>;
        }>>;
        readonly runId: Schema.String;
        readonly flowId: Schema.String;
        readonly recordedStatus: Schema.optional<Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>>;
        readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
        readonly planId: Schema.optional<Schema.String>;
        readonly planDigest: Schema.optional<Schema.String>;
        readonly executionDigest: Schema.optional<Schema.String>;
        readonly engineVersion: Schema.optional<Schema.String>;
        readonly codeDrift: Schema.optional<Schema.Struct<{
            readonly recorded: Schema.optional<Schema.String>;
            readonly current: Schema.optional<Schema.String>;
            readonly recordedEngine: Schema.optional<Schema.String>;
            readonly currentEngine: Schema.optional<Schema.String>;
        }>>;
        readonly ownerId: Schema.optional<Schema.String>;
        readonly launchedBy: Schema.optional<Schema.Struct<{
            readonly id: Schema.String;
            readonly kind: Schema.String;
        }>>;
        readonly parentRunId: Schema.optional<Schema.String>;
        readonly lineageId: Schema.optional<Schema.String>;
        readonly roundOrdinal: Schema.optional<Schema.Number>;
        readonly origin: Schema.optional<Schema.Literals<readonly ["child", "fork", "continuation"]>>;
        readonly waitingReason: Schema.optional<Schema.String>;
        readonly steering: Schema.optional<Schema.Struct<{
            readonly pending: Schema.Number;
        }>>;
        readonly pendingResume: Schema.optional<Schema.Number>;
        readonly parkedBy: Schema.optional<Schema.String>;
        readonly cancellation: Schema.optional<Schema.Struct<{
            readonly requestedAt: Schema.Number;
            readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
            readonly principal: Schema.optional<Schema.Struct<{
                readonly id: Schema.String;
                readonly kind: Schema.String;
                readonly stampedAt: Schema.Number;
            }>>;
            readonly reason: Schema.optional<Schema.String>;
            readonly cascadedFrom: Schema.optional<Schema.String>;
        }>>;
        readonly pendingWaits: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly runId: Schema.String;
            readonly flowId: Schema.optional<Schema.String>;
            readonly reason: Schema.String;
            readonly token: Schema.String;
            readonly tokenDigest: Schema.optional<Schema.String>;
            readonly name: Schema.optional<Schema.String>;
            readonly attempt: Schema.optional<Schema.Number>;
            readonly request: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
            readonly createdAt: Schema.Number;
        }>>>;
        readonly deadlineAt: Schema.optional<Schema.Number>;
        readonly createdAt: Schema.Number;
        readonly updatedAt: Schema.Number;
    }>;
}>;
/** Capture the exact result of a fenced write, inside its journal transaction.
 * @category facts
 * @since 1.0.0
 */
export declare const runFact: (run: ControlSchema.RunSummary, baseline?: "created" | "legacy") => typeof RunFact.Type;
/** The exact facts of the guard that parked a run, frozen when it tripped.
 *
 * `Runaway` is a run spending past an approved ceiling (`tokens`, `usd`,
 * `latency`). `Stuck` is one operation that ran past its time limit
 * (`model-call`, `tool-call`, `cell`). Every number is in the source's unit,
 * tokens, dollars, or milliseconds: `used`, `reserved`, `max`, and `next` are
 * a budget's spend, held forecast, ceiling, and refused call; `max` is a
 * timeout's limit.
 * `allowance` is what Continue authorizes: the raised ceiling for a budget,
 * one more run of `max` for a timeout. `subject` names the operation a
 * timeout interrupted.
 * @category facts
 * @since 1.0.0
 */
export declare const GuardIncident: Schema.Struct<{
    readonly classification: Schema.Literals<readonly ["Runaway", "Stuck"]>;
    readonly source: Schema.Literals<readonly ["tokens", "usd", "latency", "model-call", "tool-call", "cell"]>;
    readonly message: Schema.String;
    readonly used: Schema.optional<Schema.Number>;
    readonly reserved: Schema.optional<Schema.Number>;
    readonly max: Schema.optional<Schema.Number>;
    readonly next: Schema.optional<Schema.Number>;
    readonly allowance: Schema.optional<Schema.Number>;
    readonly subject: Schema.optional<Schema.String>;
}>;
/** The identity-bearing request admitted with its approval token.
 *
 * `incident` is present on a request a guard made, so a restarted host reads
 * the facts the park was made on rather than measuring them again.
 * @category facts
 * @since 1.0.0
 */
export declare const ApprovalRequestFact: Schema.Struct<{
    readonly factVersion: Schema.Literal<1>;
    readonly runId: Schema.String;
    readonly requestId: Schema.String;
    readonly question: Schema.String;
    readonly payload: Schema.Struct<{
        readonly target: Schema.Union<readonly [Schema.TaggedStruct<"Plan", {
            readonly planId: Schema.String;
            readonly digest: Schema.String;
            readonly envelope: Schema.Struct<{
                readonly capabilities: Schema.$Array<Schema.String>;
                readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                readonly flows: Schema.$Array<Schema.String>;
                readonly budget: Schema.Struct<{
                    readonly tokens: Schema.optional<Schema.Number>;
                    readonly milliseconds: Schema.optional<Schema.Number>;
                    readonly usd: Schema.optional<Schema.Number>;
                    readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                    readonly deadline: Schema.optional<Schema.Int>;
                }>;
                readonly host: Schema.optional<Schema.String>;
            }>;
        }>, Schema.TaggedStruct<"Node", {
            readonly runId: Schema.String;
            readonly requestId: Schema.String;
            readonly digest: Schema.String;
            readonly envelope: Schema.Struct<{
                readonly capabilities: Schema.$Array<Schema.String>;
                readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                readonly flows: Schema.$Array<Schema.String>;
                readonly budget: Schema.Struct<{
                    readonly tokens: Schema.optional<Schema.Number>;
                    readonly milliseconds: Schema.optional<Schema.Number>;
                    readonly usd: Schema.optional<Schema.Number>;
                    readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                    readonly deadline: Schema.optional<Schema.Int>;
                }>;
                readonly host: Schema.optional<Schema.String>;
            }>;
        }>]>;
        readonly scope: Schema.Literals<readonly ["once", "run", "remembered"]>;
        readonly idempotencyKey: Schema.String;
    }>;
    readonly incident: Schema.optional<Schema.Struct<{
        readonly classification: Schema.Literals<readonly ["Runaway", "Stuck"]>;
        readonly source: Schema.Literals<readonly ["tokens", "usd", "latency", "model-call", "tool-call", "cell"]>;
        readonly message: Schema.String;
        readonly used: Schema.optional<Schema.Number>;
        readonly reserved: Schema.optional<Schema.Number>;
        readonly max: Schema.optional<Schema.Number>;
        readonly next: Schema.optional<Schema.Number>;
        readonly allowance: Schema.optional<Schema.Number>;
        readonly subject: Schema.optional<Schema.String>;
    }>>;
}>;
/** The exact target a committed decision resolves; old target-tag fields remain readable.
 * @category facts
 * @since 1.0.0
 */
export declare const ApprovalDecisionFact: Schema.Struct<{
    readonly factVersion: Schema.Literal<1>;
    readonly tokenId: Schema.String;
    readonly approvalTarget: Schema.Union<readonly [Schema.TaggedStruct<"Plan", {
        readonly planId: Schema.String;
        readonly digest: Schema.String;
        readonly envelope: Schema.Struct<{
            readonly capabilities: Schema.$Array<Schema.String>;
            readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
            readonly flows: Schema.$Array<Schema.String>;
            readonly budget: Schema.Struct<{
                readonly tokens: Schema.optional<Schema.Number>;
                readonly milliseconds: Schema.optional<Schema.Number>;
                readonly usd: Schema.optional<Schema.Number>;
                readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                readonly deadline: Schema.optional<Schema.Int>;
            }>;
            readonly host: Schema.optional<Schema.String>;
        }>;
    }>, Schema.TaggedStruct<"Node", {
        readonly runId: Schema.String;
        readonly requestId: Schema.String;
        readonly digest: Schema.String;
        readonly envelope: Schema.Struct<{
            readonly capabilities: Schema.$Array<Schema.String>;
            readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
            readonly flows: Schema.$Array<Schema.String>;
            readonly budget: Schema.Struct<{
                readonly tokens: Schema.optional<Schema.Number>;
                readonly milliseconds: Schema.optional<Schema.Number>;
                readonly usd: Schema.optional<Schema.Number>;
                readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                readonly deadline: Schema.optional<Schema.Int>;
            }>;
            readonly host: Schema.optional<Schema.String>;
        }>;
    }>]>;
}>;
/** Capture and validate the target the decision writer has actually resolved.
 * @category facts
 * @since 1.0.0
 */
export declare const approvalDecisionFact: (tokenId: string, approvalTarget: ControlSchema.ApprovalTarget) => typeof ApprovalDecisionFact.Type;
/** Commit a fenced control write and the exact resulting lifecycle fact together.
 * @category facts
 * @since 1.0.0
 */
export declare const commitRun: <E, R>(journal: Journal.Service, change: Effect.Effect<ControlSchema.RunSummary, E, R>, sourceId: string, eventType: string, detail?: Readonly<Record<string, unknown>>, baseline?: "created" | "legacy") => Effect.Effect<{
    readonly executionObservation?: "missing" | "observed" | undefined;
    readonly executionView?: {
        readonly root: {
            readonly executionId: string & import("effect/Brand").Brand<"@smthrs/journal/JournalEvent/RunId">;
            readonly flowName: string;
            readonly status: "cancelled" | "completed" | "failed" | "pending" | "running" | "suspended";
            readonly createdAtMs: number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">;
            readonly startedAtMs: (number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">) | null;
            readonly finishedAtMs: (number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">) | null;
            readonly parentRunId: (string & import("effect/Brand").Brand<"@smthrs/journal/JournalEvent/RunId">) | null;
            readonly lineageId: string & import("effect/Brand").Brand<"@smthrs/journal/JournalEvent/RunId">;
            readonly roundOrdinal: number;
            readonly cancelRequestedAtMs: (number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">) | null;
            readonly treeVersion?: 1 | undefined;
            readonly parentPolicy?: "cancel" | "detach" | undefined;
            readonly waiting: {
                readonly reason: string;
                readonly wakeAtMs: (number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">) | null;
                readonly tokenDigest: string | null;
                readonly point?: string | null | undefined;
                readonly request?: Schema.Json | undefined;
            } | null;
        };
        readonly current: {
            readonly executionId: string & import("effect/Brand").Brand<"@smthrs/journal/JournalEvent/RunId">;
            readonly flowName: string;
            readonly status: "cancelled" | "completed" | "failed" | "pending" | "running" | "suspended";
            readonly createdAtMs: number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">;
            readonly startedAtMs: (number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">) | null;
            readonly finishedAtMs: (number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">) | null;
            readonly parentRunId: (string & import("effect/Brand").Brand<"@smthrs/journal/JournalEvent/RunId">) | null;
            readonly lineageId: string & import("effect/Brand").Brand<"@smthrs/journal/JournalEvent/RunId">;
            readonly roundOrdinal: number;
            readonly cancelRequestedAtMs: (number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">) | null;
            readonly treeVersion?: 1 | undefined;
            readonly parentPolicy?: "cancel" | "detach" | undefined;
            readonly waiting: {
                readonly reason: string;
                readonly wakeAtMs: (number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">) | null;
                readonly tokenDigest: string | null;
                readonly point?: string | null | undefined;
                readonly request?: Schema.Json | undefined;
            } | null;
        };
        readonly humanWaits?: readonly {
            readonly executionId: string & import("effect/Brand").Brand<"@smthrs/journal/JournalEvent/RunId">;
            readonly flowName: string;
            readonly status: "cancelled" | "completed" | "failed" | "pending" | "running" | "suspended";
            readonly createdAtMs: number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">;
            readonly startedAtMs: (number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">) | null;
            readonly finishedAtMs: (number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">) | null;
            readonly parentRunId: (string & import("effect/Brand").Brand<"@smthrs/journal/JournalEvent/RunId">) | null;
            readonly lineageId: string & import("effect/Brand").Brand<"@smthrs/journal/JournalEvent/RunId">;
            readonly roundOrdinal: number;
            readonly cancelRequestedAtMs: (number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">) | null;
            readonly treeVersion?: 1 | undefined;
            readonly parentPolicy?: "cancel" | "detach" | undefined;
            readonly waiting: {
                readonly reason: string;
                readonly wakeAtMs: (number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">) | null;
                readonly tokenDigest: string | null;
                readonly point?: string | null | undefined;
                readonly request?: Schema.Json | undefined;
            } | null;
        }[] | undefined;
    } | undefined;
    readonly runId: string;
    readonly flowId: string;
    readonly recordedStatus?: "accepted" | "cancelled" | "completed" | "failed" | "parked" | "running" | "waiting-approval" | undefined;
    readonly status: "accepted" | "cancelled" | "completed" | "failed" | "parked" | "running" | "waiting-approval";
    readonly planId?: string | undefined;
    readonly planDigest?: string | undefined;
    readonly executionDigest?: string | undefined;
    readonly engineVersion?: string | undefined;
    readonly codeDrift?: {
        readonly recorded?: string | undefined;
        readonly current?: string | undefined;
        readonly recordedEngine?: string | undefined;
        readonly currentEngine?: string | undefined;
    } | undefined;
    readonly ownerId?: string | undefined;
    readonly launchedBy?: {
        readonly id: string;
        readonly kind: string;
    } | undefined;
    readonly parentRunId?: string | undefined;
    readonly lineageId?: string | undefined;
    readonly roundOrdinal?: number | undefined;
    readonly origin?: "child" | "continuation" | "fork" | undefined;
    readonly waitingReason?: string | undefined;
    readonly steering?: {
        readonly pending: number;
    } | undefined;
    readonly pendingResume?: number | undefined;
    readonly parkedBy?: string | undefined;
    readonly cancellation?: {
        readonly requestedAt: number;
        readonly source: "cascade" | "control" | "engine";
        readonly principal?: {
            readonly id: string;
            readonly kind: string;
            readonly stampedAt: number;
        } | undefined;
        readonly reason?: string | undefined;
        readonly cascadedFrom?: string | undefined;
    } | undefined;
    readonly pendingWaits?: readonly {
        readonly runId: string;
        readonly flowId?: string | undefined;
        readonly reason: string;
        readonly token: string;
        readonly tokenDigest?: string | undefined;
        readonly name?: string | undefined;
        readonly attempt?: number | undefined;
        readonly request?: Schema.Json | undefined;
        readonly createdAt: number;
    }[] | undefined;
    readonly deadlineAt?: number | undefined;
    readonly createdAt: number;
    readonly updatedAt: number;
}, E | Journal.JournalError, R>;
/** The token and submit-ready request have one durable admission boundary.
 * @category facts
 * @since 1.0.0
 */
export declare const commitApprovalRequest: (journal: Journal.Service, runtime: Pick<ControlRuntime.Service, "registerApproval">, input: Omit<typeof ApprovalRequestFact.Type, "factVersion">, sourceId: string) => Effect.Effect<ControlRuntime.ApprovalToken, import("../../../src/ControlError.ts").EnvelopeMismatch | Journal.JournalError | import("../../../src/ControlError.ts").PersistenceError | import("../../../src/ControlError.ts").PlanDigestMismatch | import("../../../src/ControlError.ts").RunNotFound, never>;
/** Honest coverage of the displayed lifecycle; engine rows are a separate authority.
 * @category facts
 * @since 1.0.0
 */
export declare const LifecycleProvenance: Schema.Struct<{
    readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
    readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
    readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
    readonly fromSequence: Schema.optional<Schema.Number>;
    readonly throughSequence: Schema.optional<Schema.Number>;
}>;
/** Submit-ready approval state derived solely from admitted facts.
 * @category facts
 * @since 1.0.0
 */
export interface Approval {
    readonly runId: string;
    readonly waitRunId?: string | undefined;
    readonly questionProvenance?: "events" | "legacy-observation" | "unverified-observation" | undefined;
    readonly requestId: string;
    readonly title: string;
    readonly request: ControlSchema.ControlEvent["payload"];
    readonly payload: ControlSchema.ApprovalPayload;
    readonly requestedAt: number;
    readonly status: "pending" | "approved" | "denied";
}
/**
 * One fold for gateway snapshots and subscriptions. Current writers are strict;
 * legacy unnamed decisions may close only a legacy request in the same run.
 * Observed human waits may seed the approval projection without claiming a
 * journaled request. They still require an exact named decision, and share the
 * same digest binding as admitted requests.
 * Duplicate requests never reopen decisions, and a new-style unknown identity
 * never consumes another gate. Snapshot fallback is explicitly unverified.
 * @category facts
 * @since 1.0.0
 */
export declare const fold: (events: ReadonlyArray<ControlSchema.ControlEvent>, snapshot?: ControlSchema.RunSummary, observedApprovals?: ReadonlyArray<Approval>) => {
    readonly run: ControlSchema.RunSummary | undefined;
    readonly provenance: typeof LifecycleProvenance.Type;
    readonly approvals: ReadonlyArray<Approval>;
};
