/**
 * Schema-backed RPC projection of the control service.
 *
 * @since 0.1.0
 */
import { NotificationError } from "@smthrs/notifications/NotificationQueue";
import { Context, Effect, Layer, Schema } from "effect";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";
import { AlreadyResolved, ClaimLost, CodeDrift, EnvelopeMismatch, FlowNotFound, InvalidInput, LaunchFailed, NoMatchingWait, PersistenceError, PlanDenied, PlanDigestMismatch, PlanNotFound, RunNotFound, TransportError, Unauthorized, Unavailable } from "./ControlError.vibe";
import { type Principal } from "../../../src/ControlSchema.ts";
declare const ControlPrincipal_base: Context.ServiceClass<ControlPrincipal, "/control/ControlPrincipal", {
    readonly id: string;
    readonly kind: string;
    readonly stampedAt: number;
}>;
/**
 * Authenticated principal made available to control RPC handlers.
 *
 * @category services
 * @since 0.1.0
 */
export declare class ControlPrincipal extends ControlPrincipal_base {
}
declare const ControlAuth_base: RpcMiddleware.ServiceClass<ControlAuth, "/control/ControlAuth", ControlPrincipal, typeof Unauthorized, never, never, false>;
/**
 * Middleware boundary that authenticates control RPC requests.
 *
 * @category middleware
 * @since 0.1.0
 */
export declare class ControlAuth extends ControlAuth_base {
}
/**
 * Which authenticated principals read every run.
 *
 * `List` and `Watch` answer a principal this returns `true` for with every
 * run: that principal is an operator. Every other principal reads only the
 * runs it launched (`RunSummary.launchedBy`) and, from `Watch`, only their
 * events. The authentication layer decides, because it is what knows which
 * identities it can stamp: `layerBearerAuth` and `layerNoopAuth` stamp one
 * principal and make it the operator, and `layerAuth` takes the rule as an
 * option. Where nothing provides one, no principal is an operator.
 *
 * @category services
 * @since 1.0.0
 */
export declare const RunVisibility: Context.Reference<{
    readonly seesAllRuns: (principal: typeof Principal.Type) => boolean;
}>;
/**
 * The sentence a client reads when a control handler dies.
 *
 * @category defects
 * @since 1.0.0
 */
export declare const defectMessage = "Something went wrong on our side. Not your fault.";
/**
 * Wire schema for a control RPC defect: an untyped failure that no procedure
 * declares.
 *
 * Encoding replaces a defect value (an `Error`, a failure an `orDie` turned
 * into a defect, or a string) with `{ name: "Error", message }`
 * carrying {@link defectMessage}, so a driver message, path, or stack never
 * reaches a client. The server logs a content-free diagnostic. Strings receive the same protection,
 * including request-decoding failures.
 *
 * Decoding is Effect's default `Schema.Defect()` decoding, so a client reads
 * this shape and an older server's shape alike, and an older client reads this
 * shape as an `Error`.
 *
 * @category defects
 * @since 1.0.0
 */
export declare const ControlDefect: Schema.decodeTo<Schema.Unknown, Schema.Codec<Schema.Json, Schema.Json, never, never>, never, never>;
/**
 * The ten remote procedures corresponding to `Control` operations.
 *
 * @category groups
 * @since 0.1.0
 */
export declare const ControlRpcs: RpcGroup.RpcGroup<Rpc.Rpc<"Watch", Schema.Struct<{
    readonly runId: Schema.optional<Schema.String>;
    readonly afterSequence: Schema.optional<Schema.Number>;
    readonly afterCursor: Schema.optional<Schema.Struct<{
        readonly sequence: Schema.Int;
        readonly offset: Schema.optional<Schema.Int>;
    }>>;
    readonly follow: Schema.optional<Schema.Boolean>;
}>, import("effect/rpc/RpcSchema").Stream<Schema.Struct<{
    readonly cursor: Schema.optional<Schema.Struct<{
        readonly sequence: Schema.Int;
        readonly offset: Schema.optional<Schema.Int>;
    }>>;
    readonly sequence: Schema.Number;
    readonly kind: Schema.String;
    readonly runId: Schema.optional<Schema.String>;
    readonly occurredAt: Schema.Number;
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>, Schema.Union<readonly [typeof RunNotFound, typeof PlanNotFound, typeof PlanDenied, typeof FlowNotFound, typeof PlanDigestMismatch, typeof EnvelopeMismatch, typeof ClaimLost, typeof CodeDrift, typeof AlreadyResolved, typeof InvalidInput, typeof Unauthorized, typeof Unavailable, typeof TransportError, typeof PersistenceError, typeof LaunchFailed, typeof NoMatchingWait, typeof import("./ControlError.vibe").CredentialConflict, typeof NotificationError]>>, Schema.Never, typeof ControlAuth, never> | Rpc.Rpc<"Plan", Schema.Struct<{
    readonly flowId: Schema.String;
    readonly input: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly idempotencyKey: Schema.optional<Schema.String>;
    readonly budget: Schema.optional<Schema.Struct<{
        readonly tokens: Schema.optional<Schema.Number>;
        readonly milliseconds: Schema.optional<Schema.Number>;
        readonly usd: Schema.optional<Schema.Number>;
        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
        readonly deadline: Schema.optional<Schema.Int>;
    }>>;
}>, Schema.Struct<{
    readonly planId: Schema.String;
    readonly flowId: Schema.String;
    readonly digest: Schema.String;
    readonly inputSummary: Schema.String;
    readonly warnings: Schema.optional<Schema.$Array<typeof import("@smthrs/registry/Descriptor").DiscoveryWarning>>;
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
    readonly deployClass: Schema.Boolean;
    readonly executionDigest: Schema.optional<Schema.String>;
    readonly plan: Schema.optional<Schema.Struct<{
        readonly planId: Schema.NonEmptyString;
        readonly flow: Schema.NonEmptyString;
        readonly generation: Schema.Int;
        readonly baseDigest: Schema.brand<Schema.String, "@smthrs/keys/Key">;
        readonly digest: Schema.brand<Schema.String, "@smthrs/keys/Key">;
        readonly nodes: Schema.$Array<Schema.Struct<{
            readonly id: Schema.NonEmptyString;
            readonly kind: Schema.Literals<readonly ["step", "agent", "merge"]>;
            readonly key: Schema.brand<Schema.String, "@smthrs/keys/Key">;
            readonly material: Schema.Struct<{
                readonly version: Schema.Literal<"flows/key-material/v2">;
                readonly kind: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
                readonly nondeterministic: Schema.optional<Schema.Literal<true>>;
                readonly body: Schema.Unknown;
                readonly inputs: Schema.$Array<Schema.Union<readonly [Schema.TaggedStruct<"Literal", {
                    readonly value: Schema.Unknown;
                }>, Schema.TaggedStruct<"Ref", {
                    readonly from: Schema.NonEmptyString;
                    readonly path: Schema.$Array<Schema.String>;
                }>, Schema.TaggedStruct<"Pending", {
                    readonly from: Schema.NonEmptyString;
                }>]>>;
                readonly layers: Schema.$Array<Schema.String>;
                readonly capabilities: Schema.$Array<Schema.String>;
                readonly effects: Schema.optional<Schema.Unknown>;
                readonly placement: Schema.optional<Schema.Unknown>;
            }>;
            readonly effects: Schema.Struct<{
                readonly reads: Schema.$Array<Schema.Union<readonly [Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                    readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                    readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                }>]>, Schema.TaggedStruct<"Filegroup", {
                    readonly name: Schema.NonEmptyString;
                    readonly entries: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                        readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                        readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                    }>]>>;
                }>]>>;
                readonly writes: Schema.$Array<Schema.Union<readonly [Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                    readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                    readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                }>, Schema.TaggedStruct<"TreeArtifact", {
                    readonly path: Schema.NonEmptyString;
                }>]>, Schema.TaggedStruct<"Filegroup", {
                    readonly name: Schema.NonEmptyString;
                    readonly entries: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                        readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                        readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                    }>, Schema.TaggedStruct<"TreeArtifact", {
                        readonly path: Schema.NonEmptyString;
                    }>]>>;
                }>]>>;
                readonly removes: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                readonly boundaryMode: Schema.Literals<readonly ["hard", "expected"]>;
            }>;
            readonly dependsOn: Schema.$Array<Schema.NonEmptyString>;
            readonly conflicts: Schema.$Array<Schema.Struct<{
                readonly with: Schema.NonEmptyString;
                readonly paths: Schema.$Array<Schema.String>;
                readonly strategy: Schema.Literals<readonly ["serialize", "lane", "fail"]>;
                readonly runtime: Schema.Literals<readonly ["delay-rebase", "stop-merge"]>;
            }>>;
            readonly strategy: Schema.Literals<readonly ["serialize", "lane", "fail"]>;
            readonly runtime: Schema.Literals<readonly ["delay-rebase", "stop-merge"]>;
            readonly priority: Schema.Int;
            readonly generation: Schema.Int;
        }>>;
    }>>;
    readonly nodes: Schema.$Array<Schema.Struct<{
        readonly id: Schema.NonEmptyString;
        readonly kind: Schema.Literals<readonly ["step", "agent", "merge"]>;
        readonly key: Schema.brand<Schema.String, "@smthrs/keys/Key">;
        readonly material: Schema.Struct<{
            readonly version: Schema.Literal<"flows/key-material/v2">;
            readonly kind: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
            readonly nondeterministic: Schema.optional<Schema.Literal<true>>;
            readonly body: Schema.Unknown;
            readonly inputs: Schema.$Array<Schema.Union<readonly [Schema.TaggedStruct<"Literal", {
                readonly value: Schema.Unknown;
            }>, Schema.TaggedStruct<"Ref", {
                readonly from: Schema.NonEmptyString;
                readonly path: Schema.$Array<Schema.String>;
            }>, Schema.TaggedStruct<"Pending", {
                readonly from: Schema.NonEmptyString;
            }>]>>;
            readonly layers: Schema.$Array<Schema.String>;
            readonly capabilities: Schema.$Array<Schema.String>;
            readonly effects: Schema.optional<Schema.Unknown>;
            readonly placement: Schema.optional<Schema.Unknown>;
        }>;
        readonly effects: Schema.Struct<{
            readonly reads: Schema.$Array<Schema.Union<readonly [Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
            }>]>, Schema.TaggedStruct<"Filegroup", {
                readonly name: Schema.NonEmptyString;
                readonly entries: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                    readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                    readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                }>]>>;
            }>]>>;
            readonly writes: Schema.$Array<Schema.Union<readonly [Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
            }>, Schema.TaggedStruct<"TreeArtifact", {
                readonly path: Schema.NonEmptyString;
            }>]>, Schema.TaggedStruct<"Filegroup", {
                readonly name: Schema.NonEmptyString;
                readonly entries: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                    readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                    readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                }>, Schema.TaggedStruct<"TreeArtifact", {
                    readonly path: Schema.NonEmptyString;
                }>]>>;
            }>]>>;
            readonly removes: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
            readonly boundaryMode: Schema.Literals<readonly ["hard", "expected"]>;
        }>;
        readonly dependsOn: Schema.$Array<Schema.NonEmptyString>;
        readonly conflicts: Schema.$Array<Schema.Struct<{
            readonly with: Schema.NonEmptyString;
            readonly paths: Schema.$Array<Schema.String>;
            readonly strategy: Schema.Literals<readonly ["serialize", "lane", "fail"]>;
            readonly runtime: Schema.Literals<readonly ["delay-rebase", "stop-merge"]>;
        }>>;
        readonly strategy: Schema.Literals<readonly ["serialize", "lane", "fail"]>;
        readonly runtime: Schema.Literals<readonly ["delay-rebase", "stop-merge"]>;
        readonly priority: Schema.Int;
        readonly generation: Schema.Int;
        readonly status: Schema.Literals<readonly ["cached", "run"]>;
    }>>;
    readonly graph: Schema.optional<Schema.Struct<{
        readonly edges: Schema.$Array<Schema.Struct<{
            readonly from: Schema.NonEmptyString;
            readonly to: Schema.NonEmptyString;
            readonly reason: Schema.Literals<readonly ["value", "continuation", "failure", "conflict", "lane-merge"]>;
        }>>;
        readonly nodes: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly id: Schema.NonEmptyString;
            readonly declaredAt: Schema.optionalKey<Schema.Struct<{
                readonly path: Schema.NonEmptyString;
                readonly line: Schema.Int;
            }>>;
        }>>>;
        readonly sourceRevision: Schema.optional<Schema.NonEmptyString>;
    }>>;
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
}>, Schema.Union<readonly [typeof FlowNotFound, typeof InvalidInput, typeof PersistenceError, typeof Unavailable, typeof TransportError, typeof Unauthorized]>, typeof ControlAuth, never> | Rpc.Rpc<"Cancel", Schema.Struct<{
    readonly runId: Schema.String;
    readonly idempotencyKey: Schema.String;
    readonly reason: Schema.optional<Schema.String>;
}>, Schema.Union<readonly [Schema.TaggedStruct<"Accepted", {
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
}>]>, Schema.Union<readonly [typeof RunNotFound, typeof ClaimLost, typeof InvalidInput, typeof PersistenceError, typeof Unavailable, typeof TransportError, typeof Unauthorized]>, typeof ControlAuth, never> | Rpc.Rpc<"Steer", Schema.Struct<{
    readonly version: Schema.optional<Schema.Number>;
    readonly runId: Schema.String;
    readonly message: Schema.Union<readonly [Schema.Struct<{
        readonly messageId: Schema.String;
        readonly runId: Schema.String;
        readonly principal: Schema.Struct<{
            readonly id: Schema.String;
            readonly kind: Schema.String;
            readonly stampedAt: Schema.Number;
        }>;
        readonly attribution: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
        readonly createdAt: Schema.Number;
        readonly kind: Schema.optional<Schema.Literal<"Message">>;
        readonly body: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"Seat">;
        readonly seat: Schema.NonEmptyString;
        readonly messageId: Schema.String;
        readonly runId: Schema.String;
        readonly principal: Schema.Struct<{
            readonly id: Schema.String;
            readonly kind: Schema.String;
            readonly stampedAt: Schema.Number;
        }>;
        readonly attribution: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
        readonly createdAt: Schema.Number;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"Thinking">;
        readonly thinking: Schema.Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh"]>;
        readonly messageId: Schema.String;
        readonly runId: Schema.String;
        readonly principal: Schema.Struct<{
            readonly id: Schema.String;
            readonly kind: Schema.String;
            readonly stampedAt: Schema.Number;
        }>;
        readonly attribution: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
        readonly createdAt: Schema.Number;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"Tools">;
        readonly toolNames: Schema.NonEmptyArray<Schema.NonEmptyString>;
        readonly messageId: Schema.String;
        readonly runId: Schema.String;
        readonly principal: Schema.Struct<{
            readonly id: Schema.String;
            readonly kind: Schema.String;
            readonly stampedAt: Schema.Number;
        }>;
        readonly attribution: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
        readonly createdAt: Schema.Number;
    }>]>;
    readonly idempotencyKey: Schema.String;
}>, Schema.Union<readonly [Schema.TaggedStruct<"Accepted", {
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
}>]>, Schema.Union<readonly [typeof RunNotFound, typeof InvalidInput, typeof PersistenceError, typeof Unavailable, typeof TransportError, typeof Unauthorized, typeof NotificationError]>, typeof ControlAuth, never> | Rpc.Rpc<"Signal", Schema.Struct<{
    readonly runId: Schema.String;
    readonly signal: Schema.Struct<{
        readonly name: Schema.String;
        readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    }>;
    readonly idempotencyKey: Schema.String;
}>, Schema.Union<readonly [Schema.TaggedStruct<"Accepted", {
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
}>]>, Schema.Union<readonly [typeof RunNotFound, typeof NoMatchingWait, typeof InvalidInput, typeof PersistenceError, typeof Unavailable, typeof TransportError, typeof Unauthorized]>, typeof ControlAuth, never> | Rpc.Rpc<"Resume", Schema.Struct<{
    readonly runId: Schema.String;
    readonly idempotencyKey: Schema.String;
    readonly reason: Schema.optional<Schema.String>;
    readonly allowCodeDrift: Schema.optional<Schema.Boolean>;
}>, Schema.Union<readonly [Schema.TaggedStruct<"Accepted", {
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
}>]>, Schema.Union<readonly [typeof RunNotFound, typeof ClaimLost, typeof CodeDrift, typeof InvalidInput, typeof PersistenceError, typeof Unavailable, typeof TransportError, typeof Unauthorized]>, typeof ControlAuth, never> | Rpc.Rpc<"Approve", Schema.Struct<{
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
}>, Schema.Union<readonly [Schema.TaggedStruct<"Accepted", {
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
}>]>, Schema.Union<readonly [typeof PlanDigestMismatch, typeof EnvelopeMismatch, typeof AlreadyResolved, typeof PlanNotFound, typeof RunNotFound, typeof CodeDrift, typeof InvalidInput, typeof Unauthorized, typeof PersistenceError, typeof Unavailable, typeof TransportError]>, typeof ControlAuth, never> | Rpc.Rpc<"Deny", Schema.Struct<{
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
}>, Schema.Union<readonly [Schema.TaggedStruct<"Accepted", {
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
}>]>, Schema.Union<readonly [typeof PlanDigestMismatch, typeof EnvelopeMismatch, typeof AlreadyResolved, typeof PlanNotFound, typeof RunNotFound, typeof CodeDrift, typeof InvalidInput, typeof Unauthorized, typeof PersistenceError, typeof Unavailable, typeof TransportError]>, typeof ControlAuth, never> | Rpc.Rpc<"Run", Schema.Union<readonly [Schema.TaggedStruct<"Plan", {
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
    readonly idempotencyKey: Schema.String;
}>, Schema.TaggedStruct<"Resume", {
    readonly runId: Schema.String;
    readonly idempotencyKey: Schema.String;
    readonly allowCodeDrift: Schema.optional<Schema.Boolean>;
}>]>, Schema.Union<readonly [Schema.TaggedStruct<"Accepted", {
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
}>]>, Schema.Union<readonly [typeof RunNotFound, typeof PlanNotFound, typeof PlanDenied, typeof PlanDigestMismatch, typeof EnvelopeMismatch, typeof ClaimLost, typeof CodeDrift, typeof InvalidInput, typeof LaunchFailed, typeof PersistenceError, typeof Unavailable, typeof TransportError, typeof Unauthorized]>, typeof ControlAuth, never> | Rpc.Rpc<"List", Schema.Union<readonly [Schema.TaggedStruct<"executions", {
    readonly runId: Schema.String;
    readonly executionIds: Schema.$Array<Schema.NonEmptyString>;
}>, Schema.TaggedStruct<"flows", {
    readonly filters: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly cursor: Schema.optional<Schema.String>;
    readonly limit: Schema.optional<Schema.Int>;
}>, Schema.TaggedStruct<"runs", {
    readonly filters: Schema.optional<Schema.Struct<{
        readonly runId: Schema.optional<Schema.String>;
        readonly flowId: Schema.optional<Schema.String>;
        readonly status: Schema.optional<Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>>;
        readonly terminal: Schema.optional<Schema.Boolean>;
        readonly principalId: Schema.optional<Schema.String>;
        readonly parentRunId: Schema.optional<Schema.String>;
        readonly lineageId: Schema.optional<Schema.String>;
        readonly since: Schema.optional<Schema.Number>;
        readonly until: Schema.optional<Schema.Number>;
        readonly triggerId: Schema.optional<Schema.String>;
    }>>;
    readonly order: Schema.optional<Schema.Literals<readonly ["newest", "oldest"]>>;
    readonly cursor: Schema.optional<Schema.String>;
    readonly limit: Schema.optional<Schema.Int>;
}>, Schema.TaggedStruct<"triggers", {
    readonly filters: Schema.optional<Schema.Struct<{
        readonly triggerId: Schema.optional<Schema.String>;
        readonly flowId: Schema.optional<Schema.String>;
        readonly enabled: Schema.optional<Schema.Boolean>;
    }>>;
    readonly cursor: Schema.optional<Schema.String>;
    readonly limit: Schema.optional<Schema.Int>;
}>, Schema.TaggedStruct<"fires", {
    readonly filters: Schema.optional<Schema.Struct<{
        readonly triggerId: Schema.optional<Schema.String>;
        readonly runId: Schema.optional<Schema.String>;
        readonly outcome: Schema.optional<Schema.Literals<readonly ["launched", "completed", "skipped", "buffered", "superseded", "failed"]>>;
    }>>;
    readonly cursor: Schema.optional<Schema.String>;
    readonly limit: Schema.optional<Schema.Int>;
}>, Schema.TaggedStruct<"plans", {
    readonly filters: Schema.optional<Schema.Struct<{
        readonly flowId: Schema.optional<Schema.String>;
        readonly decision: Schema.optional<Schema.Literals<readonly ["pending", "approved", "denied"]>>;
    }>>;
    readonly cursor: Schema.optional<Schema.String>;
    readonly limit: Schema.optional<Schema.Int>;
}>]>, Schema.Union<readonly [Schema.TaggedStruct<"executions", {
    readonly source: Schema.NullOr<Schema.String>;
    readonly revision: Schema.NullOr<Schema.Int>;
    readonly items: Schema.$Array<Schema.Union<readonly [Schema.TaggedStruct<"Observed", {
        readonly executionId: Schema.String;
        readonly source: Schema.String;
        readonly revision: Schema.Int;
        readonly observation: Schema.Struct<{
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
    }>, Schema.TaggedStruct<"Missing", {
        readonly executionId: Schema.String;
        readonly source: Schema.String;
        readonly revision: Schema.Int;
        readonly deleted: Schema.Boolean;
    }>, Schema.TaggedStruct<"Unavailable", {
        readonly executionId: Schema.String;
        readonly reason: Schema.Literals<readonly ["unsupported", "outside-run", "ancestry-unavailable"]>;
    }>]>>;
    readonly nextCursor: Schema.optional<Schema.Never>;
}>, Schema.TaggedStruct<"flows", {
    readonly items: Schema.$Array<Schema.Struct<{
        readonly flowId: Schema.String;
        readonly description: Schema.String;
        readonly inputSchema: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    }>>;
    readonly warnings: Schema.optional<Schema.$Array<typeof import("@smthrs/registry/Descriptor").DiscoveryWarning>>;
    readonly nextCursor: Schema.optional<Schema.String>;
}>, Schema.TaggedStruct<"runs", {
    readonly items: Schema.$Array<Schema.Struct<{
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
    }>>;
    readonly nextCursor: Schema.optional<Schema.String>;
}>, Schema.TaggedStruct<"triggers", {
    readonly items: Schema.$Array<Schema.Struct<{
        readonly triggerId: Schema.String;
        readonly flowId: Schema.String;
        readonly input: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        readonly cron: Schema.String;
        readonly timezone: Schema.optional<Schema.String>;
        readonly overlap: Schema.Literals<readonly ["skip", "buffer-one", "supersede"]>;
        readonly catchUp: Schema.Literals<readonly ["none", "one", "all"]>;
        readonly maxCatchUp: Schema.optional<Schema.Number>;
        readonly enabled: Schema.Boolean;
        readonly revision: Schema.Number;
        readonly lastFiredAtMs: Schema.optional<Schema.Number>;
        readonly pendingAtMs: Schema.optional<Schema.Number>;
        readonly activeRunId: Schema.optional<Schema.String>;
        readonly nextOccurrencesMs: Schema.$Array<Schema.Number>;
        readonly schedulerLastTickMs: Schema.optional<Schema.Number>;
    }>>;
    readonly nextCursor: Schema.optional<Schema.String>;
}>, Schema.TaggedStruct<"fires", {
    readonly items: Schema.$Array<Schema.Struct<{
        readonly triggerId: Schema.String;
        readonly occurrenceAtMs: Schema.Number;
        readonly outcome: Schema.NullOr<Schema.Literals<readonly ["launched", "completed", "skipped", "buffered", "superseded", "failed"]>>;
        readonly runId: Schema.optional<Schema.String>;
        readonly error: Schema.optional<Schema.String>;
        readonly waiting: Schema.optional<Schema.Literal<"approval">>;
    }>>;
    readonly nextCursor: Schema.optional<Schema.String>;
}>, Schema.TaggedStruct<"plans", {
    readonly items: Schema.$Array<Schema.Struct<{
        readonly card: Schema.Struct<{
            readonly planId: Schema.String;
            readonly flowId: Schema.String;
            readonly digest: Schema.String;
            readonly inputSummary: Schema.String;
            readonly warnings: Schema.optional<Schema.$Array<typeof import("@smthrs/registry/Descriptor").DiscoveryWarning>>;
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
            readonly deployClass: Schema.Boolean;
            readonly executionDigest: Schema.optional<Schema.String>;
            readonly plan: Schema.optional<Schema.Struct<{
                readonly planId: Schema.NonEmptyString;
                readonly flow: Schema.NonEmptyString;
                readonly generation: Schema.Int;
                readonly baseDigest: Schema.brand<Schema.String, "@smthrs/keys/Key">;
                readonly digest: Schema.brand<Schema.String, "@smthrs/keys/Key">;
                readonly nodes: Schema.$Array<Schema.Struct<{
                    readonly id: Schema.NonEmptyString;
                    readonly kind: Schema.Literals<readonly ["step", "agent", "merge"]>;
                    readonly key: Schema.brand<Schema.String, "@smthrs/keys/Key">;
                    readonly material: Schema.Struct<{
                        readonly version: Schema.Literal<"flows/key-material/v2">;
                        readonly kind: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
                        readonly nondeterministic: Schema.optional<Schema.Literal<true>>;
                        readonly body: Schema.Unknown;
                        readonly inputs: Schema.$Array<Schema.Union<readonly [Schema.TaggedStruct<"Literal", {
                            readonly value: Schema.Unknown;
                        }>, Schema.TaggedStruct<"Ref", {
                            readonly from: Schema.NonEmptyString;
                            readonly path: Schema.$Array<Schema.String>;
                        }>, Schema.TaggedStruct<"Pending", {
                            readonly from: Schema.NonEmptyString;
                        }>]>>;
                        readonly layers: Schema.$Array<Schema.String>;
                        readonly capabilities: Schema.$Array<Schema.String>;
                        readonly effects: Schema.optional<Schema.Unknown>;
                        readonly placement: Schema.optional<Schema.Unknown>;
                    }>;
                    readonly effects: Schema.Struct<{
                        readonly reads: Schema.$Array<Schema.Union<readonly [Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                            readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                            readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                        }>]>, Schema.TaggedStruct<"Filegroup", {
                            readonly name: Schema.NonEmptyString;
                            readonly entries: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                                readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                                readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                            }>]>>;
                        }>]>>;
                        readonly writes: Schema.$Array<Schema.Union<readonly [Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                            readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                            readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                        }>, Schema.TaggedStruct<"TreeArtifact", {
                            readonly path: Schema.NonEmptyString;
                        }>]>, Schema.TaggedStruct<"Filegroup", {
                            readonly name: Schema.NonEmptyString;
                            readonly entries: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                                readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                                readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                            }>, Schema.TaggedStruct<"TreeArtifact", {
                                readonly path: Schema.NonEmptyString;
                            }>]>>;
                        }>]>>;
                        readonly removes: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                        readonly boundaryMode: Schema.Literals<readonly ["hard", "expected"]>;
                    }>;
                    readonly dependsOn: Schema.$Array<Schema.NonEmptyString>;
                    readonly conflicts: Schema.$Array<Schema.Struct<{
                        readonly with: Schema.NonEmptyString;
                        readonly paths: Schema.$Array<Schema.String>;
                        readonly strategy: Schema.Literals<readonly ["serialize", "lane", "fail"]>;
                        readonly runtime: Schema.Literals<readonly ["delay-rebase", "stop-merge"]>;
                    }>>;
                    readonly strategy: Schema.Literals<readonly ["serialize", "lane", "fail"]>;
                    readonly runtime: Schema.Literals<readonly ["delay-rebase", "stop-merge"]>;
                    readonly priority: Schema.Int;
                    readonly generation: Schema.Int;
                }>>;
            }>>;
            readonly nodes: Schema.$Array<Schema.Struct<{
                readonly id: Schema.NonEmptyString;
                readonly kind: Schema.Literals<readonly ["step", "agent", "merge"]>;
                readonly key: Schema.brand<Schema.String, "@smthrs/keys/Key">;
                readonly material: Schema.Struct<{
                    readonly version: Schema.Literal<"flows/key-material/v2">;
                    readonly kind: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
                    readonly nondeterministic: Schema.optional<Schema.Literal<true>>;
                    readonly body: Schema.Unknown;
                    readonly inputs: Schema.$Array<Schema.Union<readonly [Schema.TaggedStruct<"Literal", {
                        readonly value: Schema.Unknown;
                    }>, Schema.TaggedStruct<"Ref", {
                        readonly from: Schema.NonEmptyString;
                        readonly path: Schema.$Array<Schema.String>;
                    }>, Schema.TaggedStruct<"Pending", {
                        readonly from: Schema.NonEmptyString;
                    }>]>>;
                    readonly layers: Schema.$Array<Schema.String>;
                    readonly capabilities: Schema.$Array<Schema.String>;
                    readonly effects: Schema.optional<Schema.Unknown>;
                    readonly placement: Schema.optional<Schema.Unknown>;
                }>;
                readonly effects: Schema.Struct<{
                    readonly reads: Schema.$Array<Schema.Union<readonly [Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                        readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                        readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                    }>]>, Schema.TaggedStruct<"Filegroup", {
                        readonly name: Schema.NonEmptyString;
                        readonly entries: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                            readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                            readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                        }>]>>;
                    }>]>>;
                    readonly writes: Schema.$Array<Schema.Union<readonly [Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                        readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                        readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                    }>, Schema.TaggedStruct<"TreeArtifact", {
                        readonly path: Schema.NonEmptyString;
                    }>]>, Schema.TaggedStruct<"Filegroup", {
                        readonly name: Schema.NonEmptyString;
                        readonly entries: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
                            readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
                            readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                        }>, Schema.TaggedStruct<"TreeArtifact", {
                            readonly path: Schema.NonEmptyString;
                        }>]>>;
                    }>]>>;
                    readonly removes: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
                    readonly boundaryMode: Schema.Literals<readonly ["hard", "expected"]>;
                }>;
                readonly dependsOn: Schema.$Array<Schema.NonEmptyString>;
                readonly conflicts: Schema.$Array<Schema.Struct<{
                    readonly with: Schema.NonEmptyString;
                    readonly paths: Schema.$Array<Schema.String>;
                    readonly strategy: Schema.Literals<readonly ["serialize", "lane", "fail"]>;
                    readonly runtime: Schema.Literals<readonly ["delay-rebase", "stop-merge"]>;
                }>>;
                readonly strategy: Schema.Literals<readonly ["serialize", "lane", "fail"]>;
                readonly runtime: Schema.Literals<readonly ["delay-rebase", "stop-merge"]>;
                readonly priority: Schema.Int;
                readonly generation: Schema.Int;
                readonly status: Schema.Literals<readonly ["cached", "run"]>;
            }>>;
            readonly graph: Schema.optional<Schema.Struct<{
                readonly edges: Schema.$Array<Schema.Struct<{
                    readonly from: Schema.NonEmptyString;
                    readonly to: Schema.NonEmptyString;
                    readonly reason: Schema.Literals<readonly ["value", "continuation", "failure", "conflict", "lane-merge"]>;
                }>>;
                readonly nodes: Schema.optional<Schema.$Array<Schema.Struct<{
                    readonly id: Schema.NonEmptyString;
                    readonly declaredAt: Schema.optionalKey<Schema.Struct<{
                        readonly path: Schema.NonEmptyString;
                        readonly line: Schema.Int;
                    }>>;
                }>>>;
                readonly sourceRevision: Schema.optional<Schema.NonEmptyString>;
            }>>;
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
        readonly input: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        readonly decision: Schema.Literals<readonly ["pending", "approved", "denied"]>;
    }>>;
    readonly nextCursor: Schema.optional<Schema.String>;
}>]>, Schema.Union<readonly [typeof RunNotFound, typeof PlanNotFound, typeof PlanDenied, typeof FlowNotFound, typeof PlanDigestMismatch, typeof EnvelopeMismatch, typeof ClaimLost, typeof CodeDrift, typeof AlreadyResolved, typeof InvalidInput, typeof Unauthorized, typeof Unavailable, typeof TransportError, typeof PersistenceError, typeof LaunchFailed, typeof NoMatchingWait, typeof import("./ControlError.vibe").CredentialConflict, typeof NotificationError]>, typeof ControlAuth, never>>;
/**
 * The call a boundary is authenticating, when it knows one: the procedure's
 * tag and the payload it was sent. An edge authenticating a socket upgrade
 * knows no call and passes none.
 *
 * @category models
 * @since 1.0.0
 */
export interface Call {
    readonly rpc: string;
    readonly payload: unknown;
}
/**
 * Header authenticator used by the control RPC boundary.
 *
 * `call` is present for an in-band RPC frame and absent at a transport edge.
 * An authenticator that grants everything ignores it; one that grants a
 * scope reads it, and admits an edge on the credential alone.
 *
 * @category models
 * @since 0.1.0
 */
export interface Authenticator {
    readonly authenticate: (headers: Readonly<Record<string, string>>, call?: Call | undefined) => Effect.Effect<typeof Principal.Type, Unauthorized>;
}
/**
 * Configuration for the single-token bearer authenticator.
 *
 * Every request carrying the configured token receives the same principal.
 * This is the intentionally small alpha trust boundary, not a per-user
 * authorization system.
 *
 * @category models
 * @since 0.1.0
 */
export interface BearerAuthOptions {
    readonly token: string;
    readonly principal: Omit<typeof Principal.Type, "stampedAt">;
    readonly now?: (() => number) | undefined;
}
/**
 * The bearer credential a request carries, or `undefined` when its
 * `Authorization` header is absent or is not a well-formed bearer scheme.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const bearerCredential: (headers: Readonly<Record<string, string>>) => string | undefined;
/**
 * Authenticates one shared bearer token and stamps its server-owned principal.
 * Missing, malformed, empty, and incorrect credentials all fail closed with
 * the same `Unauthorized` response.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const bearerAuthenticator: (options: BearerAuthOptions) => Authenticator;
/**
 * The first authenticator to accept a request answers for all of them. Each
 * is asked in order, and a request none accepts fails with the last refusal,
 * or with the plain `Unauthorized` when there is nothing to ask.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const anyAuthenticator: (authenticators: ReadonlyArray<Authenticator>) => Authenticator;
/**
 * Options for {@link layerAuth}.
 *
 * @category models
 * @since 1.0.0
 */
export interface AuthOptions {
    /**
     * The operators: the principals `List` and `Watch` show every run. Omitted,
     * every principal reads only the runs it launched. See {@link RunVisibility}.
     */
    readonly seesAllRuns?: ((principal: typeof Principal.Type) => boolean) | undefined;
}
/**
 * Provides `ControlAuth` from a transport-header authenticator, telling it
 * which procedure and payload each frame carries. Each authenticated call
 * also receives the {@link RunVisibility} rule for the principal it stamps.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerAuth: (authenticator: Authenticator, options?: AuthOptions) => Layer.Layer<ControlAuth, never, never>;
/**
 * Provides `ControlAuth` using one shared bearer token. Its one principal is
 * the operator and reads every run.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerBearerAuth: (options: BearerAuthOptions) => Layer.Layer<ControlAuth, never, never>;
/**
 * Permissive authentication middleware for tests and trusted in-process use.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerNoopAuth: (principal?: typeof Principal.Type) => Layer.Layer<ControlAuth, never, never>;
export {};
