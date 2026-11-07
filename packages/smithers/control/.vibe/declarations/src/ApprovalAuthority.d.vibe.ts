/**
 * Host-owned approval authority, separate from principal attribution and from
 * the permissions a workflow receives after approval.
 *
 * @since 1.0.0
 */
import { Effect, Schema } from "effect";
import { InvalidInput, type PersistenceError, Unauthorized } from "./ControlError.vibe";
import { type ApprovalTarget, GrantScope, type Principal } from "../../../src/ControlSchema.ts";
/**
 * An approval decision whose caller has already been authenticated by its host.
 * @category models
 * @since 1.0.0
 */
export interface Request {
    readonly principal: Principal;
    readonly target: ApprovalTarget;
    readonly decision: "approved" | "denied";
    readonly scope: GrantScope;
}
/**
 * A trusted host policy. Both refusals and unavailable policy storage fail
 * closed. Implementations must be bounded and safe inside a write transaction;
 * they must not recursively invoke Control or perform the gated work.
 * @category services
 * @since 1.0.0
 */
export interface Service {
    readonly authorize: (request: Request) => Effect.Effect<void, Unauthorized | PersistenceError>;
}
/**
 * An explicit delegation to one authenticated identity, not everyone whose
 * kind resembles a role. Scopes are exact, not implicitly hierarchical. A
 * delegation may approve only its listed scopes and may deny either target
 * kind it names (denial installs no grant).
 * Delegation is reusable: `scopes: ["once"]` permits once-scoped grants, not
 * one lifetime decision. Use a host policy for expiry or one-use delegation.
 * @category schemas
 * @since 1.0.0
 */
export declare const Delegation: Schema.Struct<{
    readonly principal: Schema.Struct<{
        readonly id: Schema.String;
        readonly kind: Schema.String;
    }>;
    readonly scopes: Schema.$Array<Schema.Literals<readonly ["once", "run", "remembered"]>>;
    readonly targets: Schema.$Array<Schema.Literals<readonly ["Plan", "Node"]>>;
}>;
/**
 * One explicit host-owned approval delegation.
 * @category models
 * @since 1.0.0
 */
export type Delegation = typeof Delegation.Type;
/**
 * Builds an immutable policy from explicit host configuration. Invalid
 * configuration is refused without including its contents in the error.
 * The caller's arrays and objects are not retained after acquisition.
 * @category constructors
 * @since 1.0.0
 */
export declare const make: (delegations: ReadonlyArray<Delegation>) => Effect.Effect<Service, InvalidInput>;
/**
 * Default trusted-local policy. Only the local operator identity is an
 * approver. A custom actor, gateway identity, or agent needs explicit host
 * delegation; setting Principal.kind is not itself an authorization. The
 * in-memory test adapter's `memory`/`test` identity is delegated only by that
 * adapter's own default policy, never here.
 * @category policies
 * @since 1.0.0
 */
export declare const local: Service;
