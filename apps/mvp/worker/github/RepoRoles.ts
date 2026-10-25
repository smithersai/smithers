import { GitHub } from "@smthrs/integrations"
import { Clock, Config, Effect, Function, type Layer, Metric, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import * as SchemaIssue from "effect/SchemaIssue"
import { SqlClient } from "effect/sql"
import { ROLES } from "../../src/features/auth/contract.ts"
import type { Actor, Role } from "../Actor.ts"
import { type Permission, roleOf } from "../GitHubAuth.ts"
import { classify, isRateLimited, withToken } from "./Calls.ts"
import { type GitHubApp, type Repository, repositoryOf } from "./Config.ts"
import * as Tokens from "./Tokens.ts"

// A person's role on one repository (decision 0079). On the deployment's own repository (`GITHUB_REPOSITORY`) it is
// the session's role, as sign-in reads and rechecks it. On any other repository the deployment may act on, one where
// the App is installed and that `GITHUB_ALLOWED_REPOSITORIES` doesn't leave out, it is the person's GitHub permission
// there, read with an installation token minted for that repository with `metadata: read` for the login and account id
// sign-in recorded, mapped as decision 0007 §9 says, and kept in `github_repo_roles` for `FRESH_SECONDS`. A stale row is read again before it decides anything, and
// when GitHub can't answer, the refusal says so; a stale row never decides. Every route that acts on a repository asks
// `resolve`; a write's transaction asks `holds` (0079 §6).

/** How long a role read from GitHub decides, in seconds (decision 0079 §5). */
export const FRESH_SECONDS = 5 * 60

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

export class RoleRefused extends Schema.TaggedError<RoleRefused>()("@smthrs/mvp/github/RoleRefused", {
  code: Schema.Literals(Object.keys(REFUSALS) as Array<Refusal>),
  retryAfterSeconds: Schema.optional(Schema.Number),
}) {}

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
 * Inside a write's transaction: whether the person's `github_repo_roles` row still holds `held.role` and is fresh,
 * locked `FOR SHARE`, so a refresh that changes it waits for the write, or the write sees the change (decision 0079 §6).
 */
export const holds = (held: Held) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly role: string | null }>`
      SELECT role FROM github_repo_roles
      WHERE repo_id = ${held.repoId} AND person_id = ${held.personId}
        AND checked_at > now() - make_interval(secs => ${FRESH_SECONDS})
      FOR SHARE`
    return row !== undefined && row.role === held.role
  })

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
   * the session's role holds on every repository, as it did before decision 0079. A deploy never sets it.
   */
  readonly local?: boolean
}

/** The `RepoRoles` interface every route asks; `R` is what its database's layer needs. */
export interface RepoRoles<R = never> {
  /** The deployment's own repository. */
  readonly repository: Repository
  /** `actor`'s role on `repository`, or why there is none to give. */
  readonly resolve: (actor: Actor, repository: Repository) => Effect.Effect<Resolved, RoleRefused, R>
}

/** `RepoRoles` over `database`: `resolve` opens a Postgres client for each read. */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, options: Options) =>
  Effect.gen(function* () {
    const allowedIds = options.allowed ?? Option.none()
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

    /** The person's permission on `repository`, read with the App; `None` when GitHub knows no such person there. */
    const fromGitHub = (configured: NonNullable<Option.Option.Value<typeof app>>, repository: Repository, login: string) =>
      Effect.gen(function* () {
        const tokens = Tokens.make({
          app: yield* configured.auth.pipe(Effect.mapError(refusedFor)),
          // Installation tokens only: no session's token to refresh.
          keys: Option.none(),
          refresh: Function.constant(Effect.void),
        })
        const token = yield* tokens.forInstallation(repository, "metadata").pipe(
          Effect.mapError((error) =>
            error.reason === "app_not_installed"
              ? new RoleRefused({ code: "app_not_installed" })
              : new RoleRefused({
                code: error.rateLimited === true ? "rate_limited" : "github_unavailable",
                ...waitOf(error.retryAfterMillis),
              })
          ),
        )
        return yield* GitHub.Collaborators.permission(repository.owner, repository.name, login).pipe(
          withToken(token, configured.config.apiBaseUrl),
          Effect.mapError(refusedFor),
        )
      }).pipe(client)

    /** A query of `fromRow`'s: Postgres failing is `unavailable`. */
    const inDatabase = <A, X>(effect: Effect.Effect<A, X, SqlClient.SqlClient>) =>
      Effect.mapError(effect, () => new RoleRefused({ code: "unavailable" }))

    /** The role and where it came from (`session`, `cached`, `github`). */
    const decide = (actor: Actor, repository: Repository) =>
      Effect.gen(function* () {
        // The deployment's own repository: the session's role, as it always was.
        if (repository.id === options.repository.id) {
          return { source: "session", resolved: { role: actor.role, held: Option.none<Held>() } }
        }
        if (Option.isNone(app)) {
          if (options.local === true) return { source: "local", resolved: { role: actor.role, held: Option.none<Held>() } }
          return yield* new RoleRefused({ code: "not_configured" })
        }
        if (Option.isSome(allowedIds) && !allowedIds.value.has(repository.id)) {
          return yield* new RoleRefused({ code: "not_found" })
        }
        // One Postgres client for the reads, the App's installation and the record; one that can't be had is
        // `unavailable`.
        return yield* fromRow(actor, repository, app.value).pipe(
          Effect.provide(database),
          Effect.mapError((error) => (error instanceof RoleRefused ? error : new RoleRefused({ code: "unavailable" }))),
        )
      })

    /** The role on another repository: the fresh row, else GitHub's answer, recorded. */
    const fromRow = (actor: Actor, repository: Repository, configured: NonNullable<Option.Option.Value<typeof app>>) =>
      Effect.gen(function* () {
        const personId = actor.subject.id
        const held = (role: Role | null): Resolved => ({ role, held: Option.some({ repoId: repository.id, personId, role }) })
        const cached = yield* inDatabase(cachedRole(repository.id, personId))
        if (Option.isSome(cached)) return { source: "cached", resolved: held(cached.value) }
        // Who the person is on GitHub is sign-in's `people` row to say, never a request: their login to ask about and
        // their account's id, which the answer must name, because a login can change hands after a rename. `asOf` is
        // when this read began: an older read never overwrites a newer one.
        const { asOf, account } = yield* inDatabase(observe(personId))
        const answer = Option.isNone(account)
          ? Option.none<GitHub.Collaborators.Permission>()
          : yield* fromGitHub(configured, repository, account.value.login)
        const sameAccount = Option.isSome(account) && Option.isSome(answer) &&
          answer.value.userId === account.value.githubId
        if (Option.isSome(answer) && !sameAccount) {
          yield* Effect.logWarning("github.repo_role.account").pipe(
            Effect.annotateLogs({ repoId: repository.id, outcome: "another_account" }),
          )
        }
        // What decides is the row as it stands after this read: a later read's, when one already landed.
        const role = yield* inDatabase(
          remember(repository.id, personId, sameAccount ? roleOf(permissionOf(answer.value)) : null, asOf),
        )
        return { source: "github", resolved: held(role) }
      })

    /** `decide`, logged (`github.repo_role`: source, outcome, duration; never a login) and counted. */
    const resolve = (actor: Actor, repository: Repository): Effect.Effect<Resolved, RoleRefused, R> =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const decided = yield* decide(actor, repository).pipe(Effect.result)
        const source = decided._tag === "Success" ? decided.success.source : "refused"
        const outcome = decided._tag === "Success" ? decided.success.resolved.role ?? "none" : decided.failure.code
        yield* Metric.update(Metric.withAttributes(reads, { source, outcome }), 1)
        yield* Effect.logWithLevel(decided._tag === "Success" ? "Info" : "Warn")("github.repo_role").pipe(
          Effect.annotateLogs({
            repoId: repository.id,
            source,
            outcome,
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          }),
        )
        if (decided._tag === "Failure") return yield* decided.failure
        return decided.success.resolved
      }).pipe(Effect.withSpan("github.repo_role"))

    return { repository: options.repository, resolve } satisfies RepoRoles<R>
  })

/**
 * The role `actor` works with on Smithers' own copy of `repository`: a branch's workspace, its conversation, its
 * terminals, a new branch, a run's page. Where the deployment may act on the repository, the role `resolve` gives
 * there. Where it can't (`CANT_ACT`), nothing done in that copy reaches GitHub, so the session's role on the
 * deployment's own repository decides, as before decision 0079: a public repository without the App is cloned and
 * worked on as Smithers' copy (GH-4). GitHub or Postgres not answering passes on as the refusal, never a guess.
 */
export const workRole = <R>(roles: RepoRoles<R>, actor: Actor, repository: Repository): Effect.Effect<Role | null, RoleRefused, R> =>
  roles.resolve(actor, repository).pipe(
    Effect.map((resolved) => resolved.role),
    Effect.catch((refused) => CANT_ACT.has(refused.code) ? Effect.succeed(actor.role) : Effect.fail(refused)),
  )

/** `millis` as a `retryAfterSeconds` field, when GitHub said a wait. */
const waitOf = (millis: number | undefined) =>
  millis === undefined ? {} : { retryAfterSeconds: Math.max(1, Math.ceil(millis / 1000)) }

/** The wait GitHub said for a rate limit, when it said one: `Calls.classify` reads every rate limit as a retry. */
const waitOfError = (error: unknown): number | undefined =>
  (classify(error) as { readonly retryAfterMillis?: number }).retryAfterMillis

/** A failed GitHub call as a refusal: its rate limit, or GitHub not answering. */
const refusedFor = (error: unknown) =>
  isRateLimited(error)
    ? new RoleRefused({ code: "rate_limited", ...waitOf(waitOfError(error)) })
    : new RoleRefused({ code: "github_unavailable" })

/** The person's fresh role on `repoId`, no role included; `None` when there is no fresh row. */
const cachedRole = (repoId: string, personId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly role: string | null }>`
      SELECT role FROM github_repo_roles
      WHERE repo_id = ${repoId} AND person_id = ${personId}
        AND checked_at > now() - make_interval(secs => ${FRESH_SECONDS})`
    return Option.map(Option.fromNullishOr(row), (found) => decodeRole(found.role))
  })

/** Postgres' clock now, and the person's GitHub account as sign-in recorded it, when there is one. */
const observe = (personId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly asOf: string; readonly githubId: string | null; readonly login: string | null }>`
      SELECT now()::text AS "asOf", p.github_id::text AS "githubId", p.github_login AS login
      FROM (SELECT 1) AS one LEFT JOIN people p ON p.id::text = ${personId}`
    const { asOf, githubId, login } = row!
    return {
      asOf,
      // Both columns are NOT NULL on people (migration 0005); only the absent LEFT JOIN makes either null.
      account: githubId === null
        ? Option.none<{ readonly githubId: number; readonly login: string }>()
        : Option.some({ githubId: Number(githubId), login: login! }),
    }
  })

/**
 * Records the person's role on `repoId` as a read that began at `asOf` found it, unless a read that began later
 * already recorded one: a slow read that saw a role never overwrites a quicker one that saw it removed. Answers the
 * role the row holds afterwards, which is the one that decides.
 */
export const remember = (repoId: string, personId: string, role: Role | null, asOf: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly role: string | null }>`
      WITH written AS (
        INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
        VALUES (${repoId}, ${personId}, ${role}, ${asOf}::timestamptz)
        ON CONFLICT (repo_id, person_id) DO UPDATE SET role = EXCLUDED.role, checked_at = EXCLUDED.checked_at
        WHERE github_repo_roles.checked_at < EXCLUDED.checked_at
        RETURNING role
      )
      SELECT role FROM written
      UNION ALL
      SELECT role FROM github_repo_roles
      WHERE repo_id = ${repoId} AND person_id = ${personId} AND NOT EXISTS (SELECT 1 FROM written)`
    return decodeRole(row!.role)
  })
