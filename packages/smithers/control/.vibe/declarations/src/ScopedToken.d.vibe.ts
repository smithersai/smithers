/**
 * Scoped, expiring gateway tokens.
 *
 * A gateway's configured bearer credential grants everything the gateway
 * serves, for as long as it is configured. A scoped token is a grant the
 * holder of that credential mints for someone else: a closed list of
 * procedures, optionally confined to one run or one flow, and an expiry. It
 * is signed with HMAC-SHA256 under the bearer credential, so a gateway
 * verifies it with the key it already holds and stores nothing; rotating the
 * bearer credential revokes every token minted under it.
 *
 * The wire form is `smt1.<claims>.<signature>`, both parts unpadded base64url,
 * the claims a canonical JSON document. A token names procedures rather than
 * scope words so that what it authorizes is readable off the token itself and
 * does not change when a scope grows.
 *
 * Web Crypto does the signing, so the same module runs on Node, Bun, and in a
 * browser that holds a token.
 *
 * @since 1.0.0
 */
import { Effect } from "effect";
import { Unauthorized } from "./ControlError.vibe";
import { type Authenticator, type Call } from "./ControlRpcs.vibe";
import type { Principal } from "../../../src/ControlSchema.ts";
import { Claims } from "../../../src/ScopedToken.vibe.platform.js";
import type { Scope } from "../../../src/ScopedToken.vibe.platform.js";
export { Claims, mint, prefix, procedures, scopes } from "../../../src/ScopedToken.vibe.platform.js";
export type { MintOptions, Minted, Scope } from "../../../src/ScopedToken.vibe.platform.js";
/**
 * Every scope name, in the order {@link scopes} declares them.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const scopeNames: ReadonlyArray<Scope>;
/**
 * Whether a bearer credential is spelled as a scoped token.
 *
 * @category predicates
 * @since 1.0.0
 */
export declare const isScopedToken: (credential: string) => boolean;
/**
 * Verifies a token's signature and expiry under the key and returns its
 * claims. Every malformation, a wrong key, and an expired token all fail with
 * the same `Unauthorized`, so the token is not a parsing oracle.
 *
 * @param now the moment to judge `exp` against, in milliseconds
 * @category verification
 * @since 1.0.0
 */
export declare const verify: (key: string, token: string, now: number) => Effect.Effect<Claims, Unauthorized>;
/**
 * Whether verified claims authorize one call.
 *
 * The procedure must be named. A token confined to a run authorizes only a
 * call that names that run, and one confined to a flow only a call that names
 * that flow: a call that names neither, such as an unfiltered `List`, is
 * refused rather than widened. A flow-catalog `List` never names a run or
 * flow, because the server ignores its filters.
 *
 * @category verification
 * @since 1.0.0
 */
export declare const authorizes: (claims: Claims, call: Call) => boolean;
/**
 * What the scoped-token authenticator needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface AuthenticatorOptions {
    /** The verifying key: the gateway's configured bearer credential. */
    readonly key: string;
    /** The principal every valid scoped token is stamped as. */
    readonly principal: Omit<Principal, "stampedAt">;
    readonly now?: (() => number) | undefined;
}
/**
 * Authenticates a bearer credential spelled as a scoped token: the signature
 * and expiry always, and the procedure plus run or flow confinement whenever
 * the boundary knows which call it is guarding. An edge that authenticates an
 * upgrade knows no call, so it admits the socket and leaves each frame to the
 * in-band check.
 *
 * A credential that is not a scoped token is refused here; compose with
 * `ControlRpcs.bearerAuthenticator` through `ControlRpcs.anyAuthenticator`
 * to accept both.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const authenticator: (options: AuthenticatorOptions) => Authenticator;
