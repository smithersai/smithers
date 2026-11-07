/**
 * Versioned JSON boundary between the Go product backend and the canonical
 * TypeScript Flow/Control host.
 *
 * This module adapts HTTP-shaped commands to `Control`. It owns no graph,
 * scheduler, journal, or lifecycle state of its own.
 *
 * @since 1.0.0
 */
import { Control } from "@smthrs/control/Control";
import * as ControlError from "@smthrs/control/ControlError";
import { type Service as ControlExecutorService } from "@smthrs/control/ControlExecutor";
import type { Principal } from "@smthrs/control/ControlSchema";
import * as Fault from "@smthrs/flow/Fault";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
/**
 * The only protocol version accepted by this host.
 * @since 1.0.0
 * @category constants
 */
export declare const protocol: "smithers.flow-runtime/v1";
/**
 * Non-secret identity published by readiness for startup compatibility.
 * @since 1.0.0
 * @category models
 */
export declare const Identity: Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly runtimeArtifactDigest: Schema.String;
    readonly sourceRevision: Schema.String;
    readonly ownerGeneration: Schema.Int;
}>;
/**
 * Non-secret identity published by readiness for startup compatibility.
 * @since 1.0.0
 * @category models
 */
export type Identity = typeof Identity.Type;
/**
 * Launches one immutable named flow. Planning and running stay in Control.
 * @since 1.0.0
 * @category models
 */
export declare const LaunchCommand: Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly applicationRequestId: Schema.NonEmptyString;
    readonly ownerGeneration: Schema.Int;
    readonly operation: Schema.Literal<"launch">;
    readonly attempt: Schema.Int;
    readonly runId: Schema.optional<Schema.NonEmptyString>;
    readonly runtimeArtifactDigest: Schema.String;
    readonly sourceRevision: Schema.String;
    readonly flowId: Schema.NonEmptyString;
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly pin: Schema.optional<Schema.Struct<{
        readonly flow: Schema.NonEmptyString;
        readonly sourceCommit: Schema.String;
        readonly executionDigest: Schema.String;
    }>>;
}>;
/**
 * Submits an approval or denial payload produced by the same Control host.
 * @since 1.0.0
 * @category models
 */
export declare const DecisionCommand: Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly applicationRequestId: Schema.NonEmptyString;
    readonly ownerGeneration: Schema.Int;
    readonly operation: Schema.Literals<readonly ["approve", "deny"]>;
    readonly approval: Schema.Struct<{
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
}>;
/**
 * Delivers one durable named signal.
 * @since 1.0.0
 * @category models
 */
export declare const SignalCommand: Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly applicationRequestId: Schema.NonEmptyString;
    readonly ownerGeneration: Schema.Int;
    readonly operation: Schema.Literal<"signal">;
    readonly runId: Schema.NonEmptyString;
    readonly signal: Schema.Struct<{
        readonly name: Schema.String;
        readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    }>;
}>;
/**
 * Enqueues one steer for the runtime's next turn boundary.
 * @since 1.0.0
 * @category models
 */
export declare const SteerCommand: Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly applicationRequestId: Schema.NonEmptyString;
    readonly ownerGeneration: Schema.Int;
    readonly version: Schema.optional<Schema.Number>;
    readonly operation: Schema.Literal<"steer">;
    readonly runId: Schema.NonEmptyString;
    readonly messageId: Schema.NonEmptyString;
    readonly createdAt: Schema.Number;
    readonly attribution: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
    readonly steer: Schema.Union<readonly [Schema.Struct<{
        readonly kind: Schema.Literal<"Message">;
        readonly body: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"Seat">;
        readonly seat: Schema.NonEmptyString;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"Thinking">;
        readonly thinking: Schema.Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh"]>;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"Tools">;
        readonly toolNames: Schema.NonEmptyArray<Schema.NonEmptyString>;
    }>]>;
}>;
/**
 * Requests cancellation, explicit resume, or completion of a retained run.
 * @since 1.0.0
 * @category models
 */
export declare const LifecycleCommand: Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly applicationRequestId: Schema.NonEmptyString;
    readonly ownerGeneration: Schema.Int;
    /** Completion is a host-only lifecycle operation. @since 1.0.0 */
    readonly operation: Schema.Literals<readonly ["cancel", "resume", "complete"]>;
    readonly runId: Schema.NonEmptyString;
    readonly reason: Schema.optional<Schema.String>;
}>;
/**
 * Every mutating operation accepted by the bridge.
 * @since 1.0.0
 * @category models
 */
export declare const Command: Schema.Union<readonly [Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly applicationRequestId: Schema.NonEmptyString;
    readonly ownerGeneration: Schema.Int;
    readonly operation: Schema.Literal<"launch">;
    readonly attempt: Schema.Int;
    readonly runId: Schema.optional<Schema.NonEmptyString>;
    readonly runtimeArtifactDigest: Schema.String;
    readonly sourceRevision: Schema.String;
    readonly flowId: Schema.NonEmptyString;
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly pin: Schema.optional<Schema.Struct<{
        readonly flow: Schema.NonEmptyString;
        readonly sourceCommit: Schema.String;
        readonly executionDigest: Schema.String;
    }>>;
}>, Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly applicationRequestId: Schema.NonEmptyString;
    readonly ownerGeneration: Schema.Int;
    readonly operation: Schema.Literals<readonly ["approve", "deny"]>;
    readonly approval: Schema.Struct<{
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
}>, Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly applicationRequestId: Schema.NonEmptyString;
    readonly ownerGeneration: Schema.Int;
    readonly operation: Schema.Literal<"signal">;
    readonly runId: Schema.NonEmptyString;
    readonly signal: Schema.Struct<{
        readonly name: Schema.String;
        readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    }>;
}>, Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly applicationRequestId: Schema.NonEmptyString;
    readonly ownerGeneration: Schema.Int;
    readonly version: Schema.optional<Schema.Number>;
    readonly operation: Schema.Literal<"steer">;
    readonly runId: Schema.NonEmptyString;
    readonly messageId: Schema.NonEmptyString;
    readonly createdAt: Schema.Number;
    readonly attribution: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
    readonly steer: Schema.Union<readonly [Schema.Struct<{
        readonly kind: Schema.Literal<"Message">;
        readonly body: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"Seat">;
        readonly seat: Schema.NonEmptyString;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"Thinking">;
        readonly thinking: Schema.Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh"]>;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"Tools">;
        readonly toolNames: Schema.NonEmptyArray<Schema.NonEmptyString>;
    }>]>;
}>, Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly applicationRequestId: Schema.NonEmptyString;
    readonly ownerGeneration: Schema.Int;
    /** Completion is a host-only lifecycle operation. @since 1.0.0 */
    readonly operation: Schema.Literals<readonly ["cancel", "resume", "complete"]>;
    readonly runId: Schema.NonEmptyString;
    readonly reason: Schema.optional<Schema.String>;
}>]>;
/**
 * Every mutating operation accepted by the bridge.
 * @since 1.0.0
 * @category models
 */
export type Command = typeof Command.Type;
/**
 * A bounded, reconnectable read of one canonical runtime execution.
 * @since 1.0.0
 * @category models
 */
export declare const ObserveRequest: Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly runId: Schema.NonEmptyString;
    readonly afterCursor: Schema.optional<Schema.String>;
    readonly limit: Schema.optional<Schema.Int>;
}>;
/**
 * A bounded, reconnectable read of one canonical runtime execution.
 * @since 1.0.0
 * @category models
 */
export type ObserveRequest = typeof ObserveRequest.Type;
/**
 * A process result recorded by installed host equipment, never by a flow result.
 * @since 1.0.0
 * @category models
 */
export declare const CommandReceipt: Schema.Struct<{
    readonly runId: Schema.NonEmptyString;
    readonly operationId: Schema.NonEmptyString;
    readonly status: Schema.Literals<readonly ["running", "completed"]>;
    readonly argv: Schema.NonEmptyArray<Schema.String>;
    readonly exitCode: Schema.optionalKey<Schema.Int>;
    readonly stderr: Schema.optionalKey<Schema.String>;
    readonly fault: Schema.optionalKey<Schema.Literals<readonly ["factory", "infra"]>>;
}>;
/**
 * A process result recorded by installed host equipment.
 * @since 1.0.0
 * @category models
 */
export type CommandReceipt = typeof CommandReceipt.Type;
/**
 * Host identity fixed for the lifetime of one owning process.
 * @since 1.0.0
 * @category models
 */
export interface Config {
    readonly runtimeArtifactDigest: string;
    readonly sourceRevision: string;
    /** Captured and verified by native catalog registration, never decoded from a request or environment. */
    readonly verifiedCatalogSourceRevision?: string | undefined;
    readonly ownerGeneration: number;
    /**
     * Private installed-host receipt reader; never accepted on the command wire.
     * @since 1.0.0
     */
    readonly commandReceipt?: ((runId: string) => Effect.Effect<CommandReceipt | undefined, unknown>) | undefined;
    /**
     * Native host completion port, captured from the executor rather than from a request.
     * @since 1.0.0
     */
    readonly requestComplete?: ControlExecutorService["requestComplete"];
    readonly authenticate: (headers: Readonly<Record<string, string>>) => Effect.Effect<Principal, ControlError.Unauthorized>;
}
declare const BridgeError_base: Schema.Class<BridgeError, Schema.TaggedStruct<"@smthrs/gateway/RuntimeBridgeError", {
    readonly code: Schema.Literals<readonly ["invalid_request", "artifact_mismatch", "source_mismatch", "stale_owner", "run_not_found", "resource_limit", "unavailable", "internal"]>;
    readonly message: Schema.String;
    readonly retryable: Schema.Boolean;
}>, import("effect/Cause").YieldableError>;
/**
 * Stable bridge-only failures. Control failures retain their own code.
 * @since 1.0.0
 * @category errors
 */
export declare class BridgeError extends BridgeError_base {
}
/**
 * Executes one decoded command exclusively through the canonical Control API.
 * @since 1.0.0
 * @category constructors
 */
export declare const execute: (config: Config, control: Control["Service"], principal: Principal, input: Command) => Effect.Effect<{
    readonly operation: "launch";
    readonly applicationRequestId: string;
    readonly ownerGeneration: number;
    readonly runtimeArtifactDigest: string;
    readonly sourceRevision: string;
    readonly planId: string;
    readonly planDigest: string;
    readonly executionDigest?: string;
    readonly envelope: {
        readonly capabilities: readonly string[];
        readonly hostImports?: readonly string[] | undefined;
        readonly flows: readonly string[];
        readonly budget: {
            readonly tokens?: number | undefined;
            readonly milliseconds?: number | undefined;
            readonly usd?: number | undefined;
            readonly onExceeded?: "fail" | "park" | "skip-remaining" | "warn" | undefined;
            readonly deadline?: number | undefined;
        };
        readonly host?: string | undefined;
    };
    readonly approval: {
        readonly target: {
            readonly _tag: "Node";
            readonly runId: string;
            readonly requestId: string;
            readonly digest: string;
            readonly envelope: {
                readonly capabilities: readonly string[];
                readonly hostImports?: readonly string[] | undefined;
                readonly flows: readonly string[];
                readonly budget: {
                    readonly tokens?: number | undefined;
                    readonly milliseconds?: number | undefined;
                    readonly usd?: number | undefined;
                    readonly onExceeded?: "fail" | "park" | "skip-remaining" | "warn" | undefined;
                    readonly deadline?: number | undefined;
                };
                readonly host?: string | undefined;
            };
        } | {
            readonly _tag: "Plan";
            readonly planId: string;
            readonly digest: string;
            readonly envelope: {
                readonly capabilities: readonly string[];
                readonly hostImports?: readonly string[] | undefined;
                readonly flows: readonly string[];
                readonly budget: {
                    readonly tokens?: number | undefined;
                    readonly milliseconds?: number | undefined;
                    readonly usd?: number | undefined;
                    readonly onExceeded?: "fail" | "park" | "skip-remaining" | "warn" | undefined;
                    readonly deadline?: number | undefined;
                };
                readonly host?: string | undefined;
            };
        };
        readonly scope: "once" | "remembered" | "run";
        readonly idempotencyKey: string;
    };
    readonly receipt: {
        readonly _tag: "Conflict";
        readonly message: string;
    } | {
        readonly _tag: "Parked";
        readonly receiptId: string;
        readonly planId: string;
        readonly status: "waiting-approval";
    } | {
        readonly _tag: "Terminal";
        readonly runId: string;
        readonly status: "accepted" | "cancelled" | "completed" | "failed" | "parked" | "running" | "waiting-approval";
    } | {
        readonly _tag: "Accepted";
        readonly inputConsumed?: boolean | undefined;
        readonly inputBody?: string | undefined;
        readonly receiptId: string;
        readonly runId?: string | undefined;
        readonly handedTo?: {
            readonly hostId: string;
            readonly pid: number;
        } | undefined;
    } | {
        readonly _tag: "AlreadyApplied";
        readonly receiptId: string;
        readonly runId?: string | undefined;
        readonly inputConsumed?: boolean | undefined;
        readonly inputBody?: string | undefined;
    };
} | {
    readonly operation: "approve" | "deny";
    readonly applicationRequestId: string;
    readonly receipt: {
        readonly _tag: "Conflict";
        readonly message: string;
    } | {
        readonly _tag: "Parked";
        readonly receiptId: string;
        readonly planId: string;
        readonly status: "waiting-approval";
    } | {
        readonly _tag: "Terminal";
        readonly runId: string;
        readonly status: "accepted" | "cancelled" | "completed" | "failed" | "parked" | "running" | "waiting-approval";
    } | {
        readonly _tag: "Accepted";
        readonly inputConsumed?: boolean | undefined;
        readonly inputBody?: string | undefined;
        readonly receiptId: string;
        readonly runId?: string | undefined;
        readonly handedTo?: {
            readonly hostId: string;
            readonly pid: number;
        } | undefined;
    } | {
        readonly _tag: "AlreadyApplied";
        readonly receiptId: string;
        readonly runId?: string | undefined;
        readonly inputConsumed?: boolean | undefined;
        readonly inputBody?: string | undefined;
    };
} | {
    readonly operation: "signal";
    readonly applicationRequestId: string;
    readonly receipt: {
        readonly _tag: "Conflict";
        readonly message: string;
    } | {
        readonly _tag: "Parked";
        readonly receiptId: string;
        readonly planId: string;
        readonly status: "waiting-approval";
    } | {
        readonly _tag: "Terminal";
        readonly runId: string;
        readonly status: "accepted" | "cancelled" | "completed" | "failed" | "parked" | "running" | "waiting-approval";
    } | {
        readonly _tag: "Accepted";
        readonly inputConsumed?: boolean | undefined;
        readonly inputBody?: string | undefined;
        readonly receiptId: string;
        readonly runId?: string | undefined;
        readonly handedTo?: {
            readonly hostId: string;
            readonly pid: number;
        } | undefined;
    } | {
        readonly _tag: "AlreadyApplied";
        readonly receiptId: string;
        readonly runId?: string | undefined;
        readonly inputConsumed?: boolean | undefined;
        readonly inputBody?: string | undefined;
    };
} | {
    readonly operation: "steer";
    readonly applicationRequestId: string;
    readonly receipt: {
        readonly _tag: "Conflict";
        readonly message: string;
    } | {
        readonly _tag: "Parked";
        readonly receiptId: string;
        readonly planId: string;
        readonly status: "waiting-approval";
    } | {
        readonly _tag: "Terminal";
        readonly runId: string;
        readonly status: "accepted" | "cancelled" | "completed" | "failed" | "parked" | "running" | "waiting-approval";
    } | {
        readonly _tag: "Accepted";
        readonly inputConsumed?: boolean | undefined;
        readonly inputBody?: string | undefined;
        readonly receiptId: string;
        readonly runId?: string | undefined;
        readonly handedTo?: {
            readonly hostId: string;
            readonly pid: number;
        } | undefined;
    } | {
        readonly _tag: "AlreadyApplied";
        readonly receiptId: string;
        readonly runId?: string | undefined;
        readonly inputConsumed?: boolean | undefined;
        readonly inputBody?: string | undefined;
    };
} | {
    readonly operation: "complete";
    readonly applicationRequestId: string;
    readonly receipt: {
        readonly _tag: "Conflict";
        readonly message: string;
    } | {
        readonly _tag: "Parked";
        readonly receiptId: string;
        readonly planId: string;
        readonly status: "waiting-approval";
    } | {
        readonly _tag: "Terminal";
        readonly runId: string;
        readonly status: "accepted" | "cancelled" | "completed" | "failed" | "parked" | "running" | "waiting-approval";
    } | {
        readonly _tag: "Accepted";
        readonly inputConsumed?: boolean | undefined;
        readonly inputBody?: string | undefined;
        readonly receiptId: string;
        readonly runId?: string | undefined;
        readonly handedTo?: {
            readonly hostId: string;
            readonly pid: number;
        } | undefined;
    } | {
        readonly _tag: "AlreadyApplied";
        readonly receiptId: string;
        readonly runId?: string | undefined;
        readonly inputConsumed?: boolean | undefined;
        readonly inputBody?: string | undefined;
    };
} | {
    readonly operation: "cancel" | "resume";
    readonly applicationRequestId: string;
    readonly receipt: {
        readonly _tag: "Conflict";
        readonly message: string;
    } | {
        readonly _tag: "Parked";
        readonly receiptId: string;
        readonly planId: string;
        readonly status: "waiting-approval";
    } | {
        readonly _tag: "Terminal";
        readonly runId: string;
        readonly status: "accepted" | "cancelled" | "completed" | "failed" | "parked" | "running" | "waiting-approval";
    } | {
        readonly _tag: "Accepted";
        readonly inputConsumed?: boolean | undefined;
        readonly inputBody?: string | undefined;
        readonly receiptId: string;
        readonly runId?: string | undefined;
        readonly handedTo?: {
            readonly hostId: string;
            readonly pid: number;
        } | undefined;
    } | {
        readonly _tag: "AlreadyApplied";
        readonly receiptId: string;
        readonly runId?: string | undefined;
        readonly inputConsumed?: boolean | undefined;
        readonly inputBody?: string | undefined;
    };
}, ControlError.AlreadyResolved | BridgeError | ControlError.ClaimLost | ControlError.CodeDrift | ControlError.EnvelopeMismatch | ControlError.FlowNotFound | ControlError.InvalidInput | ControlError.LaunchFailed | ControlError.NoMatchingWait | import("@smthrs/notifications/NotificationQueue").NotificationError | ControlError.PersistenceError | ControlError.PlanDenied | ControlError.PlanDigestMismatch | ControlError.PlanNotFound | ControlError.RunNotFound | ControlError.TransportError | ControlError.Unauthorized | ControlError.Unavailable, never>;
/**
 * Reads a bounded event replay and current canonical run projection.
 * @since 1.0.0
 * @category constructors
 */
export declare const observe: (control: Control["Service"], input: ObserveRequest, receipts?: Config["commandReceipt"]) => Effect.Effect<{
    run: {
        executionObservation?: "missing" | "observed" | undefined;
        executionView?: {
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
        runId: string;
        flowId: string;
        recordedStatus?: "accepted" | "cancelled" | "completed" | "failed" | "parked" | "running" | "waiting-approval" | undefined;
        status: "accepted" | "cancelled" | "completed" | "failed" | "parked" | "running" | "waiting-approval";
        planId?: string | undefined;
        planDigest?: string | undefined;
        executionDigest?: string | undefined;
        engineVersion?: string | undefined;
        codeDrift?: {
            readonly recorded?: string | undefined;
            readonly current?: string | undefined;
            readonly recordedEngine?: string | undefined;
            readonly currentEngine?: string | undefined;
        } | undefined;
        ownerId?: string | undefined;
        launchedBy?: {
            readonly id: string;
            readonly kind: string;
        } | undefined;
        parentRunId?: string | undefined;
        lineageId?: string | undefined;
        roundOrdinal?: number | undefined;
        origin?: "child" | "continuation" | "fork" | undefined;
        waitingReason?: string | undefined;
        steering?: {
            readonly pending: number;
        } | undefined;
        pendingResume?: number | undefined;
        parkedBy?: string | undefined;
        cancellation?: {
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
        pendingWaits?: readonly {
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
        deadlineAt?: number | undefined;
        createdAt: number;
        updatedAt: number;
        failureFault?: Fault.Class;
        failureTag?: string;
        failureMessage?: string;
        commandReceipt?: {
            readonly runId: string;
            readonly operationId: string;
            readonly status: "completed" | "running";
            readonly argv: readonly [string, ...string[]];
            readonly exitCode?: number;
            readonly stderr?: string;
            readonly fault?: "factory" | "infra";
        };
        finalOutput?: string;
    };
    events: {
        readonly cursor?: {
            readonly sequence: number;
            readonly offset?: number | undefined;
        } | undefined;
        readonly sequence: number;
        readonly kind: string;
        readonly runId?: string | undefined;
        readonly occurredAt: number;
        readonly payload: Schema.Json;
    }[];
    nextCursor: string;
    hasMore: boolean;
    terminal: boolean;
}, unknown, never>;
/** Read an existing run and its committed journal without invoking any execution door.
 * @since 1.0.0
 * @category constructors
 */
export declare const monitor: (control: Control["Service"], runId: string, at?: number) => Effect.Effect<Partial<{
    presentation: {
        kind: "text";
        text: string;
    };
    id: string;
    flow: string;
    version: string;
    title: string;
    state: "done" | "failed" | "held" | "interrupted" | "running" | "waiting";
    attempts: {
        n: number;
        run_id: string;
        state: "done" | "failed" | "held" | "interrupted" | "running" | "waiting";
        steps: {
            key: string;
            id: string;
            k: number;
            label: string;
            state: string;
            started_at: string;
            ended_at?: string;
            took_s?: number;
            input?: {} | null;
            output?: string;
            meter?: readonly string[];
            model_calls?: number;
            tokens?: number;
        }[];
        phases: {
            id: string;
            step: string;
            title: string;
            took_s: number;
            tone: "fail" | "live" | "ok" | "wait";
            cells: (Omit<import("./RunTrace.vibe").TranscriptCell, "tone"> & {
                tone?: ReturnType<(value: string) => "live" | "ok" | "fail" | "wait">;
            })[];
        }[];
        graph: {
            id: string;
            label: string;
            state: "current" | "done" | "failed" | "next" | "waiting";
            deps: string[];
        }[];
    }[];
    waits: ({
        id: string;
        kind: "approval";
        label: string;
        since: string;
        settled?: {
            by: {
                kind: "system";
                color_index: 7;
            };
            at: string;
        };
    } | {
        id: string;
        kind: "signal" | "sleep";
        label: string;
        since: string;
        settled?: {
            by: {
                kind: "system";
                color_index: 7;
            };
            at: string;
        };
    })[];
    tokens: number;
    time_s: number;
    cost_usd?: number;
    unmetered_tokens?: number;
    engine: {
        label: string;
        detail: string;
    }[];
    journal: {
        seq: number;
        at: string;
        type: string;
        text: string;
    }[];
    replay?: {
        at: number;
        last: number;
    };
} | {
    presentation?: never;
    id: string;
    flow: string;
    version: string;
    title: string;
    state: "done" | "failed" | "held" | "interrupted" | "running" | "waiting";
    attempts: {
        n: number;
        run_id: string;
        state: "done" | "failed" | "held" | "interrupted" | "running" | "waiting";
        steps: {
            key: string;
            id: string;
            k: number;
            label: string;
            state: string;
            started_at: string;
            ended_at?: string;
            took_s?: number;
            input?: {} | null;
            output?: string;
            meter?: readonly string[];
            model_calls?: number;
            tokens?: number;
        }[];
        phases: {
            id: string;
            step: string;
            title: string;
            took_s: number;
            tone: "fail" | "live" | "ok" | "wait";
            cells: (Omit<import("./RunTrace.vibe").TranscriptCell, "tone"> & {
                tone?: ReturnType<(value: string) => "live" | "ok" | "fail" | "wait">;
            })[];
        }[];
        graph: {
            id: string;
            label: string;
            state: "current" | "done" | "failed" | "next" | "waiting";
            deps: string[];
        }[];
    }[];
    waits: ({
        id: string;
        kind: "approval";
        label: string;
        since: string;
        settled?: {
            by: {
                kind: "system";
                color_index: 7;
            };
            at: string;
        };
    } | {
        id: string;
        kind: "signal" | "sleep";
        label: string;
        since: string;
        settled?: {
            by: {
                kind: "system";
                color_index: 7;
            };
            at: string;
        };
    })[];
    tokens: number;
    time_s: number;
    cost_usd?: number;
    unmetered_tokens?: number;
    engine: {
        label: string;
        detail: string;
    }[];
    journal: {
        seq: number;
        at: string;
        type: string;
        text: string;
    }[];
    replay?: {
        at: number;
        last: number;
    };
}> & Omit<{
    presentation: {
        kind: "text";
        text: string;
    };
    id: string;
    flow: string;
    version: string;
    title: string;
    state: "done" | "failed" | "held" | "interrupted" | "running" | "waiting";
    attempts: {
        n: number;
        run_id: string;
        state: "done" | "failed" | "held" | "interrupted" | "running" | "waiting";
        steps: {
            key: string;
            id: string;
            k: number;
            label: string;
            state: string;
            started_at: string;
            ended_at?: string;
            took_s?: number;
            input?: {} | null;
            output?: string;
            meter?: readonly string[];
            model_calls?: number;
            tokens?: number;
        }[];
        phases: {
            id: string;
            step: string;
            title: string;
            took_s: number;
            tone: "fail" | "live" | "ok" | "wait";
            cells: (Omit<import("./RunTrace.vibe").TranscriptCell, "tone"> & {
                tone?: ReturnType<(value: string) => "live" | "ok" | "fail" | "wait">;
            })[];
        }[];
        graph: {
            id: string;
            label: string;
            state: "current" | "done" | "failed" | "next" | "waiting";
            deps: string[];
        }[];
    }[];
    waits: ({
        id: string;
        kind: "approval";
        label: string;
        since: string;
        settled?: {
            by: {
                kind: "system";
                color_index: 7;
            };
            at: string;
        };
    } | {
        id: string;
        kind: "signal" | "sleep";
        label: string;
        since: string;
        settled?: {
            by: {
                kind: "system";
                color_index: 7;
            };
            at: string;
        };
    })[];
    tokens: number;
    time_s: number;
    cost_usd?: number;
    unmetered_tokens?: number;
    engine: {
        label: string;
        detail: string;
    }[];
    journal: {
        seq: number;
        at: string;
        type: string;
        text: string;
    }[];
    replay?: {
        at: number;
        last: number;
    };
} | {
    presentation?: never;
    id: string;
    flow: string;
    version: string;
    title: string;
    state: "done" | "failed" | "held" | "interrupted" | "running" | "waiting";
    attempts: {
        n: number;
        run_id: string;
        state: "done" | "failed" | "held" | "interrupted" | "running" | "waiting";
        steps: {
            key: string;
            id: string;
            k: number;
            label: string;
            state: string;
            started_at: string;
            ended_at?: string;
            took_s?: number;
            input?: {} | null;
            output?: string;
            meter?: readonly string[];
            model_calls?: number;
            tokens?: number;
        }[];
        phases: {
            id: string;
            step: string;
            title: string;
            took_s: number;
            tone: "fail" | "live" | "ok" | "wait";
            cells: (Omit<import("./RunTrace.vibe").TranscriptCell, "tone"> & {
                tone?: ReturnType<(value: string) => "live" | "ok" | "fail" | "wait">;
            })[];
        }[];
        graph: {
            id: string;
            label: string;
            state: "current" | "done" | "failed" | "next" | "waiting";
            deps: string[];
        }[];
    }[];
    waits: ({
        id: string;
        kind: "approval";
        label: string;
        since: string;
        settled?: {
            by: {
                kind: "system";
                color_index: 7;
            };
            at: string;
        };
    } | {
        id: string;
        kind: "signal" | "sleep";
        label: string;
        since: string;
        settled?: {
            by: {
                kind: "system";
                color_index: 7;
            };
            at: string;
        };
    })[];
    tokens: number;
    time_s: number;
    cost_usd?: number;
    unmetered_tokens?: number;
    engine: {
        label: string;
        detail: string;
    }[];
    journal: {
        seq: number;
        at: string;
        type: string;
        text: string;
    }[];
    replay?: {
        at: number;
        last: number;
    };
}, "journal"> & {
    extent?: {
        start: string;
        end: string;
    };
}, ControlError.AlreadyResolved | BridgeError | ControlError.ClaimLost | ControlError.CodeDrift | ControlError.CredentialConflict | ControlError.EnvelopeMismatch | ControlError.FlowNotFound | ControlError.InvalidInput | ControlError.LaunchFailed | ControlError.NoMatchingWait | import("@smthrs/notifications/NotificationQueue").NotificationError | ControlError.PersistenceError | ControlError.PlanDenied | ControlError.PlanDigestMismatch | ControlError.PlanNotFound | ControlError.RunNotFound | ControlError.TransportError | ControlError.Unauthorized | ControlError.Unavailable, never>;
/**
 * Successful command response on the JSON wire.
 * @since 1.0.0
 * @category models
 */
export declare const CommandResponse: Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly ok: Schema.Literal<true>;
    readonly value: Schema.Struct<{
        readonly operation: Schema.String;
        readonly applicationRequestId: Schema.String;
        readonly ownerGeneration: Schema.optional<Schema.Int>;
        readonly runtimeArtifactDigest: Schema.optional<Schema.String>;
        readonly sourceRevision: Schema.optional<Schema.String>;
        readonly planId: Schema.optional<Schema.String>;
        readonly planDigest: Schema.optional<Schema.String>;
        readonly executionDigest: Schema.optional<Schema.String>;
        readonly envelope: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
        readonly approval: Schema.optional<Schema.Struct<{
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
        }>>;
        readonly receipt: Schema.Union<readonly [Schema.TaggedStruct<"Accepted", {
            readonly inputConsumed: Schema.optional<Schema.Boolean>;
            readonly inputBody: Schema.optional<Schema.String>;
            readonly receiptId: Schema.String;
            readonly runId: Schema.optional<Schema.String>;
            readonly handedTo: Schema.optional<Schema.Struct<{
                readonly hostId: Schema.String;
                readonly pid: Schema.Number;
            }>>;
        }>, Schema.TaggedStruct<"AlreadyApplied", {
            readonly receiptId: Schema.String;
            readonly runId: Schema.optional<Schema.String>;
            readonly inputConsumed: Schema.optional<Schema.Boolean>;
            readonly inputBody: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"Parked", {
            readonly receiptId: Schema.String;
            readonly planId: Schema.String;
            readonly status: Schema.Literal<"waiting-approval">;
        }>, Schema.TaggedStruct<"Conflict", {
            readonly message: Schema.String;
        }>, Schema.TaggedStruct<"Terminal", {
            readonly runId: Schema.String;
            readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
        }>]>;
    }>;
}>;
/**
 * Successful observation response on the JSON wire.
 * @since 1.0.0
 * @category models
 */
export declare const ObserveResponse: Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly ok: Schema.Literal<true>;
    readonly value: Schema.Struct<{
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
            readonly finalOutput: Schema.optional<Schema.String>;
            readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
            readonly failureTag: Schema.optional<Schema.String>;
            readonly failureMessage: Schema.optional<Schema.String>;
            readonly commandReceipt: Schema.optionalKey<Schema.Struct<{
                readonly runId: Schema.NonEmptyString;
                readonly operationId: Schema.NonEmptyString;
                readonly status: Schema.Literals<readonly ["running", "completed"]>;
                readonly argv: Schema.NonEmptyArray<Schema.String>;
                readonly exitCode: Schema.optionalKey<Schema.Int>;
                readonly stderr: Schema.optionalKey<Schema.String>;
                readonly fault: Schema.optionalKey<Schema.Literals<readonly ["factory", "infra"]>>;
            }>>;
        }>;
        readonly events: Schema.$Array<Schema.Struct<{
            readonly cursor: Schema.optional<Schema.Struct<{
                readonly sequence: Schema.Int;
                readonly offset: Schema.optional<Schema.Int>;
            }>>;
            readonly sequence: Schema.Number;
            readonly kind: Schema.String;
            readonly runId: Schema.optional<Schema.String>;
            readonly occurredAt: Schema.Number;
            readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        }>>;
        readonly nextCursor: Schema.String;
        readonly hasMore: Schema.Boolean;
        readonly terminal: Schema.Boolean;
    }>;
}>;
/**
 * Stable sanitized failure response on the JSON wire.
 * @since 1.0.0
 * @category models
 */
export declare const ErrorResponse: Schema.Struct<{
    readonly protocol: Schema.Literal<"smithers.flow-runtime/v1">;
    readonly ok: Schema.Literal<false>;
    readonly error: Schema.Struct<{
        readonly code: Schema.String;
        readonly message: Schema.String;
        readonly retryable: Schema.Boolean;
    }>;
}>;
/**
 * Mounts the authenticated JSON bridge beside the existing gateway RPCs.
 * @since 1.0.0
 * @category layers
 */
export declare const layer: (config: Config) => Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request<"Requires", Control>>;
export {};
