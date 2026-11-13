import { Core, GitHub } from "@smthrs/integrations"
import { Cause, Clock, Config, Context, Duration, Effect, Exit, Layer, Metric, Option, Redacted, Ref, Schema } from "effect"
import { type HttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import { digestSync } from "@smthrs/crypto"
import {
  ACCEPTS_HEADER,
  ACCEPTS_CREDENTIAL_STALE,
  ARRIVE_ROUTE,
  CALLBACK_ROUTE,
  DEVICE_PERSON_HEADER,
  CANCEL_HANDOFF,
  continueTo,
  handoffExplanation,
  handoffTitle,
  HANDOFF_ROUTE,
  NO_DEVICE_DATA,
  SESSION_ROUTE,
  type SessionState,
  SIGN_IN_FAILED_PARAM,
  SIGN_IN_ROUTE,
  SIGN_OUT_ROUTE,
} from "../src/features/auth/contract.ts"
import { installUrl } from "../src/features/repo/contract.ts"
import * as Actor from "./Actor.ts"
import * as BodyLimits from "./BodyLimits.ts"
import { DEFAULT_REPOSITORY } from "./defaultRepository.ts"
import * as Conversations from "./branch/Conversations.ts"
import { readBounded } from "./Body.ts"
import { HOSTNAME, parseAliases } from "./aliases.ts"
import * as Domains from "./domains/Store.ts"
import { codeOf } from "./ErrorCode.ts"
import * as Flows from "./Flows.ts"
import * as ReplacedTokens from "./flows/RevokeReplacedGitHubToken.ts"
import { RevokeGitHubToken, revokeExecutionId } from "./flows/RevokeGitHubToken.ts"
import { appSlug, GitHubAuth, type GitHubRefused, roleOf } from "./GitHubAuth.ts"
import * as HostedModel from "./HostedModel.ts"
import * as RunCredentials from "./RunCredentials.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as SessionStore from "./SessionStore.ts"
import * as SessionPrior from "./SessionPrior.ts"
import * as WriteAdmission from "./WriteAdmission.ts"

// Sign-in (docs/features/sign-in.md, decision 0008 phase 1): the Smithers GitHub App's user authorization, with PKCE
// S256 and `state` bound to the browser that started it, and a session per browser kept in Postgres behind a signed,
// HttpOnly cookie. Its routes run in ChatApi, and `sessions` is the `Sessions` layer every route reads who is asking
// from. The callback's writes (the person, the session) happen in its handler: a code is single-use and bound to its
// request, so a durable retry could not redeem it again (decision 0008, Consequences). Role checks after sign-in run
// as the durable flow `auth/RecheckRole`, which the host starts through `RoleChecks`. Signing a session out runs as the
// durable flow `auth/RevokeGitHubToken`, which ends the session and revokes its GitHub token: a route starts it through
// `Flows.FlowStarter` and answers only once the start is recorded.

export { DEFAULT_REPOSITORY }

/** How long a session lasts when `SESSION_MAX_AGE_DAYS` is unset. */
export const SESSION_MAX_AGE_DAYS = 30

/** How old a session's role may get before it is checked with GitHub again, when `ROLE_RECHECK_MINUTES` is unset. */
export const ROLE_RECHECK_MINUTES = SessionStore.ROLE_RECHECK_MINUTES

/** Renew five minutes before expiry (half the window for shorter configured receipts). */
export const ROLE_RECHECK_MARGIN_MS = 5 * 60_000

/** How often a session whose role GitHub hasn't confirmed lately starts another check, at most. */
export const UNCONFIRMED_RECHECK_MS = 60_000

/** Maximum wait to record a role-check start; the live session read can then answer. */
export const ROLE_CHECK_START_DEADLINE: Duration.Input = "1 second"

/** How long a sign-in may take, from the button to GitHub's callback. */
export const SIGN_IN_TTL_SECONDS = 600

/** How long a hand-off's code lives, from `APP_DOMAIN` minting it to the alias redeeming it (decision 0130). */
export const HANDOFF_CODE_TTL_SECONDS = 60

/** Sign-in requests, by `route` (`sign_in`, `callback`, `sign_out`, `session`), `outcome` and `reason`. */
export const requests = Metric.counter("smithers_auth_requests", {
  description: "Sign-in requests, by route, outcome and reason",
  incremental: true,
})

/** Identity-free credential outcomes are kept separate from route request counts. */
export const sessionOutcomes = Metric.counter("smithers_auth_session", { incremental: true })

/** A configured-key cookie for a re-keyed live row authenticates nobody, without asserting a session end. */
class CredentialStale extends Schema.TaggedError<CredentialStale>()("CredentialStale", {}) {}

/** One request shares its verified lookup, so routing never multiplies session reads or rejection records. */
class CookieReceipt extends Context.Service<CookieReceipt, {
  readonly live: Option.Option<SessionStore.Live>
  readonly lookupStarted: bigint
}>()("@smthrs/mvp/auth/CookieReceipt") {}

/**
 * Starts `auth/RecheckRole` for a session without waiting for it. `generation` is the check it replaces, the session's
 * `role_checked_at` in epoch milliseconds: the host names the execution after the session and `generation`, so every
 * request that finds the same stale role starts the same check, and one check of a session runs at a time
 * (docs/features/sign-in.md#roles-and-role-checks).
 */
export class RoleChecks extends Context.Service<
  RoleChecks,
  {
    readonly start: (sessionId: string, generation: number) => Effect.Effect<void>
    /** Advance the already-admitted durable check when an idle session first returns past expiry. */
    readonly wait?: (sessionId: string, generation: number) => Effect.Effect<void, unknown>
    readonly waitWithin?: Duration.Input
  }
>()("@smthrs/mvp/auth/RoleChecks") {}

/** A signed-in person as sign-in knows them: who is acting, and their GitHub login. */
export interface Signed {
  /** Identity retains the last observed role while protected reads await confirmation. */
  readonly roleConfirmed?: boolean
  readonly actor: Actor.Actor
  readonly login: string
  /**
   * The earliest known end of the presented session, epoch milliseconds, including an alias's own bound.
   * None for local development's people, who have no session.
   */
  readonly expiresAt?: number
  readonly deadline?: number
  /** The presented row's opaque tag, shared only by responses for that row. */
  readonly session?: string
  /** The database's `clock_timestamp()` when the lookup read `expiresAt`, epoch ms; present exactly when it is. */
  readonly serverNow?: number
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
    const encodedSecrets = yield* Config.option(Config.Redacted("SESSION_SECRETS"))
    const sealSecret = yield* Config.option(Config.Redacted("SESSION_SEAL_SECRET"))
    const repository = yield* Config.schema(repositoryName, "GITHUB_REPOSITORY").pipe(
      Config.withDefault(DEFAULT_REPOSITORY),
    )
    const maxAgeDays = yield* Config.schema(positive, "SESSION_MAX_AGE_DAYS").pipe(
      Config.withDefault(SESSION_MAX_AGE_DAYS),
    )
    const recheckMinutes = yield* Config.schema(positive, "ROLE_RECHECK_MINUTES").pipe(
      Config.withDefault(ROLE_RECHECK_MINUTES),
    )
    if (Option.isNone(clientId) || Option.isNone(clientSecret) || (Option.isNone(secret) && Option.isNone(encodedSecrets))) {
      return Option.none<Configured>()
    }
    if (Option.isSome(secret) && Redacted.value(secret.value).length < SessionKeys.MIN_SECRET_LENGTH) {
      yield* Effect.logError("auth.config").pipe(Effect.annotateLogs({ errorCode: "session_secret_too_short" }))
      return Option.none<Configured>()
    }
    const sealing = Option.orElse(sealSecret, () => secret)
    if (Option.isNone(sealing) || Redacted.value(sealing.value).length < SessionKeys.MIN_SECRET_LENGTH) {
      yield* Effect.logError("auth.config").pipe(Effect.annotateLogs({ errorCode: "session_seal_secret_missing" }))
      return Option.none<Configured>()
    }
    const signing = Option.isSome(encodedSecrets) ? SessionKeys.decodeSecrets(encodedSecrets.value)
      : SessionKeys.decodeSecrets(Redacted.make(JSON.stringify({
        legacy: Redacted.value(Option.getOrElse(secret, () => sealing.value)),
      })))
    if (Option.isNone(signing)) {
      yield* Effect.logError("auth.config").pipe(Effect.annotateLogs({ errorCode: "session_secrets_invalid" }))
      return Option.none<Configured>()
    }
    return Option.some<Configured>({
      keys: yield* SessionKeys.make(sealing.value, { sealSecret: sealing.value, secrets: signing.value }),
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
 * Where sign-in hands sessions from (decision 0130): `APP_DOMAIN`, the one host GitHub calls back to, and the hosts of
 * `APP_ALIASES`. `None` without a domain (`APP_DOMAIN` unset, `workers.dev` or not a hostname): every host signs in
 * through GitHub itself, as before. Verified custom domains are read from Postgres per request.
 */
export interface Home {
  readonly host: string
  readonly aliases: ReadonlySet<string>
}

const home = Effect.gen(function* () {
  const domain = yield* Config.option(Config.String("APP_DOMAIN"))
  // `workers.dev` is infra/Domain.ts' `WORKERS_DEV`: a deployment with no domain of its own.
  if (Option.isNone(domain) || domain.value === "workers.dev" || !HOSTNAME.test(domain.value)) return Option.none<Home>()
  const listed = parseAliases(Option.getOrElse(yield* Config.option(Config.String("APP_ALIASES")), () => ""))
  // A list that doesn't parse never deployed (infra/Domain.ts); read here, it names no alias.
  const aliases = "invalid" in listed ? [] : listed.map((alias) => alias.host)
  return Option.some<Home>({ host: domain.value, aliases: new Set(aliases.filter((host) => host !== domain.value)) })
})

/** What an alias asks `APP_DOMAIN` for, signed: its host, the path to return to, its nonce's digest and an expiry. */
const HandoffRequest = Schema.Struct({
  host: Schema.String,
  returnTo: Schema.String,
  nonce: Schema.String,
  expiresAt: Schema.Number,
})
const decodeHandoffRequest = Schema.decodeUnknownOption(Schema.fromJsonString(HandoffRequest))

/**
 * The page an alias's browser lands on with a hand-off's code in its fragment (decision 0130): its one script drops the
 * fragment from history and posts the code back to this origin, so the code is never in a URL a server sees.
 */
const ARRIVE_SCRIPT = `const form = document.forms[0];
const code = new URLSearchParams(location.hash.slice(1)).get("code");
history.replaceState(null, "", location.pathname);
if (code) { form.elements.code.value = code; form.submit() } else location.replace("/?${SIGN_IN_FAILED_PARAM}=failed");`

const hexToBase64 = (hex: string) => btoa(String.fromCharCode(...hex.match(/../g)!.map((pair) => parseInt(pair, 16))))

/** The arrive page's headers: no cache, no referrer, and a CSP that runs only its own script and posts only here. */
export const ARRIVE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": `default-src 'none'; script-src 'sha256-${hexToBase64(digestSync(ARRIVE_SCRIPT))}'; ` +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
}

const ARRIVE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Signing in</title></head>
<body><form method="post" action="${ARRIVE_ROUTE}"><input type="hidden" name="code"></form>
<noscript>Turn on JavaScript to finish signing in.</noscript>
<script>${ARRIVE_SCRIPT}</script></body></html>`

/** `text` safe inside HTML text and a double-quoted attribute. */
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/** The confirm page's headers: no cache, no referrer, no script, never framed, and it posts only here. */
export const CONFIRM_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
}

/** `APP_DOMAIN`'s page asking a signed-in person whether to sign custom domain `host` in as them (decision 0130). */
const confirmPage = (host: string, login: string, request: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(handoffTitle(host))}</title></head>
<body><main><h1>${escapeHtml(handoffTitle(host))}</h1><p>${escapeHtml(handoffExplanation(host, login))}</p>
<form method="post" action="${HANDOFF_ROUTE}"><input type="hidden" name="request" value="${escapeHtml(request)}">
<button type="submit">${escapeHtml(continueTo(host))}</button></form>
<p><a href="/">${escapeHtml(CANCEL_HANDOFF)}</a></p></main></body></html>`

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
      handoff: "__Host-smithers_handoff",
      devSignedOut: "__Host-smithers_dev_signed_out",
      devPerson: "__Host-smithers_dev_person",
    }
    : {
      session: "smithers_session",
      signIn: "smithers_sign_in",
      handoff: "smithers_handoff",
      devSignedOut: "smithers_dev_signed_out",
      devPerson: "smithers_dev_person",
    }

const cookieOptions = (secure: boolean, maxAge: Duration.Duration) =>
  ({ httpOnly: true, secure, sameSite: "lax", path: "/", maxAge }) as const

const sessionCookieOptions = (secure: boolean, deadline: number) =>
  ({ httpOnly: true, secure, sameSite: "lax", path: "/", expires: new Date(deadline) }) as const

const noStore = { "cache-control": "no-store" }
const noReferrer = { ...noStore, "referrer-policy": "no-referrer" }

/**
 * `value` when it is a path on this origin, else `/`: never a redirect to another site. A failed sign-in's
 * `?sign_in=failed` is dropped, so trying again from that page doesn't come back saying it failed.
 */
const returnPath = (value: string | null, origin: string) => {
  if (value === null || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/"
  const url = new URL(value, origin)
  url.searchParams.delete(SIGN_IN_FAILED_PARAM)
  // Dot segments and backslashes can turn a same-origin URL's pathname into a new authority when sent as Location.
  return url.origin === origin && !/^\/[/\\]/.test(url.pathname) ? `${url.pathname}${url.search}${url.hash}` : "/"
}

/** `path` with `?sign_in=failed`, for the browser to show that sign-in failed. */
const failedPath = (path: string, origin: string) => {
  const url = new URL(returnPath(path, origin), origin)
  url.searchParams.set(SIGN_IN_FAILED_PARAM, "failed")
  return `${url.pathname}${url.search}${url.hash}`
}

const encoder = new TextEncoder()
const sameString = (left: string, right: string) =>
  Core.Signature.constantTimeEqual(encoder.encode(left), encoder.encode(right))

/** The host couldn't record the start of a session's sign-out flow; `errorCode` is the host's code, or `conflict`. */
const reauths = Metric.counter("smithers_auth_reauth", { incremental: true })
const recordReauth = (outcome: "renewed_in_place" | "new_row", reason: string) => Effect.andThen(
  Metric.update(Metric.withAttributes(reauths, { outcome, reason }), 1),
  Effect.logInfo("auth.reauth").pipe(Effect.annotateLogs({ outcome, reason })),
)

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

/** Why an alias's redemption of a hand-off didn't sign anyone in; logged and counted, shown as "Couldn't sign in." */
class ArriveFailed extends Schema.TaggedError<ArriveFailed>()("ArriveFailed", {
  reason: Schema.String,
  returnTo: Schema.optional(Schema.String),
  errorCode: Schema.optional(Schema.String),
}) {}

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
 * `options.newcomer` names more of them by the cookie's value, each a person whose id is that value, so a test can be
 * a person nobody was before (worker/DevChatApi.ts `newcomer`).
 */
export const make = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  options: {
    readonly github?: GitHubAuth["Service"]
    readonly fallback?: Signed
    readonly teammates?: Readonly<Record<string, Signed>>
    readonly newcomer?: (name: string) => Signed | undefined
    /** `HOSTED_MODEL_ENABLED`'s default: on only under `alchemy dev` (decision 0099). */
    readonly hostedModel?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const setup = yield* configured(options.github)
    const roleFreshMs = yield* SessionStore.roleFreshMs
    const modelBytes = yield* BodyLimits.modelBytes
    const signingKeyIds = Option.isSome(setup) ? setup.value.keys.keyIds : []
    const withSigningKeys = <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
      effect.pipe(Effect.provideService(SessionStore.SigningKeyIds, signingKeyIds),
        Effect.provideService(SessionStore.RoleFreshMs, roleFreshMs))
    // Read whether or not sign-in is configured: Alchemy binds a setting only if its plan reads it, and no plan sees
    // SESSION_SECRET, which the stack binds itself, so a read behind `setup` never reached production
    // (worker/ChatApi.bindings.test.ts).
    const domain = yield* home
    const slug = yield* appSlug
    // Where GitHub calls back for every host, when sign-in is configured and the deployment has a domain (decision 0130).
    const handoff = Option.isSome(setup) ? domain : Option.none<Home>()
    // Where Install goes (the GitHub App's installation on GitHub), when this deployment signs in with the App.
    const install = Option.isSome(setup) ? installUrl(slug) : undefined
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

    /** Both cookie and bearer traffic admit the same generation of the durable role recheck. */
    const admitRoleCheck = (live: SessionStore.Live) => Effect.gen(function* () {
      if (Option.isNone(setup)) return false
      // Both age and expiry use the database clock that read the receipt. Worker skew cannot delay renewal.
      const checkedAgo = live.serverNow - live.roleCheckedAt
      const window = setup.value.recheckAfterMs
      const renewAfter = window - Math.min(ROLE_RECHECK_MARGIN_MS, window / 2)
      const due = live.roleVerifiedAt === null || live.serverNow - live.roleVerifiedAt >= renewAfter
      if (checkedAgo >= renewAfter || (due && checkedAgo >= Math.min(UNCONFIRMED_RECHECK_MS, renewAfter))) {
        yield* (yield* RoleChecks).start(live.home ?? live.id, live.roleCheckedAt).pipe(
          Effect.timeoutOrElse({ duration: ROLE_CHECK_START_DEADLINE, orElse: () =>
            Effect.logWarning("auth.role_check").pipe(
              Effect.annotateLogs({ sessionId: live.home ?? live.id, outcome: "not_started", errorCode: "start_timeout" }),
              Effect.andThen(Metric.update(Metric.withAttributes(requests, { route: "role_check", outcome: "not_started", reason: "start_timeout" }), 1)),
            ),
          }),
        )
        return true
      }
      return false
    })

    /** Past expiry, give the durable check a bounded chance and read the resulting receipt, never the old snapshot. */
    const renewRole = (live: SessionStore.Live, lookup?: Effect.Effect<Option.Option<SessionStore.Live>, Actor.SessionsUnavailable, R>) => Effect.gen(function* () {
      const admitted = yield* admitRoleCheck(live)
      if (!admitted || Option.isNone(setup) || SessionStore.roleFresh(live.roleVerifiedAt, live.serverNow, setup.value.recheckAfterMs)) {
        return Option.some(live)
      }
      const checks = yield* RoleChecks
      if (checks.wait !== undefined) {
        yield* checks.wait(live.home ?? live.id, live.roleCheckedAt).pipe(
          Effect.catch((error) => Effect.logWarning("auth.role_check").pipe(
            Effect.annotateLogs({ outcome: "wait_failed", errorCode: codeOf(error) }))),
          Effect.timeoutOrElse({ duration: checks.waitWithin ?? "10 seconds", orElse: () =>
            Effect.logWarning("auth.role_check").pipe(Effect.annotateLogs({ outcome: "wait_expired" })) }),
        )
      }
      const next = yield* (lookup ?? SessionStore.findLiveById(live.home ?? live.id).pipe(
        Effect.provide(database), Effect.mapError(() => new Actor.SessionsUnavailable())))
      return Option.map(next, (updated): SessionStore.Live => ({ ...live,
        role: updated.role, roleCheckedAt: updated.roleCheckedAt, roleVerifiedAt: updated.roleVerifiedAt,
        serverNow: updated.serverNow, expiresAt: updated.expiresAt,
      }))
    })

    const signWithIssuer = (keys: SessionKeys.SessionKeys, purpose: SessionKeys.Purpose, value: string, keyId?: string) =>
      Effect.gen(function* () {
        const issuer = keyId ?? (yield* SessionStore.signingIssuer(keys.keyIds).pipe(Effect.provide(database)))
        return yield* keys.sign(purpose, value, issuer)
      })

    const recordCookieRejected = Effect.andThen(
      Metric.update(Metric.withAttributes(sessionOutcomes, { outcome: "cookie_rejected" }), 1),
      Effect.logInfo("auth.session").pipe(Effect.annotateLogs({ outcome: "cookie_rejected" })),
    )
    const recordStale = Effect.andThen(
      Metric.update(Metric.withAttributes(sessionOutcomes, { outcome: "credential_stale" }), 1),
      Effect.logInfo("auth.session").pipe(Effect.annotateLogs({ outcome: "credential_stale" })),
    )
    const credentialStale = Effect.gen(function* () {
      if (Option.isNone(setup)) return false
      const request = yield* HttpServerRequest.HttpServerRequest
      const { url, secure } = arrival(request)
      const proof = yield* setup.value.keys.verify("session", request.cookies[cookieNames(secure).session])
      if (Option.isNone(proof)) return false
      const digest = SessionKeys.digest(proof.value.value)
      const away = Option.isSome(handoff) && url.hostname !== handoff.value.host
      return yield* SessionStore.credentialStale(digest, away ? url.hostname : null, proof.value.keyId).pipe(
        Effect.provide(database), Effect.mapError(error => new Actor.SessionsUnavailable({ errorCode: codeOf(error) })),
      )
    }).pipe(withSigningKeys)
    // Only clients that retain writes through stale credentials may receive this retryable response.
    // Its own generator reads the request: worker-config.test.ts takes the innermost function reading one for the handler.
    const staleResponse = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const accepts = request.headers[ACCEPTS_HEADER] === ACCEPTS_CREDENTIAL_STALE
      return HttpServerResponse.empty({ status: accepts ? 503 : 401, headers: {
        ...noStore, "x-smithers-credential": "stale", ...(accepts ? { "retry-after": "1" } : {}),
      } })
    })
    const readCookie = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const lookupClock = yield* Clock.Clock
      const initialStarted = yield* lookupClock.monotonicTimeNanos
      const rawCookie = request.cookies[cookieNames(arrival(request).secure).session]
      if (Option.isNone(setup)) {
        if (rawCookie !== undefined) yield* recordCookieRejected
        return { live: Option.none<SessionStore.Live>(), lookupStarted: initialStarted }
      }
      const { keys } = setup.value
      const { url } = arrival(request)
      const token = yield* keys.verify("session", rawCookie)
      if (Option.isNone(token)) {
        if (rawCookie !== undefined) yield* recordCookieRejected
        return { live: Option.none<SessionStore.Live>(), lookupStarted: initialStarted }
      }
      const digest = SessionKeys.digest(token.value.value)
      // Away from home, an alias session first; a session signed in at this host itself, as before 0130, still reads.
      const away = Option.isSome(handoff) && url.hostname !== handoff.value.host
      if (request.method === "GET" && request.url.split("?")[0] === SESSION_ROUTE) {
        const renewed = yield* SessionStore.renew(digest, away ? url.hostname : null, setup.value.maxAgeSeconds, token.value.keyId).pipe(
          Effect.provide(database),
          Effect.tapError(error => Effect.logError("auth.session").pipe(
            Effect.annotateLogs({ outcome: "error", errorCode: codeOf(error) }),
          )),
          Effect.mapError(error => new Actor.SessionsUnavailable({ errorCode: codeOf(error) })),
        )
        if (renewed) yield* record("session", { outcome: "renewed" })
      }
      const lookupStarted = yield* lookupClock.monotonicTimeNanos
      const lookup = (away
        ? Effect.flatMap(
          SessionStore.findHostLive(digest, url.hostname, token.value.keyId),
          (found) => Option.isSome(found) ? Effect.succeed(found) : SessionStore.findLive(digest, token.value.keyId),
        )
        : SessionStore.findLive(digest, token.value.keyId)).pipe(
        Effect.provide(database),
        Effect.tapError((error) =>
          Effect.logError("auth.session").pipe(Effect.annotateLogs({ outcome: "error", errorCode: codeOf(error) }))
        ),
        Effect.mapError(error => new Actor.SessionsUnavailable({ errorCode: codeOf(error) })),
      )
      const found = yield* lookup
      const live = Option.isNone(found) ? found : yield* renewRole(found.value, lookup)
      if (Option.isNone(live)) {
        yield* recordCookieRejected
        if (yield* credentialStale) { yield* recordStale; return yield* new CredentialStale() }
        return { live, lookupStarted }
      }
      return { live, lookupStarted }
    }).pipe(withSigningKeys)

    const guard = <E2, R2>(next: Effect.Effect<HttpServerResponse.HttpServerResponse, E2, R2>) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = request.url.split("?")[0]!
      // Recovery routes and requests carrying a credential validate themselves: a credential that doesn't read is nobody,
      // never its cookie's person. Sign-out verifies the configured signature and owner so a lost rotation response
      // cannot strand a live session behind its old cookie.
      if (Option.isNone(setup) || (RunCredentials.carriesCredential(request) && !path.startsWith("/api/auth/")) ||
        [SESSION_ROUTE, SIGN_IN_ROUTE, SIGN_OUT_ROUTE, CALLBACK_ROUTE, ARRIVE_ROUTE, HANDOFF_ROUTE].includes(path)) return yield* next
      if (Option.isSome(yield* Effect.serviceOption(CookieReceipt))) return yield* next
      const receipt = yield* readCookie
      return yield* next.pipe(Effect.provideService(CookieReceipt, receipt))
    }).pipe(
      Effect.catchTag("CredentialStale", () => staleResponse),
      Effect.catchTag("@smthrs/mvp/auth/SessionsUnavailable", error => Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.url.split("?")[0] === SIGN_OUT_ROUTE) yield* record("sign_out", {
          outcome: "failed", reason: "error", errorCode: "errorCode" in error && typeof error.errorCode === "string" ? error.errorCode : "sessions_unavailable",
        })
        return HttpServerResponse.empty({ status: 503, headers: noStore })
      })),
      withSigningKeys,
    )

    // One seed in flight per isolate's SignIn service, claimed before yielding so concurrent requests never join its RPC.
    // Only an admitted seed is remembered: one that fails or times out frees the next request to seed again.
    const maintenance = yield* Ref.make<"idle" | "seeding" | "admitted">("idle")
    const claimSeed = Ref.modify(maintenance, (state) => state === "idle" ? [true, "seeding"] as const : [false, state] as const)
    /** The shared request boundary for body admission and cookie authority. Maintenance is best effort. */
    const admit = <E2, R2>(next: Effect.Effect<HttpServerResponse.HttpServerResponse, E2, R2>,
      preflight?: Parameters<typeof WriteAdmission.afterBody>[1]) => WriteAdmission.afterBody(Effect.gen(function* () {
      if (Option.isSome(setup)) {
        yield* Effect.acquireUseRelease(
          claimSeed,
          claimed => claimed ? ReplacedTokens.ensure : Effect.void,
          (claimed, exit) => claimed ? Ref.set(maintenance, Exit.isSuccess(exit) ? "admitted" : "idle") : Effect.void,
        ).pipe(Effect.catchCause(() => Effect.void))
      }
      return yield* guard(next)
    }), preflight).pipe(Effect.provideService(BodyLimits.ModelBytes, modelBytes))

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
          : options.newcomer?.(person)
        return Option.fromNullishOr(teammate ?? options.fallback)
      }
      const shared = yield* Effect.serviceOption(CookieReceipt)
      const { live, lookupStarted } = Option.isSome(shared) ? shared.value : yield* readCookie
      if (Option.isNone(live)) return Option.none()
      const { recheckAfterMs } = setup.value
      const lookupClock = yield* Clock.Clock
      if (Number((yield* lookupClock.monotonicTimeNanos) - lookupStarted) / 1_000_000 >= live.value.expiresAt - live.value.serverNow) return Option.none()
      const unconfirmed = !SessionStore.roleFresh(live.value.roleVerifiedAt, live.value.serverNow, recheckAfterMs)
      // An alias session acts as its home session, which holds the person's GitHub tokens and role (decision 0130).
      return Option.some<Signed>({
        actor: {
          subject: { kind: "person", id: live.value.personId },
          role: live.value.role,
          session: live.value.home ?? live.value.id,
          cookieKey: live.value.cookieKey,
          // The alias session itself, which signing out at its host ends (worker/SocketAccess.ts and
          // worker/runners/Fence.ts check both).
          ...(live.value.home === undefined ? {} : { alias: live.value.id }),
        },
        roleConfirmed: !unconfirmed,
        login: live.value.login,
        expiresAt: live.value.expiresAt,
        serverNow: live.value.serverNow,
        deadline: live.value.deadline,
        session: live.value.sessionTag,
      })
    }).pipe(Effect.withSpan("auth.resolve"))

    /**
     * Whether `host` is one sign-in hands sessions to: not `APP_DOMAIN`, and an `APP_ALIASES` host or a verified custom
     * domain (decision 0130).
     */
    const handsTo = (host: string) =>
      Option.isNone(handoff) || host === handoff.value.host
        ? Effect.succeed(false)
        : handoff.value.aliases.has(host)
        ? Effect.succeed(true)
        : Domains.active(host).pipe(Effect.provide(database))

    /** Records a sign-in that returns to `returnTo` on this origin and sends the browser to GitHub. */
    const toGitHub = (keys: SessionKeys.SessionKeys, github: GitHubAuth["Service"], origin: string, secure: boolean, returnTo: string) =>
      Effect.gen(function* () {
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
            yield* signWithIssuer(keys, "sign_in", state),
            cookieOptions(secure, Duration.seconds(SIGN_IN_TTL_SECONDS)),
          ),
        )
      })

    /**
     * `GET /api/auth/sign-in?return=<path>`: records the sign-in and sends the browser to GitHub; at an alias, to
     * `APP_DOMAIN`'s hand-off instead (decision 0130).
     */
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
      if (Option.isNone(handoff) || !(yield* handsTo(url.hostname))) return yield* toGitHub(keys, github, origin, secure, returnTo)
      // An alias: only a press on its own page, or an address typed in, starts a sign-in; a link on another site
      // signs nobody in (M-46). Browsers without Fetch Metadata are refused too.
      const site = request.headers["sec-fetch-site"]
      if (site !== "same-origin" && site !== "none") {
        yield* record("sign_in", { outcome: "refused", reason: "cross_site", host: url.hostname })
        return HttpServerResponse.redirect(failedPath(returnTo, origin), { status: 303, headers: noStore })
      }
      const nonce = yield* keys.token
      const expiresAt = (yield* Clock.currentTimeMillis) + SIGN_IN_TTL_SECONDS * 1000
      const handoffRequest = yield* signWithIssuer(keys,
        "handoff_request",
        JSON.stringify({ host: url.hostname, returnTo, nonce: SessionKeys.digest(nonce), expiresAt }),
      )
      yield* record("sign_in", { outcome: "handed_off", host: url.hostname })
      return HttpServerResponse.redirect(
        `${url.protocol}//${handoff.value.host}${HANDOFF_ROUTE}?request=${encodeURIComponent(handoffRequest)}${url.searchParams.get("reauth") === "1" ? "&reauth=1" : ""}`,
        { status: 302, headers: noReferrer },
      ).pipe(
        HttpServerResponse.setCookieUnsafe(
          cookieNames(secure).handoff,
          yield* signWithIssuer(keys, "handoff", nonce),
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

    /**
     * `GET /api/auth/handoff?request=<signed>` at `APP_DOMAIN` (decision 0130): hands this browser's session to the alias
     * that signed the request, as a one-time code in the fragment of its arrive page. Without a session here, signs in
     * through GitHub first, returning here. For a custom domain, whose owner controls where its name points, the GET is a
     * page asking the person to continue, and only its same-origin `POST` (form field `request`) hands the session over.
     */
    const handoffRoute = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.method !== "GET" && request.method !== "POST") {
        return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, POST" } })
      }
      const { url, origin, secure } = arrival(request)
      if (Option.isNone(setup) || Option.isNone(handoff) || url.hostname !== handoff.value.host) {
        yield* record("handoff", { outcome: "refused", reason: "not_home" })
        return HttpServerResponse.empty({ status: 404, headers: noStore })
      }
      const { keys, github } = setup.value
      const confirming = request.method === "POST"
      // The no-referrer confirmation form posts Origin: null; Fetch Metadata must still prove it came from here.
      if (confirming && !(request.headers.origin === undefined || request.headers.origin === "null"
        ? request.headers["sec-fetch-site"] === "same-origin"
        : request.headers.origin === origin)) {
        yield* record("handoff", { outcome: "refused", reason: "cross_site" })
        return HttpServerResponse.empty({ status: 403, headers: noStore })
      }
      const signed = confirming
        ? new URLSearchParams(yield* readBounded(request, 4096).pipe(Effect.orElseSucceed(() => ""))).get("request")
        : url.searchParams.get("request")
      const verified = yield* keys.verify("handoff_request", signed ?? undefined)
      const asked = Option.flatMap(verified, proof => decodeHandoffRequest(proof.value))
      const now = yield* Clock.currentTimeMillis
      if (Option.isNone(asked) || asked.value.expiresAt <= now) {
        yield* record("handoff", { outcome: "refused", reason: Option.isNone(asked) ? "invalid_request" : "expired_request" })
        return HttpServerResponse.empty({ status: 400, headers: noStore })
      }
      const { host, returnTo, nonce } = asked.value
      if (!HOSTNAME.test(host) || !(yield* handsTo(host))) {
        yield* record("handoff", { outcome: "refused", reason: "foreign_host", host })
        return HttpServerResponse.empty({ status: 400, headers: noStore })
      }
      const away = `${url.protocol}//${host}`
      if (url.searchParams.get(SIGN_IN_FAILED_PARAM) !== null) {
        // GitHub's sign-in here failed: the alias says so, rather than starting it again.
        yield* record("handoff", { outcome: "failed", reason: "sign_in_failed", host })
        return HttpServerResponse.redirect(`${away}${failedPath(returnTo, away)}`, { status: 303, headers: noReferrer })
      }
      const signedIn = yield* current.pipe(Effect.catchTag("CredentialStale", () => Effect.succeedNone))
      const reauth = url.searchParams.get("reauth") === "1" && Option.isSome(signedIn) &&
        signedIn.value.deadline !== undefined && signedIn.value.serverNow !== undefined &&
        signedIn.value.deadline - signedIn.value.serverNow <= 7 * 86400_000
      if (Option.isNone(signedIn) || reauth) {
        yield* record("handoff", { outcome: "signing_in", host })
        return yield* toGitHub(keys, github, origin, secure, `${HANDOFF_ROUTE}?request=${encodeURIComponent(signed!)}`)
      }
      if (!confirming && !handoff.value.aliases.has(host)) {
        // A custom domain: the person says so here, on this origin, before its owner's host gets a session.
        yield* record("handoff", { outcome: "confirming", host })
        return HttpServerResponse.text(confirmPage(host, signedIn.value.login, signed!), {
          contentType: "text/html; charset=utf-8",
          headers: CONFIRM_HEADERS,
        })
      }
      const code = yield* keys.token
      yield* SessionStore.beginHandoff({
        codeDigest: SessionKeys.digest(code),
        sessionId: signedIn.value.actor.session!,
        host,
        nonceDigest: nonce,
        returnTo,
        ttlSeconds: HANDOFF_CODE_TTL_SECONDS,
      }).pipe(Effect.provide(database))
      yield* record("handoff", { outcome: "issued", host })
      return HttpServerResponse.redirect(`${away}${ARRIVE_ROUTE}#code=${code}`, { status: 303, headers: noReferrer })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          record("handoff", { outcome: "failed", reason: "error", errorCode: codeOf(Cause.squash(cause)) }),
          HttpServerResponse.empty({ status: 503, headers: noStore }),
        )
      ),
      Effect.withSpan("auth.handoff"),
    )

    /**
     * `GET /api/auth/arrive` at an alias: the page that posts a hand-off's code from its fragment back here. `POST` with
     * the form field `code`: redeems it, once, against this browser's nonce, and signs the alias in (decision 0130).
     */
    const arrive = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const { url, origin, secure } = arrival(request)
      const names = cookieNames(secure)
      if (Option.isNone(setup) || Option.isNone(handoff) || url.hostname === handoff.value.host) {
        yield* record("arrive", { outcome: "refused", reason: "not_away" })
        return HttpServerResponse.empty({ status: 404, headers: noStore })
      }
      if (request.method === "GET") {
        return HttpServerResponse.text(ARRIVE_PAGE, { contentType: "text/html; charset=utf-8", headers: ARRIVE_HEADERS })
      }
      if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, POST" } })
      const { keys } = setup.value
      const host = url.hostname
      const outcome = yield* Effect.gen(function* () {
        // Only this origin's page posts a code: another site's form signs nobody in here (login CSRF). The arrive page
        // sends no referrer, so a browser's post from it says `Origin: null` (Fetch serializes a no-referrer POST's
        // origin as null); then, as with no Origin at all, Fetch Metadata decides.
        const claimed = request.headers.origin
        const fromHere = claimed === undefined || claimed === "null"
          ? request.headers["sec-fetch-site"] === "same-origin"
          : claimed === origin
        if (!fromHere) return yield* new ArriveFailed({ reason: "cross_site" })
        const body = yield* readBounded(request, 1024).pipe(Effect.mapError(() => new ArriveFailed({ reason: "body" })))
        const code = new URLSearchParams(body).get("code")
        if (code === null || code.length === 0) return yield* new ArriveFailed({ reason: "missing_code" })
        const fromDatabase = <A, E, R2>(effect: Effect.Effect<A, E, R2>, returnTo?: string) =>
          effect.pipe(
            Effect.mapError((error) =>
              new ArriveFailed({ reason: "database", errorCode: codeOf(error), ...(returnTo === undefined ? {} : { returnTo }) })
            ),
          )
        // Taken before anything is checked, so every attempt spends the code.
        const taken = yield* fromDatabase(SessionStore.takeHandoff(SessionKeys.digest(code)).pipe(Effect.provide(database)))
        if (Option.isNone(taken)) return yield* new ArriveFailed({ reason: "unknown_code" })
        const { sessionId, nonceDigest, live } = taken.value
        // Another host's code says nothing of where to return here.
        if (taken.value.host !== host) return yield* new ArriveFailed({ reason: live ? "other_host" : "expired" })
        const { returnTo } = taken.value
        const failing = (reason: string, errorCode?: string) =>
          new ArriveFailed({ reason, returnTo, ...(errorCode === undefined ? {} : { errorCode }) })
        if (!live) return yield* failing("expired")
        // A custom domain removed since the code was issued signs nobody in.
        if (!(yield* fromDatabase(handsTo(host), returnTo))) return yield* failing("foreign_host")
        const nonce = yield* keys.verify("handoff", request.cookies[names.handoff])
        if (Option.isNone(nonce)) return yield* failing("nonce_missing")
        if (!sameString(SessionKeys.digest(nonce.value.value), nonceDigest)) return yield* failing("nonce_mismatch")
        const stored = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
          fromDatabase(effect.pipe(Effect.provide(database)), returnTo)
        // A pre-0130 home session holds GitHub tokens, so its existing sign-out flow still owns termination.
        // Alias rows are decided under the arrival transaction’s locks below.
        const previous = yield* keys.verify("session", request.cookies[names.session])
        if (Option.isSome(previous)) {
          const digest = SessionKeys.digest(previous.value.value)
          const pending = yield* stored(SessionStore.signingOut(digest))
          if (Option.isSome(pending)) {
            yield* startSignOut(pending.value).pipe(
              Effect.mapError((error) => failing("sign_out_not_started", error.errorCode)),
            )
            yield* stored(SessionStore.revoke({ id: pending.value }, "sign_out"))
          }
        }
        const freshToken = yield* keys.token
        const issued = yield* stored(SessionStore.reauthenticateHost({ id: crypto.randomUUID(), tokenDigest: SessionKeys.digest(freshToken), parentId: sessionId, host },
          Option.isNone(previous) ? null : { digest: SessionKeys.digest(previous.value.value), key: previous.value.keyId }, keys.keyIds))
        if (Option.isNone(issued)) return yield* failing("home_ended")
        const token = issued.value.renewed ? Option.getOrThrow(previous).value : freshToken
        yield* recordReauth(issued.value.renewed ? "renewed_in_place" : "new_row", issued.value.renewed ? "eligible_alias" : "ineligible_alias")
        return { returnTo, cookie: yield* keys.sign("session", token, issued.value.key), deadline: issued.value.deadline }
      }).pipe(
        Effect.catchDefect((defect) => Effect.fail(new ArriveFailed({ reason: "error", errorCode: codeOf(defect) }))),
        Effect.result,
      )
      if (outcome._tag === "Success") {
        yield* record("arrive", { outcome: "signed_in", host })
        return HttpServerResponse.redirect(returnPath(outcome.success.returnTo, origin), { status: 303, headers: noReferrer }).pipe(
          HttpServerResponse.setCookieUnsafe(names.session, outcome.success.cookie, sessionCookieOptions(secure, outcome.success.deadline)),
          HttpServerResponse.expireCookieUnsafe(names.handoff, cookieOptions(secure, Duration.zero)),
        )
      }
      const failure = outcome.failure
      yield* record("arrive", {
        outcome: "failed",
        reason: failure.reason,
        host,
        ...(failure.errorCode === undefined ? {} : { errorCode: failure.errorCode }),
      })
      if (failure.reason === "cross_site") return HttpServerResponse.empty({ status: 403, headers: noStore })
      return HttpServerResponse.redirect(failedPath(failure.returnTo ?? "/", origin), { status: 303, headers: noReferrer })
        .pipe(HttpServerResponse.expireCookieUnsafe(names.handoff, cookieOptions(secure, Duration.zero)))
    }).pipe(Effect.withSpan("auth.arrive"))

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
        if (state === null || Option.isNone(started) || !sameString(state, started.value.value)) {
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
        const previous = yield* keys.verify("session", request.cookies[names.session])
        const fromGitHub = <A>(effect: Effect.Effect<A, GitHubRefused>) =>
          Effect.mapError(effect, (error) => failing(`${error.step}_${error.reason}`))
        const tokens = yield* fromGitHub(github.exchange({ code: Redacted.make(code), codeVerifier, redirectUri }))
        // Until issuance commits, this callback owns the pair. Failed sign-in must hand it to durable cleanup.
        const discardedId = crypto.randomUUID()
        let retained = false
        return yield* Effect.gen(function* () {
          const user = yield* fromGitHub(github.user(tokens.accessToken))
          const roleGeneration = yield* SessionStore.roleObservation.pipe(
            Effect.provide(database),
            Effect.mapError((error) => new CallbackFailed({ reason: "database", returnTo, errorCode: codeOf(error) })),
          )
          const role = roleOf(yield* fromGitHub(github.permission(tokens.accessToken, repository)))
          const freshId = crypto.randomUUID()
          const freshToken = yield* keys.token
          const signedIn = yield* SessionStore.issuance(Effect.gen(function* () {
            const personId = yield* SessionStore.upsertPerson({ id: crypto.randomUUID(), githubId: user.id, login: user.login })
            const candidate = Option.isNone(previous) ? Option.none<{ id: string; eligible: boolean }>()
              : yield* SessionStore.reauthCandidate(SessionKeys.digest(previous.value.value), personId, previous.value.keyId, keys.keyIds)
            let renewed = Option.isSome(candidate) && candidate.value.eligible
            const pending: Array<string> = []
            if (renewed && Option.isSome(candidate)) {
              const held = yield* SessionStore.held(candidate.value.id)
              if (Option.isSome(held) && held.value.access !== null) {
                // Pre-migration rows have no pair digest. Opening their pinned seal recovers it without exposing the token.
                const pairDigest = held.value.pairDigest ?? (yield* keys.open(held.value.access,
                  { id: candidate.value.id, name: "github_access", version: 1 }).pipe(Effect.map(value => SessionKeys.digest(Redacted.value(value))),
                    Effect.catchTag("/control/PersistenceError", () => Effect.succeed(null))))
                if (pairDigest === null) {
                  yield* SessionStore.revoke(candidate.value, "unreadable")
                  renewed = false
                } else {
                  const cleanup = yield* SessionStore.enqueueCleanup({ sessionId: candidate.value.id, pairDigest, access: held.value.access, refresh: held.value.refresh })
                  if (Option.isSome(cleanup)) pending.push(cleanup.value)
                }
              }
            }
            const sessionId = renewed ? Option.getOrThrow(candidate).id : freshId
            const token = renewed ? Option.getOrThrow(previous).value : freshToken
            const seal = (value: Redacted.Redacted<string>, name: "github_access" | "github_refresh") => keys.seal(value, { id: sessionId, name, version: 1 })
            const next = {
              id: sessionId, tokenDigest: SessionKeys.digest(token), personId, role, roleGeneration,
              access: yield* seal(tokens.accessToken, "github_access"), accessExpiresAt: tokens.expiresAt,
              refresh: tokens.refreshToken === null ? null : yield* seal(tokens.refreshToken, "github_refresh"),
              refreshDigest: tokens.refreshToken === null ? null : SessionKeys.digest(Redacted.value(tokens.refreshToken)),
              pairDigest: SessionKeys.digest(Redacted.value(tokens.accessToken)), maxAgeSeconds,
            }
            const effectiveRole = renewed ? yield* SessionStore.reauthenticate(next, keys.keyIds)
              : yield* SessionStore.createSession(next, keys.keyIds)
            if (!renewed && Option.isSome(candidate)) yield* SessionStore.revoke({ id: candidate.value.id }, "sign_out")
            const live = yield* SessionStore.findLive(SessionKeys.digest(token))
            if (Option.isNone(live)) return yield* new CallbackFailed({ reason: "expired", returnTo })
            return { personId, sessionId, role: effectiveRole, deadline: live.value.deadline, cookieKey: live.value.cookieKey, token, pending, renewed }
          })).pipe(
            Effect.provide(database),
            Effect.mapError((error) => new CallbackFailed({ reason: error instanceof SessionStore.IssuerUnconfigured ? "issuer_unconfigured" : "database", returnTo, errorCode: codeOf(error) })),
          )
          retained = true
          // Commit the cleanup request before admitting its flow. A refused start leaves it for the alarm's sweeper.
          yield* Effect.forEach(signedIn.pending, ReplacedTokens.start, { discard: true })
          yield* recordReauth(signedIn.renewed ? "renewed_in_place" : "new_row", signedIn.renewed ? "eligible" : "ineligible")
          // Whether GitHub showed a page, after one of our revocations or not (decision 0165). It never fails sign-in.
          yield* SessionStore.tokenHistory(signedIn.personId, signedIn.sessionId).pipe(
            Effect.provide(database),
            Effect.flatMap((history) => GitHub.Auth.Consent.observe({
              page: GitHub.Auth.Consent.pageOf(request.headers.referer, GitHub.Auth.Consent.githubOrigin(github)),
              ...history,
              path: "sign_in",
            })),
            Effect.catch((error) => Effect.logWarning("auth.github.consent").pipe(Effect.annotateLogs({ outcome: "failed", errorCode: codeOf(error) }))),
          )
          return { ...signedIn, returnTo, cookie: yield* keys.sign("session", signedIn.token, signedIn.cookieKey) }
        }).pipe(Effect.onError(() => Effect.gen(function* () {
          if (retained) return
          const access = yield* keys.seal(tokens.accessToken, { id: discardedId, name: "github_access", version: 1 })
          const refresh = tokens.refreshToken === null ? null : yield* keys.seal(tokens.refreshToken, { id: discardedId, name: "github_refresh", version: 1 })
          const pending = yield* SessionStore.enqueueCleanup({ sessionId: discardedId,
            pairDigest: SessionKeys.digest(Redacted.value(tokens.accessToken)), access, refresh }).pipe(Effect.provide(database))
          if (Option.isSome(pending)) yield* ReplacedTokens.start(pending.value)
        }).pipe(Effect.catchCause(() => Effect.andThen(
          Metric.update(Metric.withAttributes(ReplacedTokens.cleanups, { outcome: "failed" }), 1),
          Effect.logWarning("auth.token_cleanup").pipe(Effect.annotateLogs({ outcome: "failed" })),
        )))))
      }).pipe(
        // A bug: logged by its name, and the browser told sign-in failed.
        Effect.catchDefect((defect) =>
          Effect.fail(new CallbackFailed({ reason: "error", errorCode: codeOf(defect) }))
        ),
        Effect.result,
      )
      const durationMs = (yield* Clock.currentTimeMillis) - startedAt
      if (outcome._tag === "Success") {
        const { personId, role, returnTo, cookie, deadline } = outcome.success
        yield* record("callback", { outcome: "signed_in", personId, role: role ?? "none", durationMs })
        return HttpServerResponse.redirect(returnPath(returnTo, origin), { status: 303, headers: noStore }).pipe(
          HttpServerResponse.setCookieUnsafe(
            names.session,
            cookie,
            sessionCookieOptions(secure, deadline),
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
      const { url, origin, secure } = arrival(request)
      const names = cookieNames(secure)
      const hostname = url.hostname
      const away = Option.isSome(handoff) && hostname !== handoff.value.host
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
            if (Option.isNone(token)) return Option.none<string>()
            const digest = SessionKeys.digest(token.value.value)
            const atAlias = away ? yield* SessionStore.hostOwnerOf(digest, hostname) : Option.none<string>()
            return Option.isSome(atAlias) ? atAlias : yield* SessionStore.ownerOf(digest)
          }).pipe(Effect.provide(database))
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
        ? Option.none<SessionKeys.Verified>()
        : yield* setup.value.keys.verify("session", request.cookies[names.session])
      // At an alias, signing out ends this alias's session only; its home session and every other alias's stay
      // (decision 0130). Nothing to revoke on GitHub: an alias session holds no token.
      const ended = Option.isSome(token) && away
        ? yield* SessionStore.revokeHost(SessionKeys.digest(token.value.value), hostname).pipe(Effect.provide(database))
        : Option.none<string>()
      if (Option.isSome(ended)) {
        yield* record("sign_out", { outcome: "signed_out", reason: "alias" })
        return signedOut
      }
      // A live session, or one that ended with GitHub tokens nothing revoked yet (its earlier sign-out never started its
      // flow), is signed out by the durable flow, admitted before anything changes: a start the host refuses is a 503
      // that leaves the session as it was, so signing out again can finish. Once admitted, the session ends here too,
      // so it is refused at once; the flow ends it again, which changes nothing, and revokes its GitHub token.
      const pending = Option.isNone(token)
        ? Option.none<string>()
        : yield* SessionStore.signingOut(SessionKeys.digest(token.value.value)).pipe(Effect.provide(database))
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
     * `GET /api/auth/session`: who this browser is signed in as, and whether the deployment's own model answers them
     * (`hostedModel`): on, and they are a Member or above of its own repository (ruling AUTH-8). Signed out, whether it
     * answers anyone, so a visitor's first run shows the steps they will have (decision 0121). A setting Postgres can't
     * read says it does: the endpoint refuses each call itself, so the composer shows and the answer fails visibly
     * rather than hiding chat. Signed in, where Install goes (`install`), when the deployment signs in with the App.
     */
    const sessionAnswer = (prior: SessionPrior.Prior | undefined) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
      const signed = yield* current
      const hostedModel = yield* HostedModel.enabled(hostedDefault).pipe(
        Effect.provide(database),
        Effect.catchCause((cause) =>
          Effect.as(record("session", { outcome: "failed", reason: "hosted_model", errorCode: codeOf(Cause.squash(cause)) }), true)
        ),
      )
      // The home conversation is every signed-in person's own (decision 0110, the data gate): its rows show on their
      // devices by this id, with no repository's say. None when the home branch doesn't exist yet.
      const homeConversationId = Option.isSome(signed)
        ? yield* Conversations.home.pipe(
          Effect.provide(database),
          // A deployment with no home repository configured, or a database that can't say, names none.
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        : undefined
      const state: SessionState = Option.isSome(signed)
        ? {
          signedIn: true,
          personId: signed.value.actor.subject.id,
          ...(homeConversationId === undefined ? {} : { homeConversationId }),
          login: signed.value.login,
          role: signed.value.actor.role,
          ...(signed.value.roleConfirmed === false ? { roleConfirmed: false } : {}),
          hostedModel: hostedModel && Actor.canAsk(signed.value.actor),
          ...(install === undefined ? {} : { install }),
          // Until when the session is live, and the database's now read beside it, so a tab counts down on one clock
          // from when it asked. Local development's people have no session: the Worker's now, with no end to compare.
          ...(signed.value.expiresAt === undefined ? {} : { expiresAt: signed.value.expiresAt }),
          serverNow: signed.value.serverNow ?? (yield* Clock.currentTimeMillis),
          ...(signed.value.deadline === undefined ? {} : { deadline: signed.value.deadline }),
          ...(signed.value.session === undefined ? {} : { session: signed.value.session }),
        }
        : { signedIn: false, available: Option.isSome(setup) || options.fallback !== undefined, hostedModel }
      return HttpServerResponse.jsonUnsafe({ ...state, ...(prior === undefined ? {} : { prior }) }, { status: 200, headers: noStore })
    }).pipe(
      Effect.catchTag("CredentialStale", () => Effect.succeed(HttpServerResponse.jsonUnsafe({ credential: "stale", ...(prior === undefined ? {} : { prior }) }, { status: 200, headers: noStore }))),
      Effect.catchTag("@smthrs/mvp/auth/SessionsUnavailable", () =>
        Effect.succeed(prior === undefined ? HttpServerResponse.empty({ status: 503, headers: noStore })
          : HttpServerResponse.jsonUnsafe({ prior }, { status: 503, headers: noStore }))),
      Effect.withSpan("auth.session"),
    )

    const session = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const tag = request.headers["x-smithers-session-tag"]
      const prior = request.method !== "GET" || tag === undefined ? undefined : yield* SessionPrior.read(tag).pipe(
        Effect.provide(database),
        Effect.catchCause(() => Effect.succeed("failed" as const)),
        Effect.tap(outcome => Effect.andThen(
          Metric.update(Metric.withAttributes(Metric.counter("smithers_auth_session_prior", { incremental: true }), { outcome }), 1),
          Effect.logInfo("auth.session_prior").pipe(Effect.annotateLogs({ outcome })),
        )),
        Effect.withSpan("auth.session_prior"),
      )
      return yield* sessionAnswer(prior)
    })

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      switch (request.url.split("?")[0]) {
        case SIGN_IN_ROUTE:
          return yield* signIn
        case CALLBACK_ROUTE:
          return yield* callback
        case HANDOFF_ROUTE:
          return yield* handoffRoute
        case ARRIVE_ROUTE:
          return yield* arrive
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
    const personOf = (claims: RunCredentials.Claims): Effect.Effect<Option.Option<Actor.Actor>, Actor.SessionsUnavailable, R | RoleChecks> =>
      Option.isNone(setup)
        ? Effect.succeed(
          Option.fromNullishOr(
            local.find((signed) => signed?.actor.subject.id === claims.sub) ?? options.newcomer?.(claims.sub),
          ).pipe(
            Option.map((signed) => ({ ...signed.actor, login: signed.login })),
          ),
        )
        : claims.sid === undefined
        ? Effect.succeedNone
        : Effect.gen(function* () {
          const lookupClock = yield* Clock.Clock
          const lookupStarted = yield* lookupClock.monotonicTimeNanos
          const found = yield* SessionStore.findLiveById(claims.sid!)
          if (Option.isNone(found) || found.value.personId !== claims.sub) return Option.none()
          const renewed = yield* renewRole(found.value)
          if (Option.isNone(renewed)) return Option.none()
          const live = renewed.value
          // Role-check admission may wait even for a still-fresh role. Bound this snapshot's lifetime just as
          // cookie admission does, using elapsed monotonic time rather than the Worker's wall clock.
          if (Number((yield* lookupClock.monotonicTimeNanos) - lookupStarted) / 1_000_000 >= live.expiresAt - live.serverNow) return Option.none()
          if (!SessionStore.roleFresh(live.roleVerifiedAt, live.serverNow, setup.value.recheckAfterMs)) {
            return yield* new Actor.SessionsUnavailable()
          }
          return Option.some<Actor.Actor>({ subject: { kind: "person", id: live.personId },
            role: live.role, session: live.id, cookieKey: live.cookieKey, login: live.login })
        }).pipe(
          Effect.provide(database),
          Effect.tapError((error) =>
            Effect.logError("auth.session").pipe(Effect.annotateLogs({ outcome: "error", errorCode: codeOf(error) }))
          ),
          Effect.mapError(error => new Actor.SessionsUnavailable({ errorCode: codeOf(error) })),
        )

    /**
     * `Actor.Sessions` and `RunCredentials`: a request carrying a run credential is that run's, and never falls back to
     * its cookie; any other is the person behind its session cookie.
     */
    const sessions = Layer.effectContext(
      Effect.map(Effect.context<RoleChecks | R>(), (context) => {
        const credentials = RunCredentials.make({
          keys: {
            ...runKeys,
            sign: (purpose, value, keyId) => Option.isNone(setup) ? runKeys.sign(purpose, value, keyId)
              : signWithIssuer(runKeys, purpose, value, keyId).pipe(Effect.provide(context), Effect.orDie),
          },
          person: (claims) => personOf(claims).pipe(withSigningKeys, Effect.provide(context)),
        })
        return Context.make(RunCredentials.RunCredentials, credentials).pipe(
          Context.add(SessionStore.SigningKeyIds, signingKeyIds),
          Context.add(SessionStore.RoleFreshMs, roleFreshMs),
          Context.add(
            Actor.Sessions,
            (() => {
              const authorized = current.pipe(Effect.flatMap((signed) =>
                Option.isSome(signed) && signed.value.roleConfirmed === false
                  ? Effect.fail(new Actor.SessionsUnavailable()) : Effect.succeed(signed)))
              const person = authorized.pipe(
                Effect.map(Option.map((signed) => ({ ...signed.actor, login: signed.login }))),
                Effect.catchTag("CredentialStale", () => Effect.succeedNone),
                Effect.provide(context),
              )
              // The cookie's person also carries when its session ends and the database's clock as it read that, for a
              // read that answers with its deadline.
              const cookiePerson = authorized.pipe(
                Effect.map(Option.map((signed): Actor.Actor => ({
                  ...signed.actor,
                  login: signed.login,
                  ...(signed.expiresAt === undefined || signed.serverNow === undefined
                    ? {}
                    : { expiry: { at: signed.expiresAt, now: signed.serverNow } }),
                }))),
                Effect.catchTag("CredentialStale", () => Effect.succeedNone),
                Effect.provide(context),
              )
              return Actor.Sessions.of({
                resolve: RunCredentials.resolveWith(credentials, person),
                resolveCookie: RunCredentials.resolveCookieWith(cookiePerson),
              })
            })(),
          ),
        )
      }),
    )

    return { fetch: withSigningKeys(fetch), sessions, configured: setup, guard, admit }
  })
