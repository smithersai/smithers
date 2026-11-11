import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Clock, Effect, Layer, Metric, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ROLES } from "../../src/features/auth/contract.ts"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import { type GitHubAuth, GitHubRefused, roleOf } from "../GitHubAuth.ts"
import { digest, type SessionKeys } from "../SessionKeys.ts"
import * as SessionStore from "../SessionStore.ts"
import * as Cleanup from "./RevokeReplacedGitHubToken.ts"

// `auth/RecheckRole { sessionId }` (docs/features/sign-in.md#role-checks): a session's role on the repository, checked
// with GitHub again. Sign-in starts it when a session's role is over an hour old (mvp.md M-05). It first refreshes the
// session's 8-hour GitHub token when it is about to expire, keeping the single-use refresh token GitHub rotates. A
// token GitHub refuses ends the session. It runs on any host; the host injects Postgres and GitHub through
// `registration`, and each step retries a GitHub or Postgres failure under its retry policy.
//
// Redeeming the refresh token can't be repeated, so it is a step of its own (`auth/RedeemRefresh`), whose sealed result
// holds the replacement, encrypted, never in plaintext. Storing it is the next step (`auth/StoreTokens`), which retries
// from that result: a Postgres failure, or the host dying, after GitHub issued the replacement never redeems the spent
// token again. One window stays: GitHub redeemed the token and its answer never arrived. The retry presents the spent
// token, GitHub refuses it, and the session ends, so the person signs in again.
//
// Only one check of a session runs at a time, so only one ever redeems its refresh token: the host names the execution
// after the check it replaces (the session's `role_checked_at`), so every request that finds the same stale role
// starts the same execution, and the flow engine runs it once. A check's last write moves `role_checked_at`: it records
// the role, or keeps it when GitHub or Postgres failed every attempt (`auth/KeepRole`). Only then can a request name the
// next check.

/**
 * The execution that checks session `sessionId` again: named after the check it replaces, the session's
 * `role_checked_at` in epoch milliseconds (`generation`), so every start for the same stale role is the same run.
 */
export const recheckExecutionId = (sessionId: string, generation: number): string =>
  `auth-recheck-${sessionId}-${generation}`

/** How long before a GitHub token's stated expiry the check refreshes it. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * What the check did: recorded the role, ended the session (GitHub refused it), found the session already over, or
 * kept the role after GitHub or Postgres failed every attempt.
 */
const Checked = Schema.Struct({
  outcome: Schema.Literals(["checked", "revoked", "ended", "kept"]),
  role: Schema.NullOr(Schema.Literals(ROLES)),
})
type Checked = typeof Checked.Type

/**
 * What redeeming the refresh token gave, sealed into the run's journal: nothing to redeem (the token isn't about to
 * expire, or the session holds none it can use), a refresh token missing or unopenable, one GitHub refused, or the
 * replacement GitHub issued, encrypted for the session. `presented` is the digest of the refresh token it presented.
 */
const Redemption = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none"), gen: Schema.optional(Schema.Number) }),
  Schema.Struct({ kind: Schema.Literals(["unusable", "refused"]), gen: Schema.optional(Schema.Number), presented: Schema.NullOr(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal("redeemed"),
    gen: Schema.optional(Schema.Number),
    presented: Schema.String,
    tokens: Schema.Struct({
      access: SessionStore.Sealed,
      pairDigest: Schema.optional(Schema.String),
      accessExpiresAt: Schema.NullOr(Schema.Number),
      refresh: Schema.NullOr(SessionStore.Sealed),
      refreshDigest: Schema.NullOr(Schema.String),
    }),
  }),
])
type Redemption = typeof Redemption.Type

/** The store classification. The old changed value remains decodable in persisted pre-fence histories. */
const Stored = Schema.Struct({ outcome: Schema.Literals(["stored", "installed_replay", "abandoned_enqueued", "none", "changed"]) })
type Stored = typeof Stored.Type

/** The check couldn't finish: GitHub was unavailable or refused the App, or Postgres failed. The step retries it. */
export class RoleCheckFailed extends Schema.TaggedError<RoleCheckFailed>()("@smthrs/mvp/auth/RoleCheckFailed", {
  reason: Schema.Literals(["github_unavailable", "github_misconfigured", "database"]),
}) {}

/**
 * Role check steps, by `step` (`redeem`, `store`, `check`, `keep`) and `outcome`: the step's own (`redeem`: `none`,
 * `unusable`, `refused`, `redeemed`; `store`: `stored`, `installed_replay`, `abandoned_enqueued`, `none`; `check` and `keep`: the check's), or
 * `failed` for one failed attempt.
 */
export const tokenStores = Metric.counter("smithers_auth_token_store", { incremental: true })

export const roleChecks = Metric.counter("smithers_auth_role_checks", {
  description: "Role check steps with GitHub, by step and outcome",
  incremental: true,
})

const payload = { sessionId: Schema.String }

/** A step that only GitHub or Postgres failing for a while can stop: five attempts from 1 second, doubling. */
const bounded = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, maxAttempts: 5 })

/** A step only Postgres can fail, and no later check can start until it records: its retries never give up. */
const unbounded = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

/** The first step: redeem the refresh token if the access token is about to expire, and seal the replacement. */
export const RedeemRefresh = Action.make("auth/RedeemRefresh", {
  payload,
  success: Redemption,
  error: RoleCheckFailed,
  capabilities: ["db:read:sessions"],
  tier: "sealed",
  retryPolicy: bounded,
})

/** The second step: store the sealed replacement over the refresh token it replaces, while the session is live. */
export const StoreTokens = Action.make("auth/StoreTokens", {
  payload: { ...payload, redemption: Redemption },
  success: Stored,
  error: RoleCheckFailed,
  capabilities: ["db:write:sessions", "db:write:github_token_cleanups"],
  retryPolicy: unbounded,
})

/** The third step: end a session GitHub refused, or read the person's permission and record the role. */
export const CheckRole = Action.make("auth/CheckRole", {
  payload: { ...payload, redemption: Redemption },
  success: Checked,
  error: RoleCheckFailed,
  capabilities: ["db:write:sessions", "db:write:host_sessions", "db:write:github_token_cleanups", "db:write:session_end_receipts"],
  retryPolicy: bounded,
})

/**
 * The step after a check that failed every attempt: keeps the role and records the check, so the next request that
 * finds it stale names a new one.
 */
export const KeepRole = Action.make("auth/KeepRole", {
  payload,
  success: Checked,
  error: RoleCheckFailed,
  capabilities: ["db:write:sessions"],
  retryPolicy: unbounded,
})

/** `auth/RecheckRole`: checks a session's role with GitHub again. */
export const RecheckRole = Flow.make("auth/RecheckRole", {
  description: "Check a session's role on the repository with GitHub again, refreshing its GitHub token if needed.",
  capabilities: ["db:read:sessions", "db:write:sessions", "db:write:host_sessions", "db:write:github_token_cleanups", "db:write:session_end_receipts"],
  modelInvocable: false,
  payload,
  success: Checked,
  error: RoleCheckFailed,
  body: Node.capture({}, (request) =>
    RedeemRefresh.call(request).pipe(
      Node.bindPlanned(Node.capture({}, (redemption) =>
        StoreTokens.call({ sessionId: request.sessionId, redemption }).pipe(
          Node.andThen(CheckRole.call({ sessionId: request.sessionId, redemption })),
        ))),
      Node.catch({ onFailure: () => KeepRole.call(request) }),
    )),
})

/** What the check needs besides Postgres: the session keys, GitHub, and the repository roles are read on. */
export interface Services {
  readonly keys: SessionKeys
  readonly github: GitHubAuth["Service"]
  readonly repository: string
}

const ended: Checked = { outcome: "ended", role: null }
const revoked: Checked = { outcome: "revoked", role: null }
const kept: Checked = { outcome: "kept", role: null }
const nothing: Redemption = { kind: "none" }

/** What a GitHub refusal means here: `rejected` ends the session; anything else fails the step. */
const isRejected = (error: GitHubRefused) => error.reason === "rejected"

/** Where a session's sealed token is bound: the session, and which token. */
const sealContext = (sessionId: string, name: "github_access" | "github_refresh") => ({
  id: sessionId,
  name,
  version: 1,
})

/**
 * Redeems session `sessionId`'s refresh token when its access token expires within `REFRESH_MARGIN_MS`, against the
 * `SqlClient` in context, and seals the replacement for the session. Writes nothing. Fails with GitHub's refusal when
 * GitHub was unavailable or refused the App, and with Postgres' failure.
 */
export const redeem = (sessionId: string, services: Services) =>
  Effect.gen(function* () {
    const { keys, github } = services
    const found = yield* SessionStore.held(sessionId)
    if (Option.isNone(found) || !found.value.live) return nothing
    const held = found.value
    if (held.access === null) return { kind: "none", gen: held.tokenGen } satisfies Redemption
    const expiring = held.accessExpiresAt !== null &&
      held.accessExpiresAt - (yield* Clock.currentTimeMillis) < REFRESH_MARGIN_MS
    if (!expiring) return { kind: "none", gen: held.tokenGen } satisfies Redemption
    const refreshToken = held.refresh === null
      ? Option.none()
      : yield* Effect.option(keys.open(held.refresh, sealContext(sessionId, "github_refresh")))
    if (Option.isNone(refreshToken) || held.refreshDigest === null) {
      return { kind: "unusable", gen: held.tokenGen, presented: held.refreshDigest } satisfies Redemption
    }
    const tokens = yield* github.refresh(refreshToken.value).pipe(
      Effect.map(Option.some),
      Effect.catchIf(isRejected, () => Effect.succeedNone),
    )
    if (Option.isNone(tokens)) return { kind: "refused", gen: held.tokenGen, presented: held.refreshDigest } satisfies Redemption
    const next = tokens.value
    return {
      kind: "redeemed",
      gen: held.tokenGen,
      presented: held.refreshDigest,
      tokens: {
        pairDigest: digest(Redacted.value(next.accessToken)),
        access: yield* keys.seal(next.accessToken, sealContext(sessionId, "github_access")),
        accessExpiresAt: next.expiresAt,
        refresh: next.refreshToken === null
          ? null
          : yield* keys.seal(next.refreshToken, sealContext(sessionId, "github_refresh")),
        refreshDigest: next.refreshToken === null ? null : digest(Redacted.value(next.refreshToken)),
      },
    } satisfies Redemption
  })

/**
 * Stores a redeemed replacement over the refresh token it replaced, only while the session is live and still holds
 * that token, against the `SqlClient` in context. Storing again recognizes its installed pair or durably enqueues an abandoned pair.
 */
export const store = (sessionId: string, redemption: Redemption, services?: Services) =>
  Effect.gen(function* () {
    if (redemption.kind !== "redeemed") return { outcome: "none" } satisfies Stored
    // Journals written before generation fencing decode too. Their generation is zero, before any reauthentication.
    const pairDigest = redemption.tokens.pairDigest ?? (services === undefined ? undefined
      : digest(Redacted.value(yield* services.keys.open(redemption.tokens.access, sealContext(sessionId, "github_access")))))
    if (pairDigest === undefined) return yield* new RoleCheckFailed({ reason: "database" })
    const result = yield* SessionStore.replaceTokens(sessionId, redemption.presented, { ...redemption.tokens, pairDigest }, redemption.gen ?? 0)
    yield* Metric.update(Metric.withAttributes(tokenStores, { outcome: result.outcome }), 1)
    yield* Effect.logInfo("auth.token_store").pipe(Effect.annotateLogs({ outcome: result.outcome }))
    if (result.outcome === "abandoned_enqueued") {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ id: string }>`SELECT id FROM github_token_cleanups WHERE pair_digest = ${pairDigest} AND finished_at IS NULL`
      if (row !== undefined) yield* Cleanup.start(row.id)
    }
    return result satisfies Stored
  })

/**
 * One check of session `sessionId` after its redemption, against the `SqlClient` in context: a refresh token missing,
 * unopenable or refused ends the session, but only while the session still holds the token presented; otherwise the
 * session's own current token reads the permission and the check records the role. Fails with GitHub's refusal when
 * GitHub was unavailable or refused the App, and with Postgres' failure.
 */
export const check = (sessionId: string, redemption: Redemption, services: Services) =>
  Effect.gen(function* () {
    const { keys, github, repository } = services
    const found = yield* SessionStore.held(sessionId)
    if (Option.isNone(found)) return ended
    const held = found.value
    if (!held.live || held.access === null) return ended
    if ((redemption.gen ?? 0) !== held.tokenGen) return kept
    const end = (reason: SessionStore.RevokedReason) => Effect.map(SessionStore.revokeIf(sessionId, reason, held.tokenGen), result =>
      Option.isSome(result) ? revoked : kept)
    // GitHub refused the refresh token, or there was none to present: that ends the session, unless the session changed
    // meanwhile (another check stored new tokens, say), when its own current token decides.
    if (
      (redemption.kind === "unusable" || redemption.kind === "refused") && held.refreshDigest === redemption.presented
    ) {
      return yield* end("github_refused")
    }
    const access = yield* Effect.option(keys.open(held.access, sealContext(sessionId, "github_access")))
    if (Option.isNone(access)) return yield* end("unreadable")
    const generation = yield* SessionStore.roleObservation
    const permission = yield* github.permission(access.value, repository).pipe(
      Effect.map(Option.some),
      Effect.catchIf(isRejected, () => Effect.succeedNone),
    )
    if (Option.isNone(permission)) return yield* end("github_refused")
    const role = yield* SessionStore.setRole(sessionId, roleOf(permission.value), generation, held.tokenGen)
    return { outcome: "checked", role } satisfies Checked
  })

/** A failure as a step reports it, by reason only: GitHub's refusal, or anything Postgres did. */
const failed = (error: unknown) =>
  new RoleCheckFailed({
    reason: !(error instanceof GitHubRefused)
      ? "database"
      : error.reason === "misconfigured"
      ? "github_misconfigured"
      : "github_unavailable",
  })

/**
 * One step over `database`, with its records: an `auth.role_check` log line and span, by `step`, and
 * `smithers_auth_role_checks`. None carries a token, a sealed token, a login or GitHub's text.
 */
const recorded = <A extends { readonly outcome: string } | { readonly kind: string }, E, R>(
  sessionId: string,
  step: "redeem" | "store" | "check" | "keep",
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
) =>
  effect.pipe(
    Effect.provide(database),
    Effect.tapError((error) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(roleChecks, { step, outcome: "failed" }), 1),
        Effect.logWarning("auth.role_check").pipe(
          Effect.annotateLogs({ sessionId, step, outcome: "failed", errorCode: codeOf(error) }),
        ),
      )
    ),
    Effect.mapError(failed),
    Effect.tap((result) => {
      const outcome = "kind" in result ? result.kind : result.outcome
      const role = "role" in result ? { role: (result.role as string | null) ?? "none" } : {}
      return Effect.andThen(
        Metric.update(Metric.withAttributes(roleChecks, { step, outcome }), 1),
        Effect.logInfo("auth.role_check").pipe(Effect.annotateLogs({ sessionId, step, outcome, ...role })),
      )
    }),
    Effect.withSpan("auth.role_check", {
      attributes: { "smithers.auth.session_id": sessionId, "smithers.auth.step": step },
    }),
  )

/** The steps over `database` and `services`, each with its records. */
export const steps = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, services: Services) => ({
  redeem: (sessionId: string) => recorded(sessionId, "redeem", redeem(sessionId, services), database),
  store: (sessionId: string, redemption: Redemption) =>
    recorded(sessionId, "store", store(sessionId, redemption, services), database),
  check: (sessionId: string, redemption: Redemption) =>
    recorded(sessionId, "check", check(sessionId, redemption, services), database),
  /** Keeps the session's role after a check that failed every attempt. */
  keep: (sessionId: string) => recorded(sessionId, "keep", Effect.gen(function* () {
    const held = yield* SessionStore.held(sessionId)
    if (Option.isSome(held)) yield* SessionStore.keepRole(sessionId, held.value.tokenGen)
    return kept
  }), database),
})

/** Registers `auth/RecheckRole` with its steps, reaching Postgres through `database` and GitHub through `services`. */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, services: Services) => {
  const implemented = steps(database, services)
  return Interpreter.layerWithImplementations(
    RecheckRole,
    Layer.mergeAll(
      RedeemRefresh.toLayer(({ sessionId }) => implemented.redeem(sessionId)),
      StoreTokens.toLayer(({ sessionId, redemption }) => implemented.store(sessionId, redemption)),
      CheckRole.toLayer(({ sessionId, redemption }) => implemented.check(sessionId, redemption)),
      KeepRole.toLayer(({ sessionId }) => implemented.keep(sessionId)),
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}
