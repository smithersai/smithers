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

import type { Credential, CredentialRef } from "@smthrs/control/Credential"
import { Clock, Duration, Effect, Option, Redacted, Ref, Schema, Semaphore } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type { AccessTokenSource } from "./AccessToken.vibe"
import { forCredentials, retryAfterHeader, transportCause, webHeaders } from "./CredentialHttp.ts"
import { IntegrationError, isIntegrationError } from "./IntegrationError.ts"
import { redactedError } from "./RedactedError.ts"

/**
 * How long before its stated expiry a cached token counts as stale.
 *
 * A token that expires while its request is in flight fails with a 401, so a
 * token is replaced a minute early rather than used to its last second.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_SKEW: Duration.Duration = Duration.seconds(60)

/**
 * The default deadline for one token-endpoint attempt, headers and body.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_REQUEST_TIMEOUT: Duration.Duration = Duration.seconds(30)

/**
 * How long after a refused refresh another attempt should re-read the stored
 * token, in milliseconds, when it has not changed yet: the source that won the
 * exchange may still be persisting its rotation when the loser's refusal
 * arrives.
 *
 * @category constants
 * @since 1.0.0
 */
export const ROTATION_SETTLE_MS = 500

/**
 * Where a refresh token is kept, with compare-and-set replacement.
 *
 * @category models
 * @since 1.0.0
 */
export interface RefreshTokenStore {
  /** The current refresh token. */
  readonly load: Effect.Effect<Redacted.Redacted<string>, IntegrationError>
  /**
   * Replaces `previous` with `next` only when the stored token is still
   * `previous`. Answers `false`, without writing, when another writer got
   * there first.
   */
  readonly replace: (
    previous: Redacted.Redacted<string>,
    next: Redacted.Redacted<string>
  ) => Effect.Effect<boolean, IntegrationError>
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
export const memoryStore = (initial: Redacted.Redacted<string>): RefreshTokenStore => {
  let current = initial
  return {
    load: Effect.sync(() => current),
    replace: (previous, next) =>
      Effect.sync(() => {
        if (Redacted.value(current) !== Redacted.value(previous)) return false
        current = next
        return true
      })
  }
}

const credentialFailure = (reference: CredentialRef) => (error: { readonly _tag: string }): IntegrationError =>
  error._tag === "/control/Unauthorized"
    ? new IntegrationError(
      "permission-denied",
      `Credential ${reference.name} is not available to this caller.`,
      { credential: reference.name, retryable: false }
    )
    : new IntegrationError(
      "credentials-missing",
      `Credential ${reference.name} could not be read from credential storage.`,
      { credential: reference.name, retryable: false }
    )

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
export const credentialStore = (credential: Credential, reference: CredentialRef): RefreshTokenStore => {
  const load = credential.resolve(reference).pipe(Effect.mapError(credentialFailure(reference)))
  return {
    load,
    replace: (previous, next) =>
      credential.rotate(reference, next, { expected: previous }).pipe(
        Effect.as(true),
        Effect.catchTag("/control/CredentialConflict", () => Effect.succeed(false)),
        Effect.mapError(credentialFailure(reference))
      )
  }
}

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
export type ClientAuthentication = "body" | "basic"

/**
 * The token endpoint and client identity shared by every exchange.
 *
 * @category models
 * @since 1.0.0
 */
export interface Endpoint {
  /** An absolute `http:` or `https:` token endpoint URL. */
  readonly tokenUrl: string
  readonly clientId: string
  readonly clientSecret?: Redacted.Redacted<string> | undefined
  /** Defaults to `body`. */
  readonly clientAuthentication?: ClientAuthentication | undefined
  /** A name for messages, such as `Google`. Defaults to `OAuth`. */
  readonly provider?: string | undefined
  /** Deadline for one request, headers and body. Defaults to 30 seconds. */
  readonly requestTimeout?: Duration.Input | undefined
}

/**
 * What {@link make} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options extends Endpoint {
  readonly refreshToken: RefreshTokenStore
  /** Narrows the refreshed token to these scopes. Omitted keeps the granted set. */
  readonly scopes?: ReadonlyArray<string> | undefined
  /** How early a cached token is replaced. Defaults to {@link DEFAULT_SKEW}. */
  readonly skew?: Duration.Input | undefined
}

/**
 * One successful token-endpoint answer.
 *
 * @category models
 * @since 1.0.0
 */
export interface Grant {
  readonly accessToken: Redacted.Redacted<string>
  /** Seconds until the access token expires, or `null` when the provider did not say. */
  readonly expiresInSeconds: number | null
  /** A refresh token the provider issued with this answer, or `null`. */
  readonly refreshToken: Redacted.Redacted<string> | null
  /** The granted scopes, space separated, when the provider reported them. */
  readonly scope: string | null
}

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String)
})

const ErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String)
})

const decodeTokenResponse = Schema.decodeUnknownOption(TokenResponse)
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponse)

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
export const reasonForOAuthError = (code: string): IntegrationError["reason"] => {
  switch (code) {
    case "invalid_grant":
    case "unauthorized_client":
    case "invalid_scope":
    case "access_denied":
    case "bad_verification_code":
    case "bad_refresh_token":
      return "permission-denied"
    case "invalid_client":
    case "invalid_request":
    case "unsupported_grant_type":
    case "incorrect_client_credentials":
    case "redirect_uri_mismatch":
      return "invalid-config"
    default:
      return "delivery-failed"
  }
}

interface Resolved {
  readonly url: URL
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string> | undefined
  readonly authentication: ClientAuthentication
  readonly provider: string
  readonly timeout: Duration.Duration
}

const invalidConfig = (message: string, details: Record<string, unknown>): IntegrationError =>
  new IntegrationError("invalid-config", message, { ...details, retryable: false })

const resolveEndpoint = (endpoint: Endpoint): Resolved => {
  const provider = endpoint.provider ?? "OAuth"
  if (typeof endpoint.tokenUrl !== "string" || !URL.canParse(endpoint.tokenUrl)) {
    throw invalidConfig(`${provider} tokenUrl must be an absolute HTTP or HTTPS URL.`, { provider })
  }
  const url = new URL(endpoint.tokenUrl)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidConfig(`${provider} tokenUrl must be an absolute HTTP or HTTPS URL.`, { provider })
  }
  if (typeof endpoint.clientId !== "string" || endpoint.clientId.trim().length === 0) {
    throw new IntegrationError("credentials-missing", `${provider} OAuth client id is not configured.`, {
      provider,
      retryable: false
    })
  }
  const timeout = Option.getOrUndefined(Duration.fromInput(endpoint.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT))
  if (timeout === undefined || !Duration.isFinite(timeout) || Duration.toMillis(timeout) <= 0) {
    throw invalidConfig(`${provider} requestTimeout must be a finite, positive duration.`, {
      provider,
      requestTimeout: String(endpoint.requestTimeout)
    })
  }
  return {
    url,
    clientId: endpoint.clientId.trim(),
    clientSecret: endpoint.clientSecret,
    authentication: endpoint.clientAuthentication ?? "body",
    provider,
    timeout
  }
}

interface Answer {
  readonly status: number
  readonly headers: Headers
  readonly json: unknown
}

/**
 * One POST to the token endpoint, never repeated. A rate limit, and when the
 * grant can be presented again a 5xx or a lost connection, fails `retryable`
 * for the retry policy of the step that asked.
 *
 * `secrets` are the values the form carries; every error removes them first.
 */
const requestGrant = (
  http: HttpClient.HttpClient,
  endpoint: Resolved,
  form: Readonly<Record<string, string>>,
  secrets: ReadonlyArray<Redacted.Redacted<string>>,
  repeatable: boolean
): Effect.Effect<Grant, IntegrationError> => {
  const plain = secrets.map(Redacted.value)
  const secret = endpoint.clientSecret === undefined ? undefined : Redacted.value(endpoint.clientSecret)
  // Percent-encoding leaves only ASCII, which `btoa` encodes byte for byte.
  const basic = secret === undefined || endpoint.authentication !== "basic"
    ? undefined
    : btoa(`${encodeURIComponent(endpoint.clientId)}:${encodeURIComponent(secret)}`)
  const failure = redactedError([...plain, secret, basic])
  const provider = endpoint.provider
  const path = endpoint.url.pathname

  const body = new URLSearchParams(form)
  if (basic === undefined) {
    body.set("client_id", endpoint.clientId)
    if (secret !== undefined) body.set("client_secret", secret)
  }
  const headers: Record<string, string> = { accept: "application/json" }
  if (basic !== undefined) headers["authorization"] = `Basic ${basic}`
  const request = HttpClientRequest.post(endpoint.url, { headers }).pipe(
    HttpClientRequest.bodyText(body.toString(), "application/x-www-form-urlencoded")
  )
  const timeoutMs = Duration.toMillis(endpoint.timeout)
  const ambiguity = repeatable ? "" : " (outcome unknown: the grant was not presented again)"

  const parseBody = (text: string): unknown => {
    try {
      return text.length === 0 ? null : JSON.parse(text)
    } catch {
      return null
    }
  }

  // A redirect is answered, not followed: following a 307 would re-send the
  // form, secret included, to wherever the endpoint pointed. `http` does not
  // follow one, and a 3xx fails below as a refusal.
  const attempt: Effect.Effect<Answer, IntegrationError> = http.execute(request).pipe(
    Effect.flatMap((response) =>
      Effect.map(response.text, (text) => ({
        status: response.status,
        headers: webHeaders(response.headers),
        json: parseBody(text)
      }))
    ),
    // The transport's own message stays on the (redacted) cause.
    Effect.mapError((error) =>
      failure(
        "delivery-failed",
        `${provider} token request failed before an answer arrived${ambiguity}`,
        { provider, path, retryable: repeatable, outcomeUnknown: !repeatable },
        { cause: transportCause(error) }
      )
    ),
    Effect.timeoutOrElse({
      duration: endpoint.timeout,
      orElse: () =>
        Effect.fail(failure(
          "delivery-failed",
          `${provider} token request timed out after ${timeoutMs} ms${ambiguity}`,
          { provider, path, retryable: repeatable, outcomeUnknown: !repeatable, timedOut: true }
        ))
    })
  )

  const classify = (answer: Answer): Effect.Effect<Grant, IntegrationError> => {
    // GitHub answers a refused grant with 200 OK and an OAuth error body, so an
    // answer carrying `error` and no token is that refusal, whatever its status.
    const success = answer.status >= 200 && answer.status < 300 &&
      !(Option.isNone(decodeTokenResponse(answer.json)) && Option.isSome(decodeErrorResponse(answer.json)))
    if (success) {
      const decoded = decodeTokenResponse(answer.json)
      const expires = Option.isSome(decoded) ? Number(decoded.value.expires_in ?? Number.NaN) : Number.NaN
      if (
        Option.isNone(decoded) ||
        (decoded.value.token_type !== undefined && decoded.value.token_type.toLowerCase() !== "bearer") ||
        (decoded.value.expires_in !== undefined && !(Number.isFinite(expires) && expires >= 0))
      ) {
        return Effect.fail(failure(
          "decode-failed",
          `${provider} token response is not a bearer token grant.`,
          { provider, path, status: answer.status, retryable: false }
        ))
      }
      const value = decoded.value
      return Effect.succeed({
        accessToken: Redacted.make(value.access_token),
        expiresInSeconds: value.expires_in === undefined ? null : expires,
        refreshToken: value.refresh_token === undefined || value.refresh_token.length === 0
          ? null
          : Redacted.make(value.refresh_token),
        scope: value.scope ?? null
      })
    }
    const oauth = decodeErrorResponse(answer.json)
    const code = Option.isSome(oauth) ? oauth.value.error : null
    const described = Option.isSome(oauth) && oauth.value.error_description !== undefined
      ? `: ${oauth.value.error_description}`
      : ""
    const rateLimited = answer.status === 429
    const serverError = answer.status >= 500
    const retryable = rateLimited || (serverError && repeatable)
    const wait = rateLimited || serverError ? retryAfterHeader(answer.headers) : null
    const reason = code !== null && !rateLimited && !serverError ? reasonForOAuthError(code) : "delivery-failed"
    return Effect.fail(failure(
      reason,
      `${provider} token request refused: ${answer.status}${code === null ? "" : ` ${code}`}${described}${
        serverError && !repeatable ? ambiguity : ""
      }`,
      {
        provider,
        path,
        status: answer.status,
        oauthError: code,
        retryable,
        rateLimited,
        outcomeUnknown: serverError && !repeatable,
        ...(wait === null ? {} : { retryAfterMillis: wait })
      }
    ))
  }

  return attempt.pipe(
    Effect.flatMap(classify),
    Effect.withSpan("OAuthToken.request", { attributes: { "oauth.provider": provider } })
  )
}

/**
 * What {@link exchangeRefreshToken} needs beyond the endpoint.
 *
 * @category models
 * @since 1.0.0
 */
export interface RefreshExchange extends Endpoint {
  /** The refresh token to present, once. */
  readonly refreshToken: Redacted.Redacted<string>
  /** Narrows the refreshed token to these scopes. Omitted keeps the granted set. */
  readonly scopes?: ReadonlyArray<string> | undefined
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
export const exchangeRefreshToken = (
  exchange: RefreshExchange
): Effect.Effect<Grant, IntegrationError, HttpClient.HttpClient> =>
  Effect.all([
    Effect.service(HttpClient.HttpClient),
    Effect.try({ try: () => resolveEndpoint(exchange), catch: (cause) => cause as IntegrationError })
  ]).pipe(
    Effect.flatMap(([http, endpoint]) => {
      const form: Record<string, string> = {
        grant_type: "refresh_token",
        refresh_token: Redacted.value(exchange.refreshToken)
      }
      if (exchange.scopes !== undefined && exchange.scopes.length > 0) form["scope"] = exchange.scopes.join(" ")
      return requestGrant(forCredentials(http), endpoint, form, [exchange.refreshToken], false)
    })
  )

/**
 * What {@link exchangeCode} needs beyond the endpoint.
 *
 * @category models
 * @since 1.0.0
 */
export interface CodeExchange extends Endpoint {
  /** The authorization code the redirect delivered. */
  readonly code: Redacted.Redacted<string>
  /** The same redirect URI the authorization request named. */
  readonly redirectUri: string
  /** The PKCE verifier, when the authorization request carried a challenge. */
  readonly codeVerifier?: Redacted.Redacted<string> | undefined
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
export const exchangeCode = (
  exchange: CodeExchange
): Effect.Effect<Grant, IntegrationError, HttpClient.HttpClient> =>
  Effect.all([
    Effect.service(HttpClient.HttpClient),
    Effect.try({ try: () => resolveEndpoint(exchange), catch: (cause) => cause as IntegrationError })
  ]).pipe(
    Effect.flatMap(([http, endpoint]) => {
      const form: Record<string, string> = {
        grant_type: "authorization_code",
        code: Redacted.value(exchange.code),
        redirect_uri: exchange.redirectUri
      }
      const secrets = [exchange.code]
      if (exchange.codeVerifier !== undefined) {
        form["code_verifier"] = Redacted.value(exchange.codeVerifier)
        secrets.push(exchange.codeVerifier)
      }
      return requestGrant(forCredentials(http), endpoint, form, secrets, false)
    })
  )

interface Cached {
  readonly token: Redacted.Redacted<string>
  /** When the token stops being served from the cache, in Unix milliseconds. */
  readonly staleAtMs: number
}

// The source over `http`. Throws an IntegrationError for a bad config; `make`
// turns that into a typed failure.
const build = (options: Options, http: HttpClient.HttpClient): AccessTokenSource => {
  const endpoint = resolveEndpoint(options)
  const skew = Option.getOrUndefined(Duration.fromInput(options.skew ?? DEFAULT_SKEW))
  if (skew === undefined || !Duration.isFinite(skew) || Duration.toMillis(skew) < 0) {
    throw invalidConfig(`${endpoint.provider} skew must be a finite, non-negative duration.`, {
      provider: endpoint.provider,
      skew: String(options.skew)
    })
  }
  const skewMs = Duration.toMillis(skew)
  const scope = options.scopes === undefined || options.scopes.length === 0 ? undefined : options.scopes.join(" ")
  const cache = Ref.makeUnsafe<Option.Option<Cached>>(Option.none())
  const lock = Semaphore.makeUnsafe(1)

  const cached = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    return Option.filter(yield* Ref.get(cache), (entry) => now < entry.staleAtMs)
  })

  const exchange = (current: Redacted.Redacted<string>) => {
    const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: Redacted.value(current) }
    if (scope !== undefined) form["scope"] = scope
    return requestGrant(http, endpoint, form, [current], true).pipe(Effect.map((grant) => ({ current, grant })))
  }

  // `invalid_grant` for a token another source has since rotated is not a
  // revocation, but the source cannot tell the two apart without waiting, and
  // waiting belongs to the step's retry policy, which survives a crash. So the
  // refusal becomes retryable: at once when the stored token already changed,
  // after the settle time when it has not. The next attempt reads the store
  // again; a grant that really is revoked ends with the step's attempts.
  const rotationPending = (
    current: Redacted.Redacted<string>,
    error: IntegrationError
  ): Effect.Effect<never, IntegrationError> =>
    Effect.flatMap(options.refreshToken.load, (stored) => {
      const rotated = Redacted.value(stored) !== Redacted.value(current)
      return Effect.fail(
        new IntegrationError(
          error.reason,
          `${error.summary} (${
            rotated ? "the stored refresh token has rotated" : "the stored refresh token may still be rotating"
          }; another attempt presents it)`,
          { ...error.details, retryable: true, rotated, retryAfterMillis: rotated ? 0 : ROTATION_SETTLE_MS },
          { cause: error }
        )
      )
    })

  const refresh = Effect.gen(function*() {
    const { current, grant } = yield* Effect.flatMap(options.refreshToken.load, (current) =>
      exchange(current).pipe(
        Effect.catchIf((error) => error.details?.["oauthError"] === "invalid_grant", (error) =>
          rotationPending(current, error))
      ))
    const now = yield* Clock.currentTimeMillis
    if (grant.refreshToken !== null && Redacted.value(grant.refreshToken) !== Redacted.value(current)) {
      const replaced = yield* options.refreshToken.replace(current, grant.refreshToken)
      if (!replaced) {
        yield* Effect.logWarning(
          `${endpoint.provider} rotated the refresh token, but another refresher replaced the stored one first; keeping the stored token.`
        )
      }
    }
    yield* Ref.set(
      cache,
      grant.expiresInSeconds === null
        ? Option.none()
        : Option.some({ token: grant.accessToken, staleAtMs: now + grant.expiresInSeconds * 1000 - skewMs })
    )
    return grant.accessToken
  })

  const token = Effect.gen(function*() {
    const hit = yield* cached
    if (Option.isSome(hit)) return hit.value.token
    return yield* lock.withPermits(1)(Effect.gen(function*() {
      // Another caller may have refreshed while this one waited for the lock.
      const again = yield* cached
      return Option.isSome(again) ? again.value.token : yield* refresh
    }))
  }).pipe(Effect.withSpan("OAuthToken.token", { attributes: { "oauth.provider": endpoint.provider } }))

  return { token, invalidate: Ref.set(cache, Option.none()) }
}

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
export const make = (options: Options): Effect.Effect<AccessTokenSource, IntegrationError, HttpClient.HttpClient> =>
  Effect.flatMap(Effect.service(HttpClient.HttpClient), (http) =>
    Effect.suspend(() => {
      // A config error is a typed failure. Anything else build throws is a
      // defect and stays one.
      try {
        return Effect.succeed(build(options, forCredentials(http)))
      } catch (error) {
        if (isIntegrationError(error)) return Effect.fail(error)
        throw error
      }
    }))
