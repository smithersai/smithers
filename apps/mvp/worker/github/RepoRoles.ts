import { rankOf } from "../Actor.ts"
import { GitHub } from "@smthrs/integrations"
import { Clock, Config, Duration, Effect, Function, type Layer, Metric, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import * as SchemaIssue from "effect/SchemaIssue"
import { SqlClient } from "effect/sql"
import { ROLES } from "../../src/features/auth/contract.ts"
import type { Actor, Role } from "../Actor.ts"
import { type Permission, roleOf } from "../GitHubAuth.ts"
import { classify, isRateLimited, statusOf, withToken } from "./Calls.ts"
import { type GitHubApp, type Repository, repositoryOf } from "./Config.ts"
import * as Tokens from "./Tokens.ts"
import { requestRay } from "../RequestRay.ts"
import * as Visibility from "./Visibility.ts"
import * as ReadToken from "./ReadToken.ts"
import { DEFAULT_API_URL } from "./Config.ts"
import * as FeedLocks from "../FeedLocks.ts"
import { FRESH_SECONDS } from "./RoleAge.ts"
export { FRESH_SECONDS } from "./RoleAge.ts"
import * as SessionStore from "../SessionStore.ts"
import * as VisibilityReceipt from "./VisibilityReceipt.ts"

// A person's role on one repository (decision 0079). On the deployment's own repository (`GITHUB_REPOSITORY`) it is
// the session's role, as sign-in reads and rechecks it. On any other repository the deployment may act on, one where
// the App is installed and that `GITHUB_ALLOWED_REPOSITORIES` doesn't leave out, it is the person's GitHub permission
// there, read with an installation token minted for that repository with `metadata: read` for the login and account id
// sign-in recorded, mapped as decision 0007 §9 says, and kept in `github_repo_roles` for `FRESH_SECONDS`. A stale row is read again before it decides anything, and
// when GitHub can't answer, the refusal says so; a stale row never decides. Every route that acts on a repository asks
// `resolve`; a write's transaction asks `holds` (0079 §6).

/** How long a confirmed missing installation is reused by repository-role recovery. */
export const APP_ABSENCE_SECONDS = 60

/**
 * After GitHub failed or overran a read of a person's role on a repository, how long every request for them there is
 * refused without asking, in seconds, kept in the row (`read_failed`, migration 0090), so it holds across isolates. A
 * rate limit cools for GitHub's own wait instead, when it said one. `refreshCooldownSeconds: 0` cools nothing.
 */
export const REFRESH_COOLDOWN_SECONDS = 10

/**
 * How long a request may take to resolve a role from a row that isn't fresh, in all: its looks at the row, its claim,
 * GitHub (whose own client would wait up to 30 s) and its cleanup. No transaction or connection is held while GitHub
 * answers. Known bound: see docs/features/issues.md (a transaction's start and the driver's cancel drain).
 */
export const READ_DEADLINE: Duration.Input = "10 seconds"

/** How soon a request waiting for another's read of the same row first looks again; it waits twice as long each time. */
const READ_POLL_MILLIS = 150
/** The longest a waiting request goes between looks. */
const READ_POLL_MAX_MILLIS = 1_000
/**
 * Postgres' own bounds on a cleanup's statements. The request waits for a cleanup only as long as its deadline leaves
 * (`readExpired`); one that outlives the request finishes or fails on its own, and its lease expires regardless.
 */
const CLEANUP_LOCK_MILLIS = 2_000
const CLEANUP_STATEMENT_MILLIS = 3_000
/** What a read keeps of its deadline for recording what happened: this, or a quarter of a shorter deadline. */
const CLEANUP_MILLIS = 1_000


/** Why `resolve` gave no role: each with its status, and GitHub's wait when it said one (decision 0079 §7). */
export const REFUSALS = {
  not_configured: 503,
  not_found: 404,
  app_not_installed: 404,
  rate_limited: 429,
  github_unavailable: 503,
  unavailable: 503,
} as const
export type Refusal = keyof typeof REFUSALS

/** Finite operation names only: provider messages and SQL text never enter diagnostics. */
const stages = ["configuration", "allowlist", "database", "row_read", "claim", "account_read", "app_auth", "installation_token", "permission", "metadata", "visibility_record", "role_record", "deadline", "cooldown"] as const

export class RoleRefused extends Schema.TaggedError<RoleRefused>()("@smthrs/mvp/github/RoleRefused", {
  code: Schema.Literals(Object.keys(REFUSALS) as Array<Refusal>),
  retryAfterSeconds: Schema.optional(Schema.Number),
  stage: Schema.optional(Schema.Literals(stages)),
  upstreamStatus: Schema.optional(Schema.Number),
  cooldown: Schema.optional(Schema.Boolean),
}) {}

/** The existing role-read outcome line's content-free refusal fields, also used by route outcome lines. */
export const refusalFields = (refused: RoleRefused) => ({
  code: refused.code,
  stage: refused.stage ?? "database",
  upstreamStatus: refused.upstreamStatus ?? null,
  retryAfterSeconds: refused.retryAfterSeconds ?? null,
  failureSource: refused.cooldown === true ? "held_cooldown" : "fresh",
})

/**
 * The refusals that say the deployment can't act on the repository, so nobody holds a role GitHub gives there: no App
 * on this deployment, `GITHUB_ALLOWED_REPOSITORIES` leaving it out, or the App not installed on it (§4, §7). The rest
 * say GitHub or Postgres couldn't answer now.
 */
export const CANT_ACT: ReadonlySet<Refusal> = new Set(["not_configured", "not_found", "app_not_installed"])

/**
 * The row a write's transaction must still find (`holds`): the person's role on a repository other than the
 * deployment's own, as `resolve` read it. None on the deployment's own repository, whose role is the session's.
 */
export interface Held {
  readonly repoId: string
  readonly personId: string
  readonly role: Role | null
  /** When the row the request read was checked (Postgres text): a write admits only that read or a newer one. */
  readonly checkedAt?: string
  /** An explicitly shorter receipt window, when the resolver was configured with one. */
  readonly freshSeconds?: number
}

/** A person's role on a repository, and the row that role came from, when it came from one. */
export interface Resolved {
  readonly role: Role | null
  readonly held: Option.Option<Held>
}

/** Role reads, by `source` (`session`, `cached`, `github`) and `outcome` (the role, `none`, or the refusal's code). */
export const reads = Metric.counter("smithers_github_repo_roles", {
  description: "Roles resolved on a repository, by source and outcome",
  incremental: true,
})

/** A comma-separated list of `owner/name`s. */
const repositoryList = /^\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\s*,\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)*\s*$/

/**
 * `GITHUB_ALLOWED_REPOSITORIES`: the repositories, besides the deployment's own, it may act on, as their ids; unset or
 * blank, every repository the App is installed on. A malformed list fails the deployment's config, never a request.
 */
export const allowed = Effect.gen(function* () {
  const text = yield* Config.option(Config.String("GITHUB_ALLOWED_REPOSITORIES"))
  if (Option.isNone(text) || text.value.trim() === "") return Option.none<ReadonlySet<string>>()
  if (!repositoryList.test(text.value)) {
    return yield* Effect.fail(new Config.ConfigError(
      new Schema.SchemaError(
        new SchemaIssue.InvalidValue({
          message: "GITHUB_ALLOWED_REPOSITORIES is not a comma-separated list of owner/name",
        }),
      ),
    ))
  }
  return Option.some<ReadonlySet<string>>(new Set(text.value.split(",").map((name) => repositoryOf(name.trim()).id)))
})

/** Whether a deployment with the App acts on repository `id` (decision 0079 §4): its own, or any other `allowed` keeps. */
export const actsOn = (own: Repository, allowed: Option.Option<ReadonlySet<string>>) => (id: string) =>
  id === own.id || Option.match(allowed, { onNone: () => true, onSome: (ids) => ids.has(id) })

/**
 * GitHub's answer as a `Permission` (decision 0079 §3): the role it names when it is one of GitHub's five, else an
 * organization's custom role at its base permission, never above write, because a custom role's base can't be told
 * from GitHub's legacy `permission` beyond that.
 */
export const permissionOf = (answer: GitHub.Collaborators.Permission): Permission => {
  switch (answer.roleName) {
    case "admin":
    case "maintain":
    case "write":
    case "triage":
    case "read":
      return answer.roleName
  }
  return answer.permission === "admin" || answer.permission === "write"
    ? "write"
    : answer.permission === "read"
    ? "read"
    : "none"
}

const decodeRole = Schema.decodeUnknownSync(Schema.NullOr(Schema.Literals(ROLES)))

/**
 * With `permitted`, a deferred write checks the current role against its required permissions instead of equality
 * with the queued role; an expired observation fails transiently so the durable step can refresh and retry.
 * Inside a write's transaction: whether the person's `github_repo_roles` row still holds `held.role`, is the read the
 * request decided with or a newer one, and is fresh now. Locked `FOR SHARE` first, so a refresh that changes it waits
 * for the write, or the write sees the change (decision 0079 §6). Freshness is a second statement, by the database's
 * clock once the lock is granted (`clock_timestamp()`): Postgres computes a locking `SELECT`'s columns before it waits
 * for the row, so one statement would judge a row released unchanged after it expired by the clock before the wait.
 */
export const checkHeld = (held: Held, permitted?: ReadonlyArray<Role>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly role: string | null; readonly checkedAt: string }>`
      SELECT role, checked_at::text AS "checkedAt" FROM github_repo_roles
      WHERE repo_id = ${held.repoId} AND person_id = ${held.personId}
      FOR SHARE`
    if (row === undefined) return "unavailable" as const
    const role = decodeRole(row.role)
    const allowed = permitted === undefined ? role === held.role : role !== null && permitted.includes(role)
    if (permitted === undefined && !allowed) return "denied" as const
    const [now] = yield* sql<{ readonly fresh: boolean; readonly same: boolean }>`
      SELECT ${row.checkedAt}::timestamptz > clock_timestamp() - make_interval(secs => ${held.freshSeconds ?? FRESH_SECONDS}) AS fresh,
        ${held.checkedAt === undefined ? sql`true` : sql`${row.checkedAt}::timestamptz >= ${held.checkedAt}::timestamptz`} AS same`
    // A deferred operation needs a fresh observation, not permanent refusal because its queued read aged out.
    if (permitted !== undefined && !now!.fresh) return yield* new RoleRefused({ code: "unavailable", retryAfterSeconds: 1 })
    if (!now!.fresh || !now!.same) return "unavailable" as const
    return allowed ? "held" as const : "denied" as const
  })

/** Boolean admission for callers that already treat any lost observation as retryable. */
export const holds = (held: Held, permitted?: ReadonlyArray<Role>) =>
  Effect.map(checkHeld(held, permitted), outcome => outcome === "held")

/** What `make` needs: the deployment's own repository, the App when it is configured, and how far it may act. */
export interface Options {
  readonly repository: Repository
  readonly app: Option.Option<GitHubApp>
  /** `GITHUB_ALLOWED_REPOSITORIES`; none, every repository the App is installed on. */
  readonly allowed?: Option.Option<ReadonlySet<string>>
  /** How the reads reach GitHub: `fetch` unless set. */
  readonly http?: HttpClient.HttpClient
  /**
   * Local development without the App (`alchemy dev`'s developer, worker/DevChatApi.ts): there is no GitHub to ask, so
   * the session's role holds on every repository, as it did before decision 0079, unless `localRoles` names another. A
   * deploy never sets it.
   */
  readonly local?: boolean
  /** With `local`, local development's people's roles on other repositories (`LocalRoles`). */
  readonly localRoles?: LocalRoles
  /** `REFRESH_COOLDOWN_SECONDS` unless set; `0` cools nothing, a rate limit included (tests of each refusal). */
  readonly refreshCooldownSeconds?: number
  /** A shorter authority window; never exceeds FRESH_SECONDS. */
  readonly freshSeconds?: number
  /** `READ_DEADLINE` unless set. */
  readonly refreshDeadline?: Duration.Input
}

/**
 * Local development's roles on a repository other than the deployment's own (worker/DevChatApi.ts `devRoles`), so the
 * end-to-end tests have a person who is Admin or Guest of a repository without GitHub to ask: a role, `null` for none,
 * or `undefined` for the session's.
 */
export type LocalRoles = (actor: Actor, repository: Repository) => Role | null | undefined

/** What authorizes work on a copy: one repository, deployment membership, a public copy or explicit local grants. */
export type WorkBasis = "repository" | "deployment" | "public" | "local"

/** The `RepoRoles` interface every route asks; `R` is what its database's layer needs. */
export interface RepoRoles<R = never> {
  /** The deployment's own repository. */
  readonly repository: Repository
  /** The configured work-grant route, including public fallback for excluded/unconfigured repositories. */
  readonly workBasis?: (repository: Repository, installed: boolean) => WorkBasis
  /** The permission receipt window this resolver actually uses. */
  readonly freshSeconds?: number
  /** `actor`'s role on `repository`, or why there is none to give. */
  readonly resolve: (actor: Actor, repository: Repository) => Effect.Effect<Resolved, RoleRefused, R>
  /**
   * What a write does once its transaction found the row it `read` expired or changed: the row a newer read recorded,
   * when one is fresh, else GitHub asked again. One refresh per person and repository at a time: the others wait for
   * it and take its row. Absent: the write is refused, as before.
   */
  readonly refresh?: (actor: Actor, repository: Repository, read: Held) => Effect.Effect<Resolved, RoleRefused, R>
  /**
   * `actor`'s role on a repository Smithers recorded no App installation on, asking no one: the session's, as before
   * decision 0079, or local development's own (`localRoles`). Absent, the session's.
   */
  readonly uninstalled?: (actor: Actor, repository: Repository) => Role | null
  /** Work without an installation requires a recorded public repository; local development may supply its own role. */
  readonly workUninstalled?: (actor: Actor, repository: Repository) => Effect.Effect<Role | null, RoleRefused, R>
}

/** What `make` reads from the deployment's configuration: the read token's settings and the visibility API's origin. */
export interface ConfigReads {
  readonly token: ReadToken.Settings
  readonly visibilityApi: string
}

/** Reads `ConfigReads` for a deployment whose App is `app`: a host that builds `RepoRoles` at runtime reads them while building. */
export const configuredReads = (app: Option.Option<GitHubApp>) => Effect.gen(function* () {
  const token = yield* ReadToken.settings
  const visibilityApi = Option.isSome(app) ? app.value.apiBaseUrl :
    yield* Config.String("GITHUB_API_URL").pipe(Config.withDefault(DEFAULT_API_URL))
  return { token, visibilityApi } satisfies ConfigReads
})

/** `RepoRoles` over `database`: `resolve` opens a Postgres client for each read. */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, options: Options) =>
  Effect.flatMap(configuredReads(options.app).pipe(Effect.orDie), (captured) => makeWith(database, options, captured))

/** `make` over `captured`, the configuration a host read while building: it reads none itself. */
export const makeWith = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, options: Options, captured: ConfigReads) =>
  Effect.gen(function* () {
    const allowedIds = options.allowed ?? Option.none()
    const freshSeconds = Math.min(FRESH_SECONDS, Math.max(0.001, options.freshSeconds ?? FRESH_SECONDS))
    const http = options.http
    const client = <A, X, Y>(effect: Effect.Effect<A, X, Y>): Effect.Effect<A, X, Exclude<Y, HttpClient.HttpClient>> =>
      http === undefined
        ? Effect.provide(effect, FetchHttpClient.layer)
        : Effect.provideService(effect, HttpClient.HttpClient, http)
    // Build the signer in each request; never share its in-flight key import.
    const app: Option.Option<{
      readonly config: GitHubApp
      readonly auth: Effect.Effect<GitHub.AppAuth.AppAuth, unknown>
    }> = Option.isSome(options.app)
      ? Option.some({
        config: options.app.value,
        auth: GitHub.AppAuth.make({
          appId: options.app.value.appId,
          privateKey: options.app.value.privateKey,
          apiBaseUrl: options.app.value.apiBaseUrl,
        }).pipe(client),
      })
      : Option.none()

    const readToken = yield* ReadToken.fromSettings(captured.token).pipe(client)
    const visibilityApi = captured.visibilityApi

    /** The role where there is no App to ask: local development's own, else the session's. */
    const uninstalled = (actor: Actor, repository: Repository): Role | null => {
      const local = options.local === true ? options.localRoles?.(actor, repository) : undefined
      return local === undefined ? actor.role : local
    }

    /** The person's permission on `repository`, read with the App; `None` when GitHub knows no such person there. */
    const fromGitHub = (configured: NonNullable<Option.Option.Value<typeof app>>, repository: Repository, login: string, stages: Stages) =>
      Effect.gen(function* () {
        const auth = yield* timed(stages, "authMs", configured.auth.pipe(Effect.mapError((error) => refusedFor(error, "app_auth"))))
        const tokens = Tokens.make({
          app: { ...auth, installationToken: (request) => timed(stages, "mintMs", auth.installationToken(request)) },
          // Installation tokens only: no session's token to refresh.
          keys: Option.none(),
          refresh: Function.constant(Effect.void),
        })
        const token = yield* timed(stages, "tokenMs", tokens.forInstallation(repository, "metadata")).pipe(
          Effect.catch((error) => error.reason === "app_not_installed"
            ? Effect.andThen(rememberAbsence(repository.id).pipe(Effect.mapError(() => new RoleRefused({ code: "unavailable", stage: "role_record" }))),
              Effect.fail(new RoleRefused({ code: "app_not_installed", stage: "installation_token", upstreamStatus: error.upstreamStatus })))
            : Effect.fail(new RoleRefused({ code: error.rateLimited === true ? "rate_limited" : "github_unavailable",
              stage: "installation_token", upstreamStatus: error.upstreamStatus, ...waitOf(error.retryAfterMillis) }))),
        )
        return yield* timed(stages, "permissionMs", GitHub.Collaborators.permission(repository.owner, repository.name, login).pipe(
          withToken(token, configured.config.apiBaseUrl),
          Effect.mapError((error) => refusedFor(error, "permission")),
        ))
      }).pipe(client)

    /** A query of `fromRow`'s: Postgres failing is `unavailable`. */
    const inDatabase = <A, X>(effect: Effect.Effect<A, X, SqlClient.SqlClient>, stage: NonNullable<RoleRefused["stage"]> = "database") =>
      Effect.mapError(effect, () => new RoleRefused({ code: "unavailable", stage }))

    /** The role and where it came from (`session`, `cached`, `github`, `refresh`, `reused`). */
    const decide = (actor: Actor, repository: Repository, read?: Held) =>
      Effect.gen(function* () {
        // The deployment's role is a confirmed session receipt, with the same freshness bound as sign-in.
        if (repository.id === options.repository.id) {
          const role = yield* SessionStore.freshRole(actor).pipe(
            Effect.provide(database), Effect.mapError(() => new RoleRefused({ code: "unavailable", retryAfterSeconds: 5 })),
          )
          return { source: "session", resolved: { role, held: Option.none<Held>() } }
        }
        if (Option.isNone(app)) {
          if (options.local === true) return { source: "local", resolved: { role: uninstalled(actor, repository), held: Option.none<Held>() } }
          return yield* new RoleRefused({ code: "not_configured", stage: "configuration" })
        }
        if (Option.isSome(allowedIds) && !allowedIds.value.has(repository.id)) {
          return yield* new RoleRefused({ code: "not_found", stage: "allowlist" })
        }
        // One Postgres client for the reads, the App's installation and the record; one that can't be had is
        // `unavailable`.
        return yield* (read === undefined
          ? fromRow(actor, repository, app.value)
          : Effect.flatMap(deadlineFromNow, (endsAt) => readExpired(actor, repository, app.value, read.checkedAt, "refresh", endsAt))).pipe(
          Effect.provide(database),
          Effect.mapError((error) => (error instanceof RoleRefused ? error : new RoleRefused({ code: "unavailable" }))),
        )
      })

    /** The role on another repository: the fresh row, else GitHub's answer, recorded. */
    const fromRow = (actor: Actor, repository: Repository, configured: NonNullable<Option.Option.Value<typeof app>>) =>
      Effect.gen(function* () {
        const endsAt = yield* deadlineFromNow
        // The first read of the row, bounded by Postgres itself at the request's deadline (`bounded`), so a lock on the
        // table can't hold it past the deadline whatever the client's cancellation does. Only a row that isn't fresh goes
        // on to `readExpired`.
        const state = yield* within(endsAt, inDatabase(readState(repository.id, actor.subject.id, undefined, freshSeconds), "row_read"))
        if (Option.isSome(state.fresh)) return { source: "cached", resolved: heldBy(repository, actor, state.fresh.value, freshSeconds) }
        return yield* readExpired(actor, repository, configured, undefined, "github", endsAt)
      })

    /** When a request that starts now must have answered: `READ_DEADLINE`, or the deadline `options` set. */
    const deadlineFromNow = Effect.map(
      Clock.currentTimeMillis,
      (now) => now + Duration.toMillis(options.refreshDeadline ?? READ_DEADLINE),
    )

    /**
     * Every read of a row that isn't fresh, a request's (`github`) or a write's second (`refresh`, newer than `after`,
     * the row its transaction refused). One request per repository and person claims the read (`claimRead`), asks
     * GitHub outside any transaction and records the answer; the others poll for a fresh row newer than theirs and take
     * it (`reused`), holding no transaction or lock meanwhile, so a burst for one expired row holds no Postgres
     * connection while GitHub answers. A read GitHub failed or overran keeps its claim for the cooldown, counted from the
     * failure, and the next is refused with that wait (`503 unavailable`, `Retry-After`). An absent App cools nothing; rate limits retain their own wait. A request waits `READ_DEADLINE` in all.
     */
    const coordinatedRead = <A>(operations: {
      readonly state: Effect.Effect<{
        readonly fresh: Option.Option<A>
        readonly claim: { readonly failed: boolean; readonly refusal: "unavailable" | "rate_limited"; readonly remainingSeconds: number } | undefined
      }, unknown, SqlClient.SqlClient>
      readonly claim: (leaseMillis: number) => Effect.Effect<Option.Option<string>, unknown, SqlClient.SqlClient>
      readonly read: Effect.Effect<A, RoleRefused, SqlClient.SqlClient>
      readonly release: (lease: string) => Effect.Effect<unknown, unknown, SqlClient.SqlClient>
      readonly cool: (lease: string, millis: number, refusal: "unavailable" | "rate_limited") => Effect.Effect<Option.Option<number>, unknown, SqlClient.SqlClient>
      readonly clampWait?: (millis: number) => number
    }, source: "github" | "refresh", endsAt: number) =>
      Effect.gen(function* () {
        const deadline = Duration.toMillis(options.refreshDeadline ?? READ_DEADLINE)
        const cooldownSeconds = options.refreshCooldownSeconds ?? REFRESH_COOLDOWN_SECONDS
        // One deadline for the whole request, from its first look at the row: looking, claiming, GitHub and the cleanup
        // after it, each wait on Postgres included (`within`).
        const cleanup = Math.min(CLEANUP_MILLIS, deadline / 4)
        const left = Effect.map(Clock.currentTimeMillis, (now) => endsAt - now)
        const unavailable = new RoleRefused({ code: "unavailable", retryAfterSeconds: 1, stage: "deadline" })
        let pause = READ_POLL_MILLIS
        while (true) {
          // One read of the row: a fresh read newer than this request's, or the claim another holds.
          const state = yield* within(endsAt, inDatabase(operations.state, "row_read"))
          if (Option.isSome(state.fresh)) return { source: "reused", resolved: state.fresh.value }
          if (state.claim?.failed === true) {
            return yield* new RoleRefused({ code: state.claim.refusal, stage: "cooldown", cooldown: true, retryAfterSeconds: Math.max(1, Math.ceil(state.claim.remainingSeconds)) })
          }
          if (state.claim === undefined) {
            const remaining = yield* left
            if (remaining <= cleanup) return yield* unavailable
            // Claimed only while the row still needs reading, its lease from when the claim got the row, outliving this
            // request's deadline a little so a worker that died mid-read frees the row soon after.
            const claimed = yield* within(endsAt, inDatabase(operations.claim(remaining + 2_000), "claim"))
            if (Option.isSome(claimed)) {
              const lease = claimed.value
              const read = yield* operations.read.pipe(
                Effect.timeoutOrElse({
                  duration: Duration.millis(Math.max(0, (yield* left) - cleanup)),
                  orElse: () => Effect.fail(new RoleRefused({ code: "unavailable", stage: "deadline" })),
                }),
                Effect.result,
              )
              // When GitHub refused or the read overran: the hold runs from then, not from when its cleanup gets the row.
              // Monotonic, so the Worker's wall clock (which may be off from the database's) never enters the hold.
              const failedAt = (yield* Clock.Clock).monotonicTimeNanosUnsafe()
              // GitHub or Postgres not answering, or the deadline, cools the next reads for the cooldown; a rate limit for
              // GitHub's own wait, else the cooldown. The App not installed there is an answer, and cools nothing.
              const failure = read._tag === "Failure" ? read.failure : undefined
              const refusal = failure?.code === "rate_limited"
                ? "rate_limited" as const
                : failure?.code === "github_unavailable" || failure?.code === "unavailable"
                ? "unavailable" as const
                : undefined
              const coolSeconds = refusal === "rate_limited" ? failure?.retryAfterSeconds ?? cooldownSeconds : cooldownSeconds
              const cools = refusal !== undefined && cooldownSeconds > 0
              // The cleanup has what is left of the deadline, at least a moment: one that can't finish leaves the lease
              // to expire on its own.
              // What is left of the wait since the refusal, by the Worker's monotonic clock: the database adds
              // it to its cleanup transaction's start, before any wait for a lock, in its own clock.
              const remainingMillis = Effect.map(Effect.service(Clock.Clock), (clock) =>
                (operations.clampWait ?? clampHold)(coolSeconds * 1000 - Number(clock.monotonicTimeNanosUnsafe() - failedAt) / 1e6))
              const held = yield* (cools
                ? Effect.flatMap(remainingMillis, (millis) => operations.cool(lease, millis, refusal!))
                : Effect.as(operations.release(lease), Option.none<number>())).pipe(
                  inDatabase,
                  Effect.timeoutOrElse({ duration: Duration.millis(Math.max(100, yield* left)), orElse: () => Effect.succeed(Option.none<number>()) }),
                  Effect.orElseSucceed(() => Option.none<number>()),
                )
              if (read._tag === "Failure") {
                // The next request for this person and repository is refused for the cooldown: say so.
                if (!cools) return yield* read.failure
                // What is left of the hold, as the database recorded it; else as this Worker counts it.
                const leftMillis = Option.isSome(held) ? held.value : yield* remainingMillis
                return yield* new RoleRefused({ ...read.failure, retryAfterSeconds: Math.max(1, Math.ceil(leftMillis / 1000)) })
              }
              return { source, resolved: read.success }
            }
            // Another request claimed it, or read it, first: look again.
            continue
          }
          const remaining = yield* left
          if (remaining <= 0) return yield* unavailable
          yield* Effect.sleep(Duration.millis(Math.min(pause, remaining)))
          pause = Math.min(pause * 2, READ_POLL_MAX_MILLIS)
        }
      })


    const readExpired = (
      actor: Actor, repository: Repository, configured: NonNullable<Option.Option.Value<typeof app>>,
      after: string | undefined, source: "github" | "refresh", endsAt: number,
    ) => coordinatedRead({
      state: Effect.map(readState(repository.id, actor.subject.id, after, freshSeconds), (state) => ({
        ...state, fresh: Option.map(state.fresh, (row) => heldBy(repository, actor, row, freshSeconds)),
      })),
      claim: (millis) => claimRead(repository.id, actor.subject.id, after, millis, freshSeconds),
      read: fromGitHubRecorded(actor, repository, configured),
      release: (lease) => releaseRead(repository.id, actor.subject.id, lease),
      cool: (lease, millis, refusal) => coolRead(repository.id, actor.subject.id, lease, millis, refusal),
    }, source, endsAt)

    /** GitHub's answer for the person on `repository`, recorded, as the row that decides after the record. */
    const fromGitHubRecorded = (
      actor: Actor,
      repository: Repository,
      configured: NonNullable<Option.Option.Value<typeof app>>,
    ) => {
      const stages: Stages = {}
      return Effect.gen(function* () {
        const personId = actor.subject.id
        // Who the person is on GitHub is sign-in's `people` row to say, never a request: their login to ask about and
        // their account's id, which the answer must name, because a login can change hands after a rename. `asOf` is
        // when this read began: an older read never overwrites a newer one.
        const { asOf, account, absent } = yield* timed(stages, "accountMs", inDatabase(observe(personId, repository.id), "account_read"))
        if (absent) return yield* new RoleRefused({ code: "app_not_installed" })
        const answer = Option.isNone(account)
          ? Option.none<GitHub.Collaborators.Permission>()
          : yield* fromGitHub(configured, repository, account.value.login, stages)
        const sameAccount = Option.isSome(account) && Option.isSome(answer) &&
          answer.value.userId === account.value.githubId
        if (Option.isSome(answer) && !sameAccount) {
          yield* Effect.logWarning("github.repo_role.account").pipe(
            Effect.annotateLogs({ repoId: repository.id, outcome: "another_account" }),
          )
        }
        // What decides is the row as it stands after this read: a later read's, when one already landed.
        const kept = yield* timed(stages, "recordMs", inDatabase(
          remember(repository.id, personId, sameAccount ? roleOf(permissionOf(answer.value)) : null, asOf, freshSeconds),
          "role_record",
        ))
        // A read slow enough that its row expired before it returned decides nothing: decision 0079's five minutes run
        // from when the read began.
        if (!kept.fresh) return yield* new RoleRefused({ code: "unavailable", stage: "role_record" })
        return heldBy(repository, actor, kept, freshSeconds)
      }).pipe(Effect.onExit(() =>
        Effect.flatMap(requestRay, (ray) =>
          Effect.logInfo("github.repo_role.stages").pipe(Effect.annotateLogs({ repoId: repository.id, ray: ray ?? "none", ...stages })))
      ))
    }

    /** The shared claimant alone asks GitHub; the receipt always dates when its observation began. */
    const readVisibility = (repository: Repository) => Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const observedAt = yield* VisibilityReceipt.repositoryObservation
      const answer = yield* Effect.flatMap(HttpClient.HttpClient, (transport) =>
        Visibility.readDetailed(repository, visibilityApi, readToken, transport)).pipe(client)
      const visible = answer.visible
      if (Option.isNone(visible)) return yield* new RoleRefused({
        code: answer.rateLimited ? "rate_limited" : "unavailable", retryAfterSeconds: answer.retryAfterSeconds ?? 5,
        stage: "metadata", upstreamStatus: answer.upstreamStatus,
      })
      const recorded = yield* VisibilityReceipt.recordRepository(repository.id, { private: !visible.value }, observedAt)
      // A rejected update lost to a newer commit. Read it in a new statement (the insert's snapshot predates
      // any concurrent writer it waited for), and validate that winning receipt before using it.
      const winning = recorded ?? (yield* sql<{ readonly public: boolean; readonly fresh: boolean }>`
        SELECT private = false AS public,
          visibility_verified_at > clock_timestamp() - interval '60 seconds'
            AND visibility_verified_at <= clock_timestamp() AS fresh
        FROM github_repositories WHERE repo_id = ${repository.id}`)[0]
      if (winning?.fresh !== true) return yield* new RoleRefused({ code: "unavailable", retryAfterSeconds: 1, stage: "visibility_record" })
      return winning.public
    }).pipe(Effect.mapError((error) => error instanceof RoleRefused ? error : new RoleRefused({ code: "unavailable" })))

    const visibility = (repository: Repository) => Effect.gen(function* () {
      const result = yield* coordinatedRead({
        state: visibilityState(repository.id),
        claim: (millis) => claimVisibilityRead(repository.id, millis),
        read: readVisibility(repository),
        release: (lease) => releaseVisibilityRead(repository.id, lease),
        cool: (lease, millis, refusal) => coolVisibilityRead(repository.id, lease, millis, refusal),
        // Unlike role provider errors (which the integrations client caps), metadata retains the full Retry-After.
        clampWait: (millis) => Number.isFinite(millis) ? Math.max(0, millis) : 0,
      }, "github", yield* deadlineFromNow)
      return result.resolved
    })

    /** `decide`, logged (`github.repo_role`: source, outcome, duration; never a login) and counted. */
    const resolve = (actor: Actor, repository: Repository, read?: Held): Effect.Effect<Resolved, RoleRefused, R> =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const decided = yield* decide(actor, repository, read).pipe(Effect.result)
        const source = decided._tag === "Success" ? decided.success.source : "refused"
        const outcome = decided._tag === "Success" ? decided.success.resolved.role ?? "none" : decided.failure.code
        yield* Metric.update(Metric.withAttributes(reads, { source, outcome }), 1)
        const ray = yield* requestRay
        yield* Effect.logWithLevel(decided._tag === "Success" ? "Info" : "Warn")("github.repo_role").pipe(
          Effect.annotateLogs({
            repoId: repository.id,
            ray: ray ?? "none",
            ...(decided._tag === "Failure" ? refusalFields(decided.failure) : {}),
            source,
            outcome,
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          }),
        )
        if (decided._tag === "Failure") return yield* decided.failure
        return decided.success.resolved
      }).pipe(Effect.withSpan("github.repo_role"))

    return {
      repository: options.repository,
      freshSeconds,
      workBasis: (repository, installed): WorkBasis => {
        if (repository.id === options.repository.id) return "deployment"
        if (!installed) return options.local === true ? "local" : "public"
        if (Option.isNone(app)) return options.local === true ? "local" : "public"
        if (Option.isSome(allowedIds) && !allowedIds.value.has(repository.id)) return options.local === true ? "local" : "public"
        return "repository"
      },
      resolve: (actor, repository) => resolve(actor, repository),
      refresh: (actor, repository, read) => resolve(actor, repository, read),
      uninstalled,
      // Installation discovery and public metadata cannot demote the deployment's confirmed session role.
      workUninstalled: (actor, repository) => repository.id === options.repository.id
        ? Effect.map(resolve(actor, repository), (resolved) => resolved.role)
        : options.local === true
        ? Effect.succeed(uninstalled(actor, repository))
        : Effect.gen(function* () {
          const publicNow = yield* visibility(repository)
          if (!publicNow) return null
          return yield* SessionStore.freshRole(actor)
        }).pipe(Effect.provide(database), Effect.mapError((error) => error instanceof RoleRefused ? error : new RoleRefused({ code: "unavailable" }))),
    } satisfies RepoRoles<R>
  })

/**
 * The role `actor` works with on Smithers' own copy of `repository`: a branch's workspace, its conversation, its
 * terminals, a new branch, a run's page. Where the deployment may act on the repository, the role `resolve` gives
 * there, including the deployment's own repository without an installation row. Elsewhere it can't (`CANT_ACT`), only recorded public visibility admits the deployment's role
 * (`workUninstalled`); private visibility denies; unknown or expired visibility is unavailable. A public repository without the App
 * is cloned and worked on as Smithers' copy by the deployment's own Members (GH-4, GH-5), and by nobody else (ruling
 * AUTH-8). GitHub or Postgres not answering passes on as the refusal, never a guess.
 */
export const workRole = <R>(roles: RepoRoles<R>, actor: Actor, repository: Repository): Effect.Effect<Role | null, RoleRefused, R> =>
  roles.resolve(actor, repository).pipe(
    Effect.map((resolved) => resolved.role),
    Effect.catch((refused) => CANT_ACT.has(refused.code) ? workUninstalled(roles, actor, repository) : Effect.fail(refused)),
  )

/** A missing installation grants work only when its provider confirms a public copy (or explicit local development). */
export const workUninstalled = <R>(roles: RepoRoles<R>, actor: Actor, repository: Repository): Effect.Effect<Role | null, RoleRefused, R> =>
  roles.workUninstalled === undefined ? Effect.succeed(null) : roles.workUninstalled(actor, repository)

/** `roles.uninstalled`, else the session's role: the role on a repository the App isn't on (decision 0079). */
export const uninstalledRole = <R>(roles: RepoRoles<R>, actor: Actor, repository: Repository): Role | null =>
  roles.uninstalled === undefined ? actor.role : roles.uninstalled(actor, repository)

/**
 * How long each stage of a read from GitHub took (`github.repo_role.stages`). A Worker's clock moves only across I/O, so
 * a stage's own CPU, such as signing the App's JWT, shows in the next stage that waits on something.
 */
type Stages = Partial<Record<"accountMs" | "authMs" | "tokenMs" | "mintMs" | "permissionMs" | "recordMs", number>>

/** `effect`, with its time in `stages`, however it ends. */
const timed = <A, E, R>(stages: Stages, stage: keyof Stages, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
    effect.pipe(Effect.onExit(() =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        stages[stage] = now - startedAt
      })
    )))

/** `millis` as a `retryAfterSeconds` field, when GitHub said a wait. */
const waitOf = (millis: number | undefined) =>
  millis === undefined ? {} : { retryAfterSeconds: Math.max(1, Math.ceil(millis / 1000)) }

/** The wait GitHub said for a rate limit, when it said one: `Calls.classify` reads every rate limit as a retry. */
const waitOfError = (error: unknown): number | undefined =>
  (classify(error) as { readonly retryAfterMillis?: number }).retryAfterMillis

/** A failed GitHub call as a refusal: its rate limit, or GitHub not answering. */
const refusedFor = (error: unknown, stage: "app_auth" | "permission") =>
  isRateLimited(error)
    ? new RoleRefused({ code: "rate_limited", stage, upstreamStatus: statusOf(error), ...waitOf(waitOfError(error)) })
    : new RoleRefused({ code: "github_unavailable", stage, upstreamStatus: statusOf(error) })

/** `row` as what decides: its role, and the row a write's transaction must still find. */
const heldBy = (repository: Repository, actor: Actor, row: { readonly role: Role | null; readonly checkedAt: string }, freshSeconds = FRESH_SECONDS): Resolved => ({
  role: row.role,
  held: Option.some({ repoId: repository.id, personId: actor.subject.id, role: row.role, checkedAt: row.checkedAt, ...(freshSeconds === FRESH_SECONDS ? {} : { freshSeconds }) }),
})

/** `effect` by `endsAt` (epoch milliseconds), its waits on Postgres included; past it, `unavailable` with a 1 s wait. */
const within = <A, R>(endsAt: number, effect: Effect.Effect<A, RoleRefused, R>) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    effect.pipe(Effect.timeoutOrElse({
      duration: Duration.millis(Math.max(0, endsAt - now)),
      orElse: () => Effect.fail(new RoleRefused({ code: "unavailable", retryAfterSeconds: 1, stage: "deadline" })),
    })))

/**
 * Runs `statement` in its own short transaction whose statements Postgres itself ends past `lockMillis` waiting for a
 * lock and `statementMillis` in all, whatever the client's cancellation does: no request waits long on a role row, or
 * holds a connection while it waits. The defaults bound a claim; a read passes what is left of its deadline.
 */
const bounded = <A, E, R>(statement: Effect.Effect<A, E, R>, lockMillis = 1_000, statementMillis = 2_000) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      yield* sql`SELECT set_config('lock_timeout', ${`${Math.max(1, Math.round(lockMillis))}ms`}, true),
        set_config('statement_timeout', ${`${Math.max(1, Math.round(statementMillis))}ms`}, true)`
      return yield* statement
    })))

/** Share a bounded absence receipt with About; a known installation always takes precedence. */
const rememberAbsence = (repoId: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO repo_about (repo_id, app_absent_until)
    VALUES (${repoId}, clock_timestamp() + make_interval(secs => ${APP_ABSENCE_SECONDS}))
    ON CONFLICT (repo_id) DO UPDATE SET app_absent_until = EXCLUDED.app_absent_until`
})

/** Visibility uses the role reader's bounded claim/cooling pattern, scoped to the repository alone. */
const visibilityState = (repoId: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{
    readonly public: boolean | null; readonly fresh: boolean; readonly claimed: boolean; readonly failed: boolean
    readonly refusal: "unavailable" | "rate_limited" | null; readonly remainingSeconds: number | null
  }>`SELECT private = false AS public,
    visibility_verified_at > clock_timestamp() - interval '60 seconds'
      AND visibility_verified_at <= clock_timestamp() AS fresh,
    coalesce(visibility_read_until > clock_timestamp(), false) AS claimed,
    visibility_read_failed AS failed, visibility_read_refusal AS refusal,
    EXTRACT(EPOCH FROM visibility_read_until - clock_timestamp())::float8 AS "remainingSeconds"
    FROM github_repositories WHERE repo_id = ${repoId}`
  return {
    fresh: row?.fresh === true && row.public !== null ? Option.some(row.public) : Option.none<boolean>(),
    claim: row?.claimed === true ? { failed: row.failed, refusal: row.refusal ?? "unavailable" as const,
      remainingSeconds: row.remainingSeconds ?? 0 } : undefined,
  }
})

const claimVisibilityRead = (repoId: string, leaseMillis: number) => bounded(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ readonly lease: string }>`
    INSERT INTO github_repositories (repo_id, visibility_read_until)
    VALUES (${repoId}, clock_timestamp() + make_interval(secs => ${leaseMillis / 1000}))
    ON CONFLICT (repo_id) DO UPDATE SET visibility_read_until = EXCLUDED.visibility_read_until,
      visibility_read_failed = false, visibility_read_refusal = NULL
    WHERE (github_repositories.visibility_read_until IS NULL OR github_repositories.visibility_read_until <= clock_timestamp())
      AND NOT coalesce(github_repositories.private IS NOT NULL
        AND github_repositories.visibility_verified_at > clock_timestamp() - interval '60 seconds'
        AND github_repositories.visibility_verified_at <= clock_timestamp(), false)
    RETURNING visibility_read_until::text AS lease`
  return Option.map(Option.fromNullishOr(row), (claimed) => claimed.lease)
}))

const releaseVisibilityRead = (repoId: string, lease: string) => bounded(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
  UPDATE github_repositories SET visibility_read_until = NULL, visibility_read_failed = false, visibility_read_refusal = NULL
  WHERE repo_id = ${repoId} AND visibility_read_until = ${lease}::timestamptz`), CLEANUP_LOCK_MILLIS, CLEANUP_STATEMENT_MILLIS)

const coolVisibilityRead = (repoId: string, lease: string, holdMillis: number, refusal: "unavailable" | "rate_limited") =>
  bounded(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly leftMillis: number }>`
      UPDATE github_repositories
      SET visibility_read_until = now() + make_interval(secs => ${holdMillis / 1000}),
        visibility_read_failed = true, visibility_read_refusal = ${refusal}
      WHERE repo_id = ${repoId} AND visibility_read_until = ${lease}::timestamptz
      RETURNING (EXTRACT(EPOCH FROM visibility_read_until - clock_timestamp()) * 1000)::float8 AS "leftMillis"`
    return Option.map(Option.fromNullishOr(row), (written) => Math.max(0, written.leftMillis))
  }), CLEANUP_LOCK_MILLIS, CLEANUP_STATEMENT_MILLIS)

/**
 * One look at the person's row on `repoId`: its role when a fresh read newer than `after` made it, and another
 * request's unexpired claim on reading it, whether that failed and how long it has left. One statement, outside any
 * transaction, through `github_repo_role_state` (migration 0096), whose own `lock_timeout` lets Postgres end a wait
 * behind a migration's lock on the table: the look holds a pooled connection for one round trip.
 */
const readState = (repoId: string, personId: string, after: string | undefined, freshSeconds = FRESH_SECONDS) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly role: string | null
      readonly checkedAt: string
      readonly fresh: boolean
      readonly claimed: boolean
      readonly failed: boolean
      readonly refusal: "unavailable" | "rate_limited" | null
      readonly remainingSeconds: number | null
    }>`
      SELECT role, checked_at AS "checkedAt", fresh, claimed, failed, refusal, remaining_seconds AS "remainingSeconds"
      FROM github_repo_role_state(${repoId}, ${personId}, ${after ?? null}::timestamptz, ${freshSeconds})`
    return {
      fresh: row !== undefined && row.fresh
        ? Option.some({ role: decodeRole(row.role), checkedAt: row.checkedAt })
        : Option.none<{ readonly role: Role | null; readonly checkedAt: string }>(),
      claim: row !== undefined && row.claimed
        ? { failed: row.failed, refusal: row.refusal ?? "unavailable" as const, remainingSeconds: row.remainingSeconds ?? 0 }
        : undefined,
    }
  })

/**
 * Claims the read of the person's role on `repoId` for `leaseMillis` from when the claim gets the row, only while it
 * still needs reading (no fresh read newer than `after`) and nobody holds an unexpired claim: the claim's end, which
 * releasing it names, or `None`. A person with no row gets one that decides nothing until the read records its answer
 * (migration 0090). Bounded (`bounded`): a lock it can't get soon is `None`'s refusal, `unavailable`.
 */
export const claimRead = (repoId: string, personId: string, after: string | undefined, leaseMillis: number, freshSeconds = FRESH_SECONDS) =>
  bounded(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly readUntil: string }>`
      INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at, read_until, read_failed)
      VALUES (${repoId}, ${personId}, NULL, '-infinity', clock_timestamp() + make_interval(secs => ${leaseMillis / 1000}), false)
      ON CONFLICT (repo_id, person_id) DO UPDATE
      SET read_until = clock_timestamp() + make_interval(secs => ${leaseMillis / 1000}), read_failed = false, read_refusal = NULL
      WHERE (github_repo_roles.read_until IS NULL OR github_repo_roles.read_until <= clock_timestamp())
        AND NOT (github_repo_roles.checked_at > clock_timestamp() - make_interval(secs => ${freshSeconds})
          ${after === undefined ? sql`` : sql`AND github_repo_roles.checked_at > ${after}::timestamptz`})
      RETURNING read_until::text AS "readUntil"`
    return Option.map(Option.fromNullishOr(row), (claimed) => claimed.readUntil)
  }))

/** Ends the claim `lease` named, unless another request has claimed the read since. */
const releaseRead = (repoId: string, personId: string, lease: string) =>
  bounded(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    UPDATE github_repo_roles SET read_until = NULL, read_failed = false, read_refusal = NULL
    WHERE repo_id = ${repoId} AND person_id = ${personId} AND read_until = ${lease}::timestamptz`), CLEANUP_LOCK_MILLIS, CLEANUP_STATEMENT_MILLIS)

/** The longest a cooling hold lasts, in milliseconds: what `@smthrs/integrations` honors of a server-named wait. */
const MAX_HOLD_MILLIS = 60_000

/** `millis` as a hold: finite, at least 0, at most `MAX_HOLD_MILLIS`. */
const clampHold = (millis: number) => Number.isFinite(millis) ? Math.min(MAX_HOLD_MILLIS, Math.max(0, millis)) : 0

/**
 * Keeps the claim `lease` named, as failed, for `holdMillis` from the start of its own short transaction (`now()`, the
 * database's clock, taken at its BEGIN, before the UPDATE waits for any lock; a statement's own timestamp is set after
 * a table lock it waits on while it is parsed): the next read is refused with what is left of the wait. Answers
 * what is left by the database's clock once written; `None` when another request had claimed the read since.
 */
const coolRead = (repoId: string, personId: string, lease: string, holdMillis: number, refusal: "unavailable" | "rate_limited") =>
  bounded(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly leftMillis: number }>`
      UPDATE github_repo_roles
      SET read_until = now() + make_interval(secs => ${clampHold(holdMillis) / 1000}), read_failed = true,
        read_refusal = ${refusal}
      WHERE repo_id = ${repoId} AND person_id = ${personId} AND read_until = ${lease}::timestamptz
      RETURNING (EXTRACT(EPOCH FROM read_until - clock_timestamp()) * 1000)::float8 AS "leftMillis"`
    return Option.map(Option.fromNullishOr(row), (written) => Math.max(0, written.leftMillis))
  }), CLEANUP_LOCK_MILLIS, CLEANUP_STATEMENT_MILLIS)

/** Postgres' clock now, and the person's GitHub account as sign-in recorded it, when there is one. */
const observe = (personId: string, repoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly asOf: string; readonly githubId: string | null; readonly login: string | null; readonly absent: boolean }>`
      SELECT now()::text AS "asOf", p.github_id::text AS "githubId", p.github_login AS login,
        EXISTS (SELECT 1 FROM repo_about a WHERE a.repo_id = ${repoId} AND a.app_absent_until > clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM github_repositories g WHERE g.repo_id = ${repoId} AND g.installation_id IS NOT NULL) AS absent
      FROM (SELECT 1) AS one LEFT JOIN people p ON p.id::text = ${personId}`
    const { asOf, githubId, login } = row!
    return {
      asOf, absent: row!.absent,
      // Both columns are NOT NULL on people (migration 0005); only the absent LEFT JOIN makes either null.
      account: githubId === null
        ? Option.none<{ readonly githubId: number; readonly login: string }>()
        : Option.some({ githubId: Number(githubId), login: login! }),
    }
  })

/** Notification rows deleted because a recorded read denied or lowered the person's role, by `scope`. */
export const pruned = Metric.counter("smithers_notifications_pruned", {
  description: "Notification rows deleted when a recorded read denied or lowered a person's role on their repository, by scope",
  incremental: true,
})

/** The roles that may read a repository's feed. */
const MEMBERS: ReadonlySet<Role> = new Set(["member", "maintainer", "admin"])


/**
 * After `remember` recorded `decided` for the person on `repoId`, under their feed lock, in a statement of its own so
 * it sees every fold that committed before it took the lock: a denial (no role, or less than a Member's), whatever the
 * row said `before`, deletes every row of the repository from their feed; a lower role that is still a Member's
 * deletes the repository's fleet alerts, which only Maintainers, Admins and a TODO's committer hear.
 */
const prune = (
  sql: SqlClient.SqlClient,
  repoId: string,
  personId: string,
  decided: Role | null,
  before: { readonly role: string | null; readonly checkedAt: string } | undefined,
) =>
  Effect.gen(function* () {
    const denied = decided === null || !MEMBERS.has(decided)
    // A row a read claimed before GitHub answered (`-infinity`) recorded no role to lower.
    const earlier = before === undefined || before.checkedAt === "-infinity" ? null : decodeRole(before.role)
    if (!denied && rankOf(decided) >= rankOf(earlier)) return
    const scope = denied ? "repository" : "fleet"
    const deleted = yield* sql`
      DELETE FROM notifications WHERE recipient = ${personId} AND repo_id = ${repoId}
        AND (${denied}::boolean OR kind = 'fleet')
      RETURNING 1`
    // A real projection reduction or pruning delete can invalidate an older cursor. Repeated denials with
    // nothing left to delete do not invalidate another tab's safely withheld poll.
    yield* sql`INSERT INTO notification_repository_access (recipient, repo_id, readable, checked_at, denial_sequence)
      VALUES (${personId}, ${repoId}, ${!denied}, clock_timestamp(), ${deleted.length > 0 ? 1 : 0})
      ON CONFLICT (recipient, repo_id) DO UPDATE SET
        readable = CASE WHEN ${denied} THEN false ELSE notification_repository_access.readable END,
        checked_at = greatest(notification_repository_access.checked_at, EXCLUDED.checked_at),
        denial_sequence = notification_repository_access.denial_sequence + CASE
          WHEN (${denied} AND notification_repository_access.readable) OR ${deleted.length > 0} THEN 1 ELSE 0 END`
    if (deleted.length === 0) return
    yield* Metric.update(Metric.withAttributes(pruned, { scope }), deleted.length)
    yield* Effect.logInfo("github.repo_role.pruned").pipe(Effect.annotateLogs({ repoId, scope, rows: deleted.length }))
  })

/**
 * Records the person's role on `repoId` as a read that began at `asOf` found it, unless a read that began later
 * already recorded one: a slow read that saw a role never overwrites a quicker one that saw it removed. Answers the
 * row afterwards, which is the one that decides: its role, when it was checked, and whether that is still fresh. The
 * row is read in a second statement of the same transaction: when the record waited for another read's and then
 * declined, the first statement's snapshot predates that read, so it would answer the row it replaced, or no row.
 */
export const remember = (repoId: string, personId: string, role: Role | null, asOf: string, freshSeconds = FRESH_SECONDS) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      // The person's feed lock on the repository first, as every writer of their feed takes it (worker/FeedLocks.ts).
      yield* FeedLocks.lock(sql, [{ repoId, personId }])
      const [before] = yield* sql<{ readonly role: string | null; readonly checkedAt: string }>`
        SELECT role, checked_at::text AS "checkedAt" FROM github_repo_roles WHERE repo_id = ${repoId} AND person_id = ${personId}`
      const accepted = yield* sql`
        INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
        VALUES (${repoId}, ${personId}, ${role}, ${asOf}::timestamptz)
        ON CONFLICT (repo_id, person_id) DO UPDATE SET role = EXCLUDED.role, checked_at = EXCLUDED.checked_at
        WHERE github_repo_roles.checked_at < EXCLUDED.checked_at
        RETURNING 1`
      const [row] = yield* sql<{ readonly role: string | null; readonly checkedAt: string; readonly fresh: boolean }>`
        SELECT role, checked_at::text AS "checkedAt",
          checked_at > clock_timestamp() - make_interval(secs => ${freshSeconds}) AS fresh
        FROM github_repo_roles WHERE repo_id = ${repoId} AND person_id = ${personId}`
      // The insert or the row it conflicted with is there; nothing deletes a role row inside this transaction.
      if (row === undefined) return yield* Effect.die(new Error("github_repo_roles: the row just recorded is gone"))
      const decided = decodeRole(row.role)
      if (accepted.length > 0) yield* prune(sql, repoId, personId, decided, before)
      return { role: decided, checkedAt: row.checkedAt, fresh: row.fresh }
    }))
  })
