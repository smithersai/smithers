import { Effect, Schema } from "effect";
/**
 * The version prefix every scoped token starts with.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const prefix = "smt1";
/**
 * The scopes `smthrs token mint --scope` accepts, and the procedures each
 * one names.
 *
 * `read:runs` covers every read the control plane and the gateway serve.
 * `write:runs` covers the mutations that start, steer, signal, cancel, and
 * resume a run, and the gateway's `Run.Fork` and `Run.Verify`, which branch a
 * run or drive the project's flow code over a copy of it. `approve:runs` covers the approval decisions on both mounts.
 * A token holding `approve:runs` still needs the host's `ApprovalAuthority`
 * to delegate to its principal, exactly as the bearer does.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const scopes: {
    readonly "read:runs": readonly ["List", "Watch", "Projection.Snapshot", "Projection.Subscribe"];
    readonly "write:runs": readonly ["Plan", "Run", "Steer", "Signal", "Cancel", "Resume", "Run.Fork", "Run.Verify"];
    readonly "approve:runs": readonly ["Approve", "Deny", "Approval.Submit"];
};
/**
 * One scope name.
 *
 * @category models
 * @since 1.0.0
 */
export type Scope = keyof typeof scopes;
/**
 * What a token grants, as signed.
 *
 * @category models
 * @since 1.0.0
 */
export declare const Claims: Schema.Struct<{
    readonly v: Schema.Literal<1>;
    /** A random identifier, so two tokens with the same grant differ. */
    readonly id: Schema.String;
    readonly procedures: Schema.$Array<Schema.String>;
    readonly runId: Schema.optional<Schema.String>;
    readonly flowId: Schema.optional<Schema.String>;
    /** Minted at, milliseconds since the epoch. */
    readonly iat: Schema.Number;
    /** Expires at, milliseconds since the epoch; refused once `now >= exp`. */
    readonly exp: Schema.Number;
}>;
/**
 * What a token grants, as signed.
 *
 * @category models
 * @since 1.0.0
 */
export type Claims = typeof Claims.Type;
/**
 * What `mint` needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface MintOptions {
    /** The signing key: the gateway's configured bearer credential. */
    readonly key: string;
    readonly scopes: ReadonlyArray<Scope>;
    /** How long the token lives, in milliseconds; must be positive. */
    readonly ttlMillis: number;
    /** Confine every call to this run. */
    readonly runId?: string | undefined;
    /** Confine every call to this flow. */
    readonly flowId?: string | undefined;
    readonly now?: (() => number) | undefined;
}
/**
 * A minted token beside the claims it carries.
 *
 * @category models
 * @since 1.0.0
 */
export interface Minted {
    readonly token: string;
    readonly claims: Claims;
}
export declare const encoder: TextEncoder;
export declare const subtle: () => SubtleCrypto;
export declare const hmacKey: (key: string, usage: "sign" | "verify") => Promise<CryptoKey>;
/**
 * The procedures a list of scopes names, each once, in scope order.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const procedures: (names: ReadonlyArray<Scope>) => ReadonlyArray<string>;
/**
 * Mints one token under the key.
 *
 * An empty key, no scopes, or a non-positive lifetime is a caller defect: it
 * cannot produce a token anyone should hold, so it dies rather than signs.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const mint: (options: MintOptions) => Effect.Effect<Minted>;
