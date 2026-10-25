import { Core } from "@smthrs/integrations"
import { Cause, Clock, Config, Context, Duration, Effect, Layer, Metric, Option, Redacted, Schema } from "effect"
import { type HttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import {
  CALLBACK_ROUTE,
  DEVICE_PERSON_HEADER,
  NO_DEVICE_DATA,
  SESSION_ROUTE,
  type SessionState,
  SIGN_IN_FAILED_PARAM,
  SIGN_IN_ROUTE,
  SIGN_OUT_ROUTE,
} from "../src/features/auth/contract.ts"
import * as Actor from "./Actor.ts"
import { codeOf } from "./ErrorCode.ts"
import * as Flows from "./Flows.ts"
import { RevokeGitHubToken, revokeExecutionId } from "./flows/RevokeGitHubToken.ts"
import { GitHubAuth, type GitHubRefused, roleOf } from "./GitHubAuth.ts"
import * as HostedModel from "./HostedModel.ts"
import * as RunCredentials from "./RunCredentials.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as SessionStore from "./SessionStore.ts"

// Sign-in (docs/features/sign-in.md, decision 0008 phase 1): the Smithers GitHub App's user authorization, with PKCE
// S256 and `state` bound to the browser that started it, and a session per browser kept in Postgres behind a signed,
// HttpOnly cookie. Its routes run in ChatApi, and `sessions` is the `Sessions` layer every route reads who is asking
// from. The callback's writes (the person, the session) happen in its handler: a code is single-use and bound to its
// request, so a durable retry could not redeem it again (decision 0008, Consequences). Role checks after sign-in run
// as the durable flow `auth/RecheckRole`, which the host starts through `RoleChecks`. Signing a session out runs as the
// durable flow `auth/RevokeGitHubToken`, which ends the session and revokes its GitHub token: a route starts it through
// `Flows.FlowStarter` and answers only once the start is recorded.

/** The repository roles are read on when `GITHUB_REPOSITORY` is unset. */
export const DEFAULT_REPOSITORY = "smithersai/smithers"

/** How long a session lasts when `SESSION_MAX_AGE_DAYS` is unset. */
export const SESSION_MAX_AGE_DAYS = 30

/** How old a session's role may get before it is checked with GitHub again, when `ROLE_RECHECK_MINUTES` is unset. */
export const ROLE_RECHECK_MINUTES = 60

/** How long a sign-in may take, from the button to GitHub's callback. */
export const SIGN_IN_TTL_SECONDS = 600

/** Sign-in requests, by `route` (`sign_in`, `callback`, `sign_out`), `outcome` and `reason`. */
export const requests = Metric.counter("smithers_auth_requests", {
  description: "Sign-in requests, by route, outcome and reason",
  incremental: true,
})

/**
 * Starts `auth/RecheckRole` for a session without waiting for it. `generation` is the check it replaces, the session's
 * `role_checked_at` in epoch milliseconds: the host names the execution after the session and `generation`, so every
 * request that finds the same stale role starts the same check, and one check of a session runs at a time
 * (docs/features/sign-in.md#roles-and-role-checks).
 */
export class RoleChecks extends Context.Service<
  RoleChecks,
  { readonly start: (sessionId: string, generation: number) => Effect.Effect<void> }
>()("@smthrs/mvp/auth/RoleChecks") {}

/** A signed-in person as sign-in knows them: who is acting, and their GitHub login. */
export interface Signed {
  readonly actor: Actor.Actor
  readonly login: string
}

/** Sign-in's services when it is configured: what `auth/RecheckRole` needs, and the lifetimes. */
export interface Configured {
  readonly keys: SessionKeys.SessionKeys
  readonly github: GitHubAuth["Service"]
  readonly repository: string
  readonly maxAgeSeconds: number
  readonly recheckAfterMs: number
}

const positive = Schema.Int.check(Schema.isGreaterThan(0))
const repositoryName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))

/**
 * Reads sign-in's settings: `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `SESSION_SECRET`, `GITHUB_REPOSITORY`,
 * `SESSION_MAX_AGE_DAYS` and `ROLE_RECHECK_MINUTES`. `None` when the App's client or the secret isn't set, or the
 * secret is shorter than `SessionKeys.MIN_SECRET_LENGTH`: sign-in is off. `github` replaces the real GitHub App,
 * which is built over the `HttpClient` in context.
 */
export const configured = (github?: GitHubAuth["Service"]) =>
  Effect.gen(function* () {
    const clientId = yield* Config.option(Config.NonEmptyString("GITHUB_APP_CLIENT_ID"))
    const clientSecret = yield* Config.option(Config.Redacted("GITHUB_APP_CLIENT_SECRET"))
    const secret = yield* Config.option(Config.Redacted("SESSION_SECRET"))
    const repository = yield* Config.schema(repositoryName, "GITHUB_REPOSITORY").pipe(
      Config.withDefault(DEFAULT_REPOSITORY),
    )
    const maxAgeDays = yield* Config.schema(positive, "SESSION_MAX_AGE_DAYS").pipe(
      Config.withDefault(SESSION_MAX_AGE_DAYS),
    )
    const recheckMinutes = yield* Config.schema(positive, "ROLE_RECHECK_MINUTES").pipe(
      Config.withDefault(ROLE_RECHECK_MINUTES),
    )
    if (Option.isNone(clientId) || Option.isNone(clientSecret) || Option.isNone(secret)) {
      return Option.none<Configured>()
    }
    if (Redacted.value(secret.value).length < SessionKeys.MIN_SECRET_LENGTH) {
      yield* Effect.logError("auth.config").pipe(Effect.annotateLogs({ errorCode: "session_secret_too_short" }))
      return Option.none<Configured>()
    }
    return Option.some<Configured>({
      keys: yield* SessionKeys.make(secret.value),
      github: github ??
        (yield* GitHubAuth.pipe(
          Effect.provide(GitHubAuth.layer({ clientId: clientId.value, clientSecret: clientSecret.value })),
        )),
      repository,
      maxAgeSeconds: maxAgeDays * 24 * 60 * 60,
      recheckAfterMs: recheckMinutes * 60 * 1000,
    })
  })

/**
 * Where a request arrived: its origin, and whether it came over https. A Worker's request carries its whole URL; a
 * server that passes only the path arrives at http://localhost.
 */
const arrival = (request: HttpServerRequest.HttpServerRequest) => {
  const url = new URL(request.originalUrl, "http://localhost")
  return { url, origin: url.origin, secure: url.protocol === "https:" }
}

/**
 * The cookie names over https and plain http. `__Host-` pins a cookie to this host, with `Secure` and `Path=/`; a
 * browser drops a `Secure` cookie on plain http, so local development uses the plain names (mvp.md M-28).
 * `devSignedOut` says the local developer signed out, where sign-in isn't configured and a fallback is signed in;
 * `devPerson` names which of local development's people a browser is (`teammates`).
 */
const cookieNames = (secure: boolean) =>
  secure
    ? {
      session: "__Host-smithers_session",
      signIn: "__Host-smithers_sign_in",
      devSignedOut: "__Host-smithers_dev_signed_out",
      devPerson: "__Host-smithers_dev_person",
    }
    : {
      session: "smithers_session",
      signIn: "smithers_sign_in",
      devSignedOut: "smithers_dev_signed_out",
      devPerson: "smithers_dev_person",
    }

const cookieOptions = (secure: boolean, maxAge: Duration.Duration) =>
  ({ httpOnly: true, secure, sameSite: "lax", path: "/", maxAge }) as const

const noStore = { "cache-control": "no-store" }

/**
 * `value` when it is a path on this origin, else `/`: never a redirect to another site. A failed sign-in's
 * `?sign_in=failed` is dropped, so trying again from that page doesn't come back saying it failed.
 */
const returnPath = (value: string | null, origin: string) => {
  if (value === null || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/"
  const url = new URL(value, origin)
  url.searchParams.delete(SIGN_IN_FAILED_PARAM)
  return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : "/"
}

/** `path` with `?sign_in=failed`, for the browser to show that sign-in failed. */
const failedPath = (path: string, origin: string) => {
  const url = new URL(path, origin)
  url.searchParams.set(SIGN_IN_FAILED_PARAM, "failed")
  return `${url.pathname}${url.search}${url.hash}`
}

const encoder = new TextEncoder()
const sameString = (left: string, right: string) =>
  Core.Signature.constantTimeEqual(encoder.encode(left), encoder.encode(right))

/** The host couldn't record the start of a session's sign-out flow; `errorCode` is the host's code, or `conflict`. */
class SignOutNotStarted extends Schema.TaggedError<SignOutNotStarted>()("SignOutNotStarted", {
  errorCode: Schema.String,
}) {}

/**
 * Starts signing session `sessionId` out (docs/features/sign-in.md#signing-out): `auth/RevokeGitHubToken`, one
 * execution per session, so starting it again is a no-op. Waits only for the start to be recorded, never for the flow.
 */
const startSignOut = (sessionId: string) =>
  Effect.flatMap(
    Flows.FlowStarter,
    (starter) => starter.start(RevokeGitHubToken, { executionId: revokeExecutionId(sessionId), payload: { sessionId } }),
  ).pipe(
    Effect.mapError((error) =>
      new SignOutNotStarted({
        errorCode: error._tag === "@smthrs/mvp/flows/StartUnavailable" ? error.errorCode : "conflict",
      })
    ),
  )

/** Why a callback didn't sign anyone in; logged and counted, never shown beyond "Couldn't sign in." */
class CallbackFailed extends Schema.TaggedError<CallbackFailed>()("CallbackFailed", {
  reason: Schema.String,
  returnTo: Schema.optional(Schema.String),
  errorCode: Schema.optional(Schema.String),
}) {}

/**
 * Builds sign-in over `database`: `fetch` answers its four routes (`/api/auth/*`), and `sessions` provides
 * `Actor.Sessions` from the session cookie. Both need `RoleChecks` from the host, and `fetch` `Flows.FlowStarter`.
 * `options.github` replaces the real GitHub App (tests inject a faulty one); `options.fallback` is who is signed in
 * when sign-in isn't configured (local development's developer), else nobody. The fallback signs out and back in with
 * the dev signed-out cookie, never reaching GitHub. `options.teammates` are local development's other people: a
 * browser whose dev person cookie names one is signed in as them instead, so two people can share a laptop's app.
 */
export const make = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  options: {
    readonly github?: GitHubAuth["Service"]
    readonly fallback?: Signed
    readonly teammates?: Readonly<Record<string, Signed>>
    /** `HOSTED_MODEL_ENABLED`'s default: on only under `alchemy dev` (decision 0099). */
    readonly hostedModel?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const setup = yield* configured(options.github)
    // Whether the deployment's own model answers when no Admin set it (decision 0099); a value that doesn't parse is off.
    const hostedDefault = yield* HostedModel.hostedModelDefault(options.hostedModel).pipe(Effect.orElseSucceed(() => false))

    /** Logs and counts one request's outcome. */
    const record = (route: string, fields: Record<string, string | number>) =>
      Effect.andThen(
        Metric.update(
          Metric.withAttributes(requests, {
            route,
            outcome: String(fields.outcome),
            reason: String(fields.reason ?? "none"),
          }),
          1,
        ),
        Effect.logWithLevel(fields.outcome === "failed" || fields.outcome === "refused" ? "Warn" : "Info")(
          `auth.${route}`,
        ).pipe(Effect.annotateLogs(fields)),
      )

    /** The signed-in person behind a request, if any. Starts a role check when their role is stale. */
    const current = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (Option.isNone(setup)) {
        const names = cookieNames(arrival(request).secure)
        if (request.cookies[names.devSignedOut] !== undefined) return Option.none()
        const person = request.cookies[names.devPerson]
        const teammate = person === undefined || options.fallback === undefined
          ? undefined
          : Object.hasOwn(options.teammates ?? {}, person)
          ? options.teammates![person]
          : undefined
        return Option.fromNullishOr(teammate ?? options.fallback)
      }
      const { keys, recheckAfterMs } = setup.value
      const token = yield* keys.verify("session", request.cookies[cookieNames(arrival(request).secure).session])
      if (Option.isNone(token)) return Option.none()
      const live = yield* SessionStore.findLive(SessionKeys.digest(token.value)).pipe(
        Effect.provide(database),
        Effect.tapError((error) =>
          Effect.logError("auth.session").pipe(Effect.annotateLogs({ outcome: "error", errorCode: codeOf(error) }))
        ),
        Effect.mapError(() => new Actor.SessionsUnavailable()),
      )
      if (Option.isNone(live)) return Option.none()
      const now = yield* Clock.currentTimeMillis
      if (now - live.value.roleCheckedAt >= recheckAfterMs) {
        yield* (yield* RoleChecks).start(live.value.id, live.value.roleCheckedAt)
      }
      return Option.some<Signed>({
        actor: { subject: { kind: "person", id: live.value.personId }, role: live.value.role, session: live.value.id },
        login: live.value.login,
      })
    }).pipe(Effect.withSpan("auth.resolve"))

    /** `GET /api/auth/sign-in?return=<path>`: records the sign-in and sends the browser to GitHub. */
    const signIn = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
      if (Option.isNone(setup) && options.fallback !== undefined) {
        // Local development: the developer signs in again at once, back where they were.
        const { url, origin, secure } = arrival(request)
        yield* record("sign_in", { outcome: "signed_in", reason: "local_developer" })
        const back = returnPath(url.searchParams.get("return"), origin)
        return HttpServerResponse.redirect(back, { status: 303, headers: noStore }).pipe(
          HttpServerResponse.expireCookieUnsafe(cookieNames(secure).devSignedOut, cookieOptions(secure, Duration.zero)),
        )
      }
      if (Option.isNone(setup)) {
        yield* record("sign_in", { outcome: "failed", reason: "not_configured" })
        return HttpServerResponse.jsonUnsafe({ code: "not_configured" }, { status: 503, headers: noStore })
      }
      const { keys, github } = setup.value
      const { url, origin, secure } = arrival(request)
      const returnTo = returnPath(url.searchParams.get("return"), origin)
      const state = yield* keys.token
      const stateDigest = SessionKeys.digest(state)
      const pkce = yield* Core.Pkce.createPkcePair().pipe(Effect.orDie)
      const redirectUri = `${origin}${CALLBACK_ROUTE}`
      yield* SessionStore.beginAttempt({
        stateDigest,
        verifier: yield* keys.seal(Redacted.make(pkce.codeVerifier), {
          id: stateDigest,
          name: "pkce_verifier",
          version: 1,
        }),
        redirectUri,
        returnTo,
        ttlSeconds: SIGN_IN_TTL_SECONDS,
      }).pipe(Effect.provide(database))
      yield* record("sign_in", { outcome: "redirected" })
      return HttpServerResponse.redirect(
        github.authorizeUrl({ state, codeChallenge: pkce.codeChallenge, redirectUri }),
        { status: 302, headers: noStore },
      ).pipe(
        HttpServerResponse.setCookieUnsafe(
          cookieNames(secure).signIn,
          yield* keys.sign("sign_in", state),
          cookieOptions(secure, Duration.seconds(SIGN_IN_TTL_SECONDS)),
        ),
      )
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          record("sign_in", { outcome: "failed", reason: "error", errorCode: codeOf(Cause.squash(cause)) }),
          HttpServerResponse.empty({ status: 503, headers: noStore }),
        )
      ),
      Effect.withSpan("auth.sign_in"),
    )

    /** `GET /api/auth/callback?code&state`: GitHub's answer. Signs the browser in, or sends it back saying so. */
    const callback = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const { url, origin, secure } = arrival(request)
      const names = cookieNames(secure)
      const startedAt = yield* Clock.currentTimeMillis
      const outcome = yield* Effect.gen(function* () {
        if (request.method !== "GET") return yield* new CallbackFailed({ reason: "method" })
        if (Option.isNone(setup)) return yield* new CallbackFailed({ reason: "not_configured" })
        const { keys, github, repository, maxAgeSeconds } = setup.value
        const state = url.searchParams.get("state")
        const started = yield* keys.verify("sign_in", request.cookies[names.signIn])
        // The state must be the one this browser was given: a callback finished in another browser signs nobody in.
        if (state === null || Option.isNone(started) || !sameString(state, started.value)) {
          return yield* new CallbackFailed({ reason: "state_mismatch" })
        }
        const stateDigest = SessionKeys.digest(state)
        const attempt = yield* SessionStore.takeAttempt(stateDigest).pipe(
          Effect.provide(database),
          Effect.mapError((error) => new CallbackFailed({ reason: "database", errorCode: codeOf(error) })),
        )
        if (Option.isNone(attempt)) return yield* new CallbackFailed({ reason: "replayed" })
        const { returnTo, redirectUri, verifier, live } = attempt.value
        const failing = (reason: string) => new CallbackFailed({ reason, returnTo })
        if (!live) return yield* failing("expired")
        if (url.searchParams.get("error") !== null) return yield* failing("denied")
        const code = url.searchParams.get("code")
        if (code === null || code.length === 0) return yield* failing("invalid")
        const codeVerifier = yield* keys.open(verifier, { id: stateDigest, name: "pkce_verifier", version: 1 }).pipe(
          Effect.mapError(() => failing("unreadable")),
        )
        // Signing in again in this browser ends the session it held. Its sign-out flow is admitted first, before the
        // code is redeemed, so a start the host refuses fails the sign-in with nothing redeemed and the session kept.
        const previous = yield* keys.verify("session", request.cookies[names.session])
        const ending = Option.isNone(previous)
          ? Option.none<string>()
          : yield* SessionStore.signingOut(SessionKeys.digest(previous.value)).pipe(
            Effect.provide(database),
            Effect.mapError((error) => new CallbackFailed({ reason: "database", returnTo, errorCode: codeOf(error) })),
          )
        yield* Option.match(ending, {
          onNone: () => Effect.void,
          onSome: (sessionId) =>
            startSignOut(sessionId).pipe(
              Effect.mapError((error) =>
                new CallbackFailed({ reason: "sign_out_not_started", returnTo, errorCode: error.errorCode })
              ),
            ),
        })
        const fromGitHub = <A>(effect: Effect.Effect<A, GitHubRefused>) =>
          Effect.mapError(effect, (error) => failing(`${error.step}_${error.reason}`))
        const tokens = yield* fromGitHub(github.exchange({ code: Redacted.make(code), codeVerifier, redirectUri }))
        const user = yield* fromGitHub(github.user(tokens.accessToken))
        const role = roleOf(yield* fromGitHub(github.permission(tokens.accessToken, repository)))
        const sessionId = crypto.randomUUID()
        const token = yield* keys.token
        const seal = (value: Redacted.Redacted<string>, name: "github_access" | "github_refresh") =>
          keys.seal(value, { id: sessionId, name, version: 1 })
        const personId = yield* Effect.gen(function* () {
          const personId = yield* SessionStore.upsertPerson({
            id: crypto.randomUUID(),
            githubId: user.id,
            login: user.login,
          })
          yield* SessionStore.createSession({
            id: sessionId,
            tokenDigest: SessionKeys.digest(token),
            personId,
            role,
            access: yield* seal(tokens.accessToken, "github_access"),
            accessExpiresAt: tokens.expiresAt,
            refresh: tokens.refreshToken === null ? null : yield* seal(tokens.refreshToken, "github_refresh"),
            refreshDigest: tokens.refreshToken === null
              ? null
              : SessionKeys.digest(Redacted.value(tokens.refreshToken)),
            maxAgeSeconds,
          })
          // The session this browser held ends now, so it is refused at once; its admitted flow revokes its tokens.
          if (Option.isSome(ending)) yield* SessionStore.revoke({ id: ending.value }, "sign_out")
          return personId
        }).pipe(
          Effect.provide(database),
          Effect.mapError((error) => new CallbackFailed({ reason: "database", returnTo, errorCode: codeOf(error) })),
        )
        return { personId, role, returnTo, cookie: yield* keys.sign("session", token), maxAgeSeconds }
      }).pipe(
        // A bug: logged by its name, and the browser told sign-in failed.
        Effect.catchDefect((defect) =>
          Effect.fail(new CallbackFailed({ reason: "error", errorCode: codeOf(defect) }))
        ),
        Effect.result,
      )
      const durationMs = (yield* Clock.currentTimeMillis) - startedAt
      if (outcome._tag === "Success") {
        const { personId, role, returnTo, cookie, maxAgeSeconds } = outcome.success
        yield* record("callback", { outcome: "signed_in", personId, role: role ?? "none", durationMs })
        return HttpServerResponse.redirect(returnTo, { status: 303, headers: noStore }).pipe(
          HttpServerResponse.setCookieUnsafe(
            names.session,
            cookie,
            cookieOptions(secure, Duration.seconds(maxAgeSeconds)),
          ),
          HttpServerResponse.expireCookieUnsafe(names.signIn, cookieOptions(secure, Duration.zero)),
        )
      }
      const failure = outcome.failure
      yield* record("callback", {
        outcome: "failed",
        reason: failure.reason,
        durationMs,
        ...(failure.errorCode === undefined ? {} : { errorCode: failure.errorCode }),
      })
      return HttpServerResponse.redirect(failedPath(failure.returnTo ?? "/", origin), { status: 303, headers: noStore })
        .pipe(HttpServerResponse.expireCookieUnsafe(names.signIn, cookieOptions(secure, Duration.zero)))
    }).pipe(Effect.withSpan("auth.callback"))

    /** `POST /api/auth/sign-out`: ends this browser's session, from this site only. */
    const signOut = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
      const { origin, secure } = arrival(request)
      const names = cookieNames(secure)
      // SameSite=Lax keeps the cookie off a cross-site POST in current browsers. The request must also say it came from
      // this origin, which refuses one from an older browser or from another origin on this site (decision 0008 §8).
      const fromHere = request.headers.origin === undefined
        ? request.headers["sec-fetch-site"] === "same-origin"
        : request.headers.origin === origin
      if (!fromHere) {
        yield* record("sign_out", { outcome: "refused", reason: "cross_site" })
        return HttpServerResponse.empty({ status: 403, headers: noStore })
      }
      // Signing out ends the cookie's session and wipes the device: only a page bound to that person, or one that
      // opened none of the device's data (`@none`), may do it (src/device/identity.ts).
      const expected = request.headers[DEVICE_PERSON_HEADER]
      if (expected !== NO_DEVICE_DATA && (expected !== undefined || request.headers.cookie !== undefined)) {
        const owner = Option.isNone(setup)
          ? Option.map(yield* current, (signed) => signed.actor.subject.id)
          : yield* Effect.gen(function* () {
            const token = yield* setup.value.keys.verify("session", request.cookies[names.session])
            return Option.isNone(token) ? Option.none<string>() : yield* SessionStore.ownerOf(SessionKeys.digest(token.value)).pipe(Effect.provide(database))
          })
        if (Option.isSome(owner) && (expected === undefined || owner.value !== expected)) {
          yield* record("sign_out", { outcome: "refused", reason: expected === undefined ? "unbound" : "other_person" })
          return HttpServerResponse.empty({ status: 403, headers: noStore })
        }
      }
      const signedOut = HttpServerResponse.empty({ status: 204, headers: noStore }).pipe(
        HttpServerResponse.expireCookieUnsafe(names.session, cookieOptions(secure, Duration.zero)),
      )
      if (Option.isNone(setup) && options.fallback !== undefined) {
        // Local development: the developer stays signed out until they sign in again.
        yield* record("sign_out", { outcome: "signed_out", reason: "local_developer" })
        return signedOut.pipe(
          HttpServerResponse.setCookieUnsafe(
            names.devSignedOut,
            "1",
            cookieOptions(secure, Duration.days(SESSION_MAX_AGE_DAYS)),
          ),
        )
      }
      const token = Option.isNone(setup)
        ? Option.none<string>()
        : yield* setup.value.keys.verify("session", request.cookies[names.session])
      // A live session, or one that ended with GitHub tokens nothing revoked yet (its earlier sign-out never started its
      // flow), is signed out by the durable flow, admitted before anything changes: a start the host refuses is a 503
      // that leaves the session as it was, so signing out again can finish. Once admitted, the session ends here too,
      // so it is refused at once; the flow ends it again, which changes nothing, and revokes its GitHub token.
      const pending = Option.isNone(token)
        ? Option.none<string>()
        : yield* SessionStore.signingOut(SessionKeys.digest(token.value)).pipe(Effect.provide(database))
      if (Option.isSome(pending)) {
        yield* startSignOut(pending.value)
        yield* SessionStore.revoke({ id: pending.value }, "sign_out").pipe(Effect.provide(database))
      }
      yield* record("sign_out", { outcome: Option.isSome(pending) ? "signed_out" : "no_session" })
      return signedOut
    }).pipe(
      Effect.catchIf((error): error is SignOutNotStarted => error instanceof SignOutNotStarted, (error) =>
        Effect.as(
          record("sign_out", { outcome: "failed", reason: "not_started", errorCode: error.errorCode }),
          HttpServerResponse.empty({ status: 503, headers: noStore }),
        )),
      Effect.catchCause((cause) =>
        Effect.as(
          record("sign_out", { outcome: "failed", reason: "error", errorCode: codeOf(Cause.squash(cause)) }),
          HttpServerResponse.empty({ status: 503, headers: noStore }),
        )
      ),
      Effect.withSpan("auth.sign_out"),
    )

    /**
     * `GET /api/auth/session`: who this browser is signed in as, and, signed in, whether the deployment's own model
     * answers anyone (`hostedModel`). A setting Postgres can't read says it does: the endpoint refuses each call
     * itself, so the composer shows and the answer fails visibly rather than hiding chat.
     */
    const session = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
      const signed = yield* current
      const hostedModel = Option.isNone(signed) ? true : yield* HostedModel.enabled(hostedDefault).pipe(
        Effect.provide(database),
        Effect.catchCause((cause) =>
          Effect.as(record("session", { outcome: "failed", reason: "hosted_model", errorCode: codeOf(Cause.squash(cause)) }), true)
        ),
      )
      const state: SessionState = Option.isSome(signed)
        ? {
          signedIn: true,
          personId: signed.value.actor.subject.id,
          login: signed.value.login,
          role: signed.value.actor.role,
          hostedModel,
        }
        : { signedIn: false, available: Option.isSome(setup) || options.fallback !== undefined }
      return HttpServerResponse.jsonUnsafe(state, { status: 200, headers: noStore })
    }).pipe(
      Effect.catchTag("@smthrs/mvp/auth/SessionsUnavailable", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 503, headers: noStore }))),
      Effect.withSpan("auth.session"),
    )

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      switch (request.url.split("?")[0]) {
        case SIGN_IN_ROUTE:
          return yield* signIn
        case CALLBACK_ROUTE:
          return yield* callback
        case SIGN_OUT_ROUTE:
          return yield* signOut
        case SESSION_ROUTE:
          return yield* session
        default:
          return HttpServerResponse.empty({ status: 404 })
      }
    })

    /** `Actor.Sessions` from the session cookie, with the host's `RoleChecks` and what `database` needs. */
    // Run credentials (worker/RunCredentials.ts) are signed with sign-in's keys, under their own purpose. Without sign-in
    // configured, local development's people sign theirs with SESSION_SECRET when Alchemy bound one, so a credential
    // outlives the dev server reloading this Worker, and with a key the Worker draws when it starts otherwise.
    const devSecret = Option.isSome(setup)
      ? Option.none()
      : Option.filter(
        yield* Config.option(Config.Redacted("SESSION_SECRET")),
        (secret) => Redacted.value(secret).length >= SessionKeys.MIN_SECRET_LENGTH,
      )
    const runKeys = Option.isSome(setup)
      ? setup.value.keys
      : yield* SessionKeys.make(
        Option.isSome(devSecret)
          ? devSecret.value
          : Redacted.make(yield* Core.Pkce.createCodeVerifier(48).pipe(Effect.orDie)),
      )
    const local = [options.fallback, ...Object.values(options.teammates ?? {})]

    /** A credential's person as their session stands now: none once it ended, and with the role it has now. */
    const personOf = (claims: RunCredentials.Claims): Effect.Effect<Option.Option<Actor.Actor>, Actor.SessionsUnavailable, R> =>
      Option.isNone(setup)
        ? Effect.succeed(
          Option.fromNullishOr(local.find((signed) => signed?.actor.subject.id === claims.sub)).pipe(
            Option.map((signed) => ({ ...signed.actor, login: signed.login })),
          ),
        )
        : claims.sid === undefined
        ? Effect.succeedNone
        : SessionStore.findLiveById(claims.sid).pipe(
          Effect.provide(database),
          Effect.map(Option.filter((live) => live.personId === claims.sub)),
          Effect.map(Option.map((live): Actor.Actor => ({
            subject: { kind: "person", id: live.personId },
            role: live.role,
            session: live.id,
            login: live.login,
          }))),
          Effect.tapError((error) =>
            Effect.logError("auth.session").pipe(Effect.annotateLogs({ outcome: "error", errorCode: codeOf(error) }))
          ),
          Effect.mapError(() => new Actor.SessionsUnavailable()),
        )

    /**
     * `Actor.Sessions` and `RunCredentials`: a request carrying a run credential is that run's, and never falls back to
     * its cookie; any other is the person behind its session cookie.
     */
    const sessions = Layer.effectContext(
      Effect.map(Effect.context<RoleChecks | R>(), (context) => {
        const credentials = RunCredentials.make({
          keys: runKeys,
          person: (claims) => personOf(claims).pipe(Effect.provide(context)),
        })
        return Context.make(RunCredentials.RunCredentials, credentials).pipe(
          Context.add(
            Actor.Sessions,
            Actor.Sessions.of({
              resolve: RunCredentials.resolveWith(
                credentials,
                current.pipe(
                  Effect.map(Option.map((signed) => ({ ...signed.actor, login: signed.login }))),
                  Effect.provide(context),
                ),
              ),
            }),
          ),
        )
      }),
    )

    return { fetch, sessions, configured: setup }
  })
