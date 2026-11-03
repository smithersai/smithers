/**
 * Short-lived OAuth access tokens minted from a stored refresh token.
 *
 * A provider that speaks OAuth 2.0 (a hosted API) hands out a
 * long-lived refresh token once, at consent, and expects the client to trade
 * it for an access token that expires within the hour. This module is that
 * trade, behind the {@link AccessTokenSource} every client already asks for a
 * bearer token:
 *
 * - **Caching.** A minted token is reused until its `expires_in` minus a skew,
 *   so a burst of calls costs one exchange. Concurrent callers share one
 *   refresh rather than racing the token endpoint.
 * - **Invalidation.** A client that receives a 401 calls `invalidate`; the next
 *   `token` mints a fresh one even if the clock says the old one is still
 *   good.
 * - **Rotation.** A provider may answer a refresh with a new refresh token and
 *   retire the old one. The new one is persisted with a compare-and-set against
 *   the value this source exchanged: through the control-plane `Credential`
 *   boundary with {@link credentialStore}, whose `rotate` compares the stored
 *   secret and writes over the version it compared in one step, so a writer in
 *   any process that commits first wins and this source keeps its token.
 * - **Recovery.** Independent sources sharing one credential can both present
 *   the same refresh token, and a rotating provider refuses the second with
 *   `invalid_grant`. The loser re-reads the stored token once and fails
 *   `retryable`: with `retryAfterMillis: 0` when the stored token has already
 *   changed, so another attempt presents it at once, and with
 *   {@link ROTATION_SETTLE_MS} when it has not, because the winner may still be
 *   persisting its rotation. The source never repeats an exchange itself: the
 *   flow engine's retry policy, around the step that asked for the token,
 *   decides whether there is another attempt, durably, and a step's bounded
 *   attempts are what end a grant that is genuinely revoked.
 * - **Classification.** No stored refresh token or no credential storage is
 *   `credentials-missing`; `invalid_grant` (revoked, expired, or reused grant)
 *   and a refused credential are `permission-denied`; a rejected client id or
 *   secret is `invalid-config`; a 429, a 5xx and a lost connection are
 *   `delivery-failed`, `retryable` when the grant may be presented again, with
 *   the server's `Retry-After` as `retryAfterMillis`.
 *
 * Tokens never leave this module except as `Redacted` values and the
 * `Authorization` header or form body of the one request that needs them.
 * Every error is built by removing the refresh token, the client secret and
 * any minted access token from its text first, and a redirect from the token
 * endpoint is refused rather than followed, so a moved endpoint cannot receive
 * the form body.
 *
 * The token request goes through the `HttpClient` in context, which the caller
 * provides through a layer, usually `FetchHttpClient.layer` from
 * `effect/http`. The client sets the fetch transport's `redirect` to
 * `"manual"` and sends no `b3` or `traceparent` header.
 *
 * @since 1.0.0
 */
import type { Credential, CredentialRef } from "@smthrs/control/Credential";
import { Duration, Effect, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type { AccessTokenSource } from "./AccessToken.vibe";
import { IntegrationError } from "../../../../src/core/IntegrationError.ts";
/**
 * How long before its stated expiry a cached token counts as stale.
 *
 * A token that expires while its request is in flight fails with a 401, so a
 * token is replaced a minute early rather than used to its last second.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const DEFAULT_SKEW: Duration.Duration;
/**
 * The default deadline for one token-endpoint attempt, headers and body.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const DEFAULT_REQUEST_TIMEOUT: Duration.Duration;
/**
 * How long after a refused refresh another attempt should re-read the stored
 * token, in milliseconds, when it has not changed yet: the source that won the
 * exchange may still be persisting its rotation when the loser's refusal
 * arrives.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const ROTATION_SETTLE_MS = 500;
/**
 * Where a refresh token is kept, with compare-and-set replacement.
 *
 * @category models
 * @since 1.0.0
 */
export interface RefreshTokenStore {
    /** The current refresh token. */
    readonly load: Effect.Effect<Redacted.Redacted<string>, IntegrationError>;
    /**
     * Replaces `previous` with `next` only when the stored token is still
     * `previous`. Answers `false`, without writing, when another writer got
     * there first.
     */
    readonly replace: (previous: Redacted.Redacted<string>, next: Redacted.Redacted<string>) => Effect.Effect<boolean, IntegrationError>;
}
/**
 * A process-local store seeded with one refresh token.
 *
 * For a token supplied through configuration or the environment. A rotation
 * is kept for the life of the process only: nothing can persist it, so a
 * provider that rotates refresh tokens needs {@link credentialStore}.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const memoryStore: (initial: Redacted.Redacted<string>) => RefreshTokenStore;
/**
 * A store backed by the control-plane credential boundary.
 *
 * The credential's secret is the refresh token itself. `load` resolves it, so
 * the host's `authorize` policy decides whether the calling principal may use
 * it; `replace` is `rotate` with `expected: previous`, which compares the
 * stored secret and writes over the version it compared, answering any other
 * writer's earlier commit with `CredentialConflict`, reported here as `false`.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const credentialStore: (credential: Credential, reference: CredentialRef) => RefreshTokenStore;
/**
 * How the client authenticates to the token endpoint.
 *
 * `body` sends `client_id` and `client_secret` as form fields, which is what
 * Google documents. `basic` sends them as an RFC 6749 §2.3.1 `Authorization:
 * Basic` header, which X requires of a confidential client. A client with no
 * secret is a public client and sends only `client_id`, whichever is chosen.
 *
 * @category models
 * @since 1.0.0
 */
export type ClientAuthentication = "body" | "basic";
/**
 * The token endpoint and client identity shared by every exchange.
 *
 * @category models
 * @since 1.0.0
 */
export interface Endpoint {
    /** An absolute `http:` or `https:` token endpoint URL. */
    readonly tokenUrl: string;
    readonly clientId: string;
    readonly clientSecret?: Redacted.Redacted<string> | undefined;
    /** Defaults to `body`. */
    readonly clientAuthentication?: ClientAuthentication | undefined;
    /** A name for messages, such as `Google`. Defaults to `OAuth`. */
    readonly provider?: string | undefined;
    /** Deadline for one request, headers and body. Defaults to 30 seconds. */
    readonly requestTimeout?: Duration.Input | undefined;
}
/**
 * What {@link make} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options extends Endpoint {
    readonly refreshToken: RefreshTokenStore;
    /** Narrows the refreshed token to these scopes. Omitted keeps the granted set. */
    readonly scopes?: ReadonlyArray<string> | undefined;
    /** How early a cached token is replaced. Defaults to {@link DEFAULT_SKEW}. */
    readonly skew?: Duration.Input | undefined;
}
/**
 * One successful token-endpoint answer.
 *
 * @category models
 * @since 1.0.0
 */
export interface Grant {
    readonly accessToken: Redacted.Redacted<string>;
    /** Seconds until the access token expires, or `null` when the provider did not say. */
    readonly expiresInSeconds: number | null;
    /** A refresh token the provider issued with this answer, or `null`. */
    readonly refreshToken: Redacted.Redacted<string> | null;
    /** The granted scopes, space separated, when the provider reported them. */
    readonly scope: string | null;
}
/**
 * The classification an OAuth `error` code maps to.
 *
 * `invalid_grant` is a revoked, expired or already-rotated refresh token, or a
 * used authorization code: the grant itself is gone and only a new consent
 * restores it. `invalid_client` is a client id or secret the endpoint does not
 * accept, which is configuration. GitHub names the same cases its own way:
 * `bad_verification_code` and `bad_refresh_token` are a used or expired code
 * or refresh token, and `incorrect_client_credentials` and
 * `redirect_uri_mismatch` are configuration. Anything else a 400 or 401
 * carries is reported as a refused delivery.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const reasonForOAuthError: (code: string) => IntegrationError["reason"];
/**
 * What {@link exchangeRefreshToken} needs beyond the endpoint.
 *
 * @category models
 * @since 1.0.0
 */
export interface RefreshExchange extends Endpoint {
    /** The refresh token to present, once. */
    readonly refreshToken: Redacted.Redacted<string>;
    /** Narrows the refreshed token to these scopes. Omitted keeps the granted set. */
    readonly scopes?: ReadonlyArray<string> | undefined;
}
/**
 * Trades one refresh token for a new grant, once, and returns the whole grant.
 *
 * For a host that keeps refresh tokens of its own, such as one per signed-in
 * person, and persists a rotation itself; {@link make} is the cached source
 * over one stored token. A provider that rotates refresh tokens may already
 * have redeemed this one when the answer is lost (GitHub's are single-use), so
 * a 5xx or a lost connection says the outcome is unknown. A rate limit is
 * `retryable`, with the server's `retryAfterMillis`, because a refused request
 * redeemed nothing. The exchange is made once: a step's retry policy repeats
 * it. A used, expired or revoked refresh token is `permission-denied`.
 *
 * The request goes through the `HttpClient` in context.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const exchangeRefreshToken: (exchange: RefreshExchange) => Effect.Effect<Grant, IntegrationError, HttpClient.HttpClient>;
/**
 * What {@link exchangeCode} needs beyond the endpoint.
 *
 * @category models
 * @since 1.0.0
 */
export interface CodeExchange extends Endpoint {
    /** The authorization code the redirect delivered. */
    readonly code: Redacted.Redacted<string>;
    /** The same redirect URI the authorization request named. */
    readonly redirectUri: string;
    /** The PKCE verifier, when the authorization request carried a challenge. */
    readonly codeVerifier?: Redacted.Redacted<string> | undefined;
}
/**
 * Redeems an authorization code for the first access and refresh tokens.
 *
 * This finishes the consent flow `AuthorizationUrl` and `Pkce` start; the host
 * stores the returned refresh token with `Credential.create`. A code is
 * single-use, so a 5xx or a lost connection is not `retryable`: the provider
 * may have redeemed it and lost the answer, and the failure says the outcome
 * is unknown. A rate limit is `retryable`, with the server's
 * `retryAfterMillis`, because a refused request redeemed nothing. The exchange
 * is made once: a step's retry policy repeats it.
 *
 * The request goes through the `HttpClient` in context; provide
 * `FetchHttpClient.layer` from `effect/http`, or a client of your own.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const exchangeCode: (exchange: CodeExchange) => Effect.Effect<Grant, IntegrationError, HttpClient.HttpClient>;
/**
 * An access-token source that refreshes from `options.refreshToken`, over the
 * `HttpClient` in context.
 *
 * Validates the endpoint and bounds up front, failing with a typed
 * `IntegrationError`: `invalid-config` for a malformed URL or bound, and
 * `credentials-missing` for a missing client id. Provide the `HttpClient` with
 * `FetchHttpClient.layer` from `effect/http`, or a client of your own.
 *
 * A grant without `expires_in` is used for the call that minted it and not
 * cached, since nothing says how long it lives.
 *
 * @example
 * ```ts
 * import { Core } from "@smthrs/integrations"
 * import { Effect, Redacted } from "effect"
 * import { FetchHttpClient } from "effect/http"
 *
 * const token = Effect.gen(function*() {
 *   const source = yield* Core.OAuthToken.make({
 *     tokenUrl: "https://oauth2.googleapis.com/token",
 *     clientId: "client-id",
 *     refreshToken: Core.OAuthToken.memoryStore(Redacted.make("refresh-token"))
 *   })
 *   return yield* source.token
 * }).pipe(Effect.provide(FetchHttpClient.layer))
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: (options: Options) => Effect.Effect<AccessTokenSource, IntegrationError, HttpClient.HttpClient>;
