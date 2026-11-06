/**
 * Plan construction shared by every `ControlRuntime` implementation.
 *
 * The plan digest is what an approval is bound to, so the memory runtime and
 * the durable runtime must compute it the same way or an approval taken on one
 * would not validate on the other. Keeping the construction here is what makes
 * that a compile-time fact rather than a convention.
 *
 * @since 0.1.0
 */
import type * as PersistedPlan from "@smthrs/plan/Plan";
import { Effect } from "effect";
import type { PlanInput } from "../../../../src/Control.ts";
import { CodeDrift } from "../../../../src/ControlError.ts";
import type { Envelope, FlowId, IdempotencyKey, PlanGraph, PlanNode, Principal, Receipt, RunId, RunSummary, SignalPayload } from "../../../../src/ControlSchema.ts";
/**
 * The drift between the code a run recorded and the code that would resume
 * it, or `undefined` when there is none. A run that recorded no digest (a flow
 * without one, or a row older than the field) is not checked for flow drift,
 * and one that recorded no engine version is not checked for engine drift.
 *
 * @since 1.0.0
 * @private
 */
export declare const codeDriftOf: (run: RunSummary, flow: {
    readonly executionDigest?: string | undefined;
} | undefined, engineVersion: string | undefined) => CodeDrift | undefined;
/**
 * The code identity a resume the operator allowed to drift records on the run,
 * so later checks compare against the code it now runs.
 *
 * @since 1.0.0
 * @private
 */
export declare const adoptedCode: (run: RunSummary, flow: {
    readonly executionDigest?: string | undefined;
} | undefined, engineVersion: string | undefined) => Pick<RunSummary, "executionDigest" | "engineVersion">;
/**
 * The envelope a flow with no declared capabilities carries.
 *
 * @since 0.1.0
 * @private
 */
export declare const emptyEnvelope: Envelope;
/**
 * Canonical bytes for a value.
 * Throws on a non-serializable value; every caller either wraps it in
 * `Effect.try` or has already validated the value.
 *
 * @since 0.1.0
 * @private
 */
export declare const canonical: (value: unknown) => string;
/**
 * A signal admission's immutable intent, excluding the principal's retry clock.
 *
 * @since 1.0.0
 * @private
 */
export declare const signalCommandFingerprint: (runId: RunId, signal: SignalPayload, principal?: Principal) => string;
/**
 * The durable key a caller's idempotency key is stored under.
 *
 * Namespaced by the effective actor: the submitted principal, or the runtime's
 * configured fallback when the caller named none. The principal's clock is
 * omitted, so an equal retry lands on the same key.
 *
 * @since 0.1.0
 * @private
 */
export declare const mutationKey: (operation: string, key: IdempotencyKey, principal: Pick<Principal, "id" | "kind">) => string;
/**
 * The content digest of a value's canonical bytes.
 *
 * @since 0.1.0
 * @private
 */
export declare const digest: (value: unknown) => Effect.Effect<string & import("effect/Brand").Brand<"@smthrs/crypto/Sha256/Digest">, never, import("@smthrs/crypto/Crypto").Crypto>;
/**
 * Envelope equality by canonical bytes, not by reference or key order.
 *
 * @since 0.1.0
 * @private
 */
export declare const sameEnvelope: (left: Envelope, right: Envelope) => boolean;
/**
 * A flow's envelope with a planner's budget fields laid over its declared ones.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export declare const budgeted: (envelope: Envelope, budget: Envelope["budget"] | undefined) => Envelope;
/**
 * What one plan request asks for, for idempotency: a key replayed with another
 * budget is another plan.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export declare const planFingerprint: (input: PlanInput) => string;
/**
 * An accepted receipt, carrying a run id when one exists.
 *
 * @since 0.1.0
 * @private
 */
export declare const accepted: (receiptId: string, runId?: RunId) => Receipt;
/**
 * The receipt a replayed mutation returns, derived from the recorded one.
 *
 * @since 0.1.0
 * @private
 */
export declare const alreadyApplied: (key: IdempotencyKey, receipt: Receipt) => Receipt;
/**
 * The plan inputs a card is derived from.
 *
 * @since 0.1.0
 * @private
 */
export interface PlanSource {
    readonly planId: string;
    readonly flowId: FlowId;
    readonly decodedInput: unknown;
    readonly envelope: Envelope;
    readonly deployClass: boolean;
    readonly executionDigest?: string | undefined;
    /** The persisted plan value and cache verdicts produced by the host. */
    readonly handoff?: {
        readonly plan: PersistedPlan.Plan;
        readonly statuses?: Readonly<Record<string, PlanNode["status"]>> | undefined;
        readonly graph?: PlanGraph | undefined;
    } | undefined;
    readonly idempotencyKey?: IdempotencyKey | undefined;
}
/**
 * Builds the immutable plan card and the approval target bound to its digest.
 *
 * @since 0.1.0
 * @private
 */
export declare const planCard: (source: PlanSource) => Effect.Effect<{
    planId: string;
    flowId: string;
    digest: string & import("effect/Brand").Brand<"@smthrs/crypto/Sha256/Digest">;
    inputSummary: string;
    envelope: {
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
    deployClass: boolean;
    executionDigest?: string;
    plan?: {
        readonly planId: string;
        readonly flow: string;
        readonly generation: number;
        readonly baseDigest: string & import("effect/Brand").Brand<"@smthrs/keys/Key">;
        readonly digest: string & import("effect/Brand").Brand<"@smthrs/keys/Key">;
        readonly nodes: readonly {
            readonly id: string;
            readonly kind: "agent" | "merge" | "step";
            readonly key: string & import("effect/Brand").Brand<"@smthrs/keys/Key">;
            readonly material: {
                readonly version: "flows/key-material/v2";
                readonly kind: "compensable" | "irreversible" | "sealed";
                readonly nondeterministic?: true | undefined;
                readonly body: unknown;
                readonly inputs: readonly ({
                    readonly _tag: "Literal";
                    readonly value: unknown;
                } | {
                    readonly _tag: "Pending";
                    readonly from: string;
                } | {
                    readonly _tag: "Ref";
                    readonly from: string;
                    readonly path: readonly string[];
                })[];
                readonly layers: readonly string[];
                readonly capabilities: readonly string[];
                readonly effects?: unknown;
                readonly placement?: unknown;
            };
            readonly effects: {
                readonly reads: readonly (string | {
                    readonly _tag: "Filegroup";
                    readonly name: string;
                    readonly entries: readonly (string | {
                        readonly _tag: "Glob";
                        readonly include: readonly [string, ...string[]];
                        readonly exclude?: readonly string[] | undefined;
                    })[];
                } | {
                    readonly _tag: "Glob";
                    readonly include: readonly [string, ...string[]];
                    readonly exclude?: readonly string[] | undefined;
                })[];
                readonly writes: readonly (string | {
                    readonly _tag: "Filegroup";
                    readonly name: string;
                    readonly entries: readonly (string | {
                        readonly _tag: "TreeArtifact";
                        readonly path: string;
                    } | {
                        readonly _tag: "Glob";
                        readonly include: readonly [string, ...string[]];
                        readonly exclude?: readonly string[] | undefined;
                    })[];
                } | {
                    readonly _tag: "TreeArtifact";
                    readonly path: string;
                } | {
                    readonly _tag: "Glob";
                    readonly include: readonly [string, ...string[]];
                    readonly exclude?: readonly string[] | undefined;
                })[];
                readonly removes?: readonly string[] | undefined;
                readonly boundaryMode: "expected" | "hard";
            };
            readonly dependsOn: readonly string[];
            readonly conflicts: readonly {
                readonly with: string;
                readonly paths: readonly string[];
                readonly strategy: "fail" | "lane" | "serialize";
                readonly runtime: "delay-rebase" | "stop-merge";
            }[];
            readonly strategy: "fail" | "lane" | "serialize";
            readonly runtime: "delay-rebase" | "stop-merge";
            readonly priority: number;
            readonly generation: number;
        }[];
    };
    nodes: readonly {
        readonly id: string;
        readonly kind: "agent" | "merge" | "step";
        readonly key: string & import("effect/Brand").Brand<"@smthrs/keys/Key">;
        readonly material: {
            readonly version: "flows/key-material/v2";
            readonly kind: "compensable" | "irreversible" | "sealed";
            readonly nondeterministic?: true | undefined;
            readonly body: unknown;
            readonly inputs: readonly ({
                readonly _tag: "Literal";
                readonly value: unknown;
            } | {
                readonly _tag: "Pending";
                readonly from: string;
            } | {
                readonly _tag: "Ref";
                readonly from: string;
                readonly path: readonly string[];
            })[];
            readonly layers: readonly string[];
            readonly capabilities: readonly string[];
            readonly effects?: unknown;
            readonly placement?: unknown;
        };
        readonly effects: {
            readonly reads: readonly (string | {
                readonly _tag: "Filegroup";
                readonly name: string;
                readonly entries: readonly (string | {
                    readonly _tag: "Glob";
                    readonly include: readonly [string, ...string[]];
                    readonly exclude?: readonly string[] | undefined;
                })[];
            } | {
                readonly _tag: "Glob";
                readonly include: readonly [string, ...string[]];
                readonly exclude?: readonly string[] | undefined;
            })[];
            readonly writes: readonly (string | {
                readonly _tag: "Filegroup";
                readonly name: string;
                readonly entries: readonly (string | {
                    readonly _tag: "TreeArtifact";
                    readonly path: string;
                } | {
                    readonly _tag: "Glob";
                    readonly include: readonly [string, ...string[]];
                    readonly exclude?: readonly string[] | undefined;
                })[];
            } | {
                readonly _tag: "TreeArtifact";
                readonly path: string;
            } | {
                readonly _tag: "Glob";
                readonly include: readonly [string, ...string[]];
                readonly exclude?: readonly string[] | undefined;
            })[];
            readonly removes?: readonly string[] | undefined;
            readonly boundaryMode: "expected" | "hard";
        };
        readonly dependsOn: readonly string[];
        readonly conflicts: readonly {
            readonly with: string;
            readonly paths: readonly string[];
            readonly strategy: "fail" | "lane" | "serialize";
            readonly runtime: "delay-rebase" | "stop-merge";
        }[];
        readonly strategy: "fail" | "lane" | "serialize";
        readonly runtime: "delay-rebase" | "stop-merge";
        readonly priority: number;
        readonly generation: number;
        readonly status: "cached" | "run";
    }[];
    graph?: {
        readonly edges: readonly {
            readonly from: string;
            readonly to: string;
            readonly reason: "conflict" | "continuation" | "failure" | "lane-merge" | "value";
        }[];
        readonly nodes?: readonly {
            readonly id: string;
            readonly declaredAt?: {
                readonly path: string;
                readonly line: number;
            };
        }[] | undefined;
        readonly sourceRevision?: string | undefined;
    };
    approval: {
        target: {
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
        scope: "run";
        idempotencyKey: string;
    };
}, never, import("@smthrs/crypto/Crypto").Crypto>;
