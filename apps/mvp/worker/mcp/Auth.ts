import { digestSync } from "@smthrs/crypto"
import { Cause, Effect, Layer, Metric, Option } from "effect"
import type { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import {
  MCP_BLOCKED_ACTS,
  MCP_SCOPES,
  MCP_TOKEN_PREFIX,
  type McpScope,
} from "../../src/features/mcp/contract.ts"
import { isRepository, repoId } from "../../src/features/repo/contract.ts"
import { type Actor, rankOf, type Role, Sessions } from "../Actor.ts"
import { codeOf } from "../ErrorCode.ts"
import { type Repository, repositoryOf } from "../github/Config.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import * as GitHubStore from "../github/Store.ts"
import * as SessionStore from "../SessionStore.ts"
import {
  type McpAuthResult,
  McpAuthService,
  type McpPrincipal,
  type McpRepoAccess,
  McpToolError,
} from "./Contract.vibe"
import { makeOAuthHandlers, timingSafeEqual, timingSafeEqualString } from "./OAuth.ts"

export { timingSafeEqual, timingSafeEqualString }

// MCP Bearer Authentication + Live Per-Repository Role & Person-Only Authorization (`McpAuthService`).
//
// Security invariants:
// 1. Missing `Authorization` header -> `Anonymous`. Any present header that is not `Bearer sma_<64 lowercase hex>`
//    -> `Rejected(401, "invalid_token")` (never silently downgraded to `Anonymous`).
// 2. Tokens are looked up by `SHA-256(token)` joined with `people(id, github_login)` and verified in constant time;
//    revocation (`401 token_revoked`), DB-clock expiry (`401 token_expired`), and repo pinning (`403 repo_scope_mismatch`)
//    are enforced before any tool executes. `last_used_at` is throttled (>= 60s) and non-fatal.
// 3. Every `McpPrincipal.actor` ALWAYS carries `act: { kind: "agent", id: "mcp:<tokenId>" }` and `role: null` on auth,
//    ensuring every `Actor.refusesPersonOnly` guard rejects MCP agents regardless of the person's Admin/Maintainer role.
// 4. Roles are NEVER cached or frozen in a token. `resolveRepoAccess` checks `repoScope` BEFORE any visibility/role
//    lookup (preventing cross-repo probing) and queries live per-repo role + visibility on every call. For the
//    deployment's own repository (where `RepoRoles` expects a browser session), it loads the person's newest confirmed
//    `SessionStore` role receipt against Postgres' clock without lending the agent a browser session.
// 5. `requireWriteAccess` enforces: Authenticated + `actor.act.kind === "agent"` + `mcp:write` scope + `repoScope`
//    + live `rankOf(role) >= rankOf(minimum)`.
// 6. OBS-5: raw tokens, digests, SQL errors, and logins never appear in logs, spans, or metrics.

/** Metric counter for MCP bearer authentication and repository authorization outcomes. */
export const authChecks = Metric.counter("smithers_mcp_auth_checks", {
  description: "MCP bearer authentication and repository access checks by kind and outcome",
  incremental: true,
})

const MAX_AUTH_HEADER_LENGTH = 8 * 1024

/** Canonical opaque MCP agent bearer token pattern (`sma_<64 lowercase hex>`). */
export const MCP_TOKEN_PATTERN = /^sma_[0-9a-f]{64}$/

const BLOCKED_ACT_SET: ReadonlySet<string> = new Set(MCP_BLOCKED_ACTS)

/** Whether `token` matches the exact `sma_<64 lowercase hex>` bearer token format. */
export const isValidMcpTokenFormat = (token: string): boolean =>
  token.startsWith(MCP_TOKEN_PREFIX) && MCP_TOKEN_PATTERN.test(token)

/** Result of parsing an incoming `Authorization` header for an MCP bearer token. */
export type ParsedMcpBearer =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Token"; readonly token: string }
  | { readonly _tag: "Malformed" }

/**
 * Parses `Authorization: Bearer sma_<64 hex>` from `request`.
 * - Absent header -> `Absent` (`Anonymous`).
 * - Empty, oversized, wrong scheme, extra tokens, or malformed `sma_` value -> `Malformed` (`401 invalid_token`).
 */
export const parseMcpBearer = (request: HttpServerRequest.HttpServerRequest): ParsedMcpBearer => {
  const header = request.headers["authorization"]
  if (header === undefined) return { _tag: "Absent" }
  if (header.length === 0 || header.length > MAX_AUTH_HEADER_LENGTH) return { _tag: "Malformed" }
  const match = /^bearer[ \t]+([^\s,]+)$/i.exec(header.trim())
  if (match === null) return { _tag: "Malformed" }
  const token = match[1]!
  if (!isValidMcpTokenFormat(token)) return { _tag: "Malformed" }
  return { _tag: "Token", token }
}

/** Builds the canonical MCP agent `Actor`: always carries `act: { kind: "agent", id: "mcp:<tokenId>" }`. */
export const agentActor = (
  tokenId: string,
  personId: string,
  login: string,
  role: Role | null = null,
): Actor => ({
  subject: { kind: "person", id: personId },
  role,
  login,
  act: { kind: "agent", id: `mcp:${tokenId}` },
})

/** Whether `act` is strictly person-only and never available via MCP (`MCP_BLOCKED_ACTS`). */
export const isBlockedMcpAct = (act: string): boolean => {
  const normalized = act.replace(/[_.]/g, "/")
  return BLOCKED_ACT_SET.has(act) || BLOCKED_ACT_SET.has(normalized)
}

/** Fails with `McpToolError("person_only")` if `act` is in `MCP_BLOCKED_ACTS`. */
export const assertNotBlockedAct = (act: string): Effect.Effect<void, McpToolError> =>
  isBlockedMcpAct(act)
    ? Effect.fail(
        new McpToolError({
          code: "person_only",
          message: `Action "${act}" is person-only and cannot be executed by an MCP agent.`,
        }),
      )
    : Effect.void

const mapRoleRefusalToToolError = (refused: RepoRoles.RoleRefused): McpToolError => {
  switch (refused.code) {
    case "rate_limited":
      return new McpToolError({
        code: "rate_limited",
        message: "GitHub API rate limit reached while verifying repository access.",
      })
    case "app_not_installed":
      return new McpToolError({
        code: "app_not_installed",
        message: "Smithers GitHub App is not installed on this repository.",
      })
    case "not_found":
      return new McpToolError({
        code: "not_found",
        message: "Repository not found or not accessible.",
      })
    case "not_configured":
    case "github_unavailable":
    case "unavailable":
      return new McpToolError({
        code: "unavailable",
        message: "Unable to verify repository access right now.",
      })
  }
}

interface TokenLookupRow {
  readonly id: string
  readonly tokenSha256: string
  readonly personId: string
  readonly login: string
  readonly clientName: string
  readonly repoScope: string | null
  readonly scopes: ReadonlyArray<string>
  readonly revoked: boolean
  readonly expired: boolean
}

/**
 * Dependencies for constructing {@link McpAuthService}.
 * In `ChatApiProgram.ts`, pass `{ database, roles }` (with `Sessions` in Effect context or passed via `sessions`).
 * Tests may also override `resolveRole` / `isRepoPublic` directly.
 */
export interface McpAuthDeps<E = unknown, R = never, R2 = never> {
  /** Request-scoped Postgres client layer (`Database.layer(...)` in ChatApiProgram.ts). */
  readonly database: Layer.Layer<SqlClient.SqlClient, E, R>
  /** Production live repository role & visibility resolver (`RepoRoles.make(...)`). */
  readonly roles?: RepoRoles.RepoRoles<R2>
  /** Optional direct role resolver override (takes precedence over `roles.resolve`). */
  readonly resolveRole?: (
    actor: Actor,
    repository: Repository,
  ) => Effect.Effect<Role | null, RepoRoles.RoleRefused, R2>
  /** Optional direct repository visibility check override (takes precedence over `roles.publicCopy` / `GitHubStore.isPublic`). */
  readonly isRepoPublic?: (
    repository: Repository,
  ) => Effect.Effect<boolean, RepoRoles.RoleRefused, R2>
  /** Optional explicit `Sessions` service (defaults to `Sessions` in Effect context, or signed-out). */
  readonly sessions?: Sessions["Service"]
}

/**
 * Constructs {@link McpAuthService} over `deps`.
 * Every returned service method has `R = never`, matching `worker/mcp/Contract.ts`.
 */
export const makeMcpAuthService = <E, R, R2>(
  deps: McpAuthDeps<E, R, R2>,
): Effect.Effect<McpAuthService["Service"], never, R | R2> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R | R2>()
    const resolvedSessions =
      deps.sessions ??
      Option.getOrElse(yield* Effect.serviceOption(Sessions), () =>
        Sessions.of({ resolve: Effect.succeedNone }),
      )

    const withDb = <A, E2>(effect: Effect.Effect<A, E2, SqlClient.SqlClient>) =>
      effect.pipe(Effect.provide(deps.database), Effect.provide(context))

    const recordCheck = (kind: "auth" | "repo" | "write", outcome: string, extra: Record<string, string | number> = {}) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(authChecks, { kind, outcome }), 1),
        Effect.logWithLevel(outcome === "unavailable" ? "Error" : outcome === "authenticated" || outcome === "anonymous" || outcome === "allowed" ? "Info" : "Warn")(
          `mcp.${kind}`,
        ).pipe(Effect.annotateLogs({ outcome, ...extra })),
      )

    /** Resolves an optional `Authorization: Bearer sma_...` header to `Anonymous`, `Authenticated`, or `Rejected`. */
    const authenticate = (
      request: HttpServerRequest.HttpServerRequest,
      targetRepoId?: string,
    ): Effect.Effect<McpAuthResult> =>
      Effect.gen(function* () {
        const parsed = parseMcpBearer(request)
        if (parsed._tag === "Absent") {
          yield* recordCheck("auth", "anonymous")
          return { _tag: "Anonymous" } satisfies McpAuthResult
        }
        if (parsed._tag === "Malformed") {
          yield* recordCheck("auth", "invalid_token", { reason: "malformed" })
          return { _tag: "Rejected", status: 401, code: "invalid_token" } satisfies McpAuthResult
        }

        const tokenSha256 = digestSync(parsed.token)

        const lookup = yield* withDb(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const rows = yield* sql<TokenLookupRow>`
              SELECT
                t.id::text AS id,
                t.token_sha256 AS "tokenSha256",
                t.person_id::text AS "personId",
                p.github_login AS login,
                t.client_name AS "clientName",
                t.repo_scope AS "repoScope",
                t.scopes,
                (t.revoked_at IS NOT NULL) AS revoked,
                (t.expires_at <= clock_timestamp()) AS expired
              FROM mcp_tokens t
              INNER JOIN people p ON p.id = t.person_id
              WHERE t.token_sha256 = ${tokenSha256}`
            return Option.fromNullishOr(rows[0])
          }),
        ).pipe(Effect.result)

        if (lookup._tag === "Failure") {
          yield* recordCheck("auth", "unavailable", { errorCode: codeOf(lookup.failure) })
          return { _tag: "Rejected", status: 503, code: "unavailable" } satisfies McpAuthResult
        }

        if (Option.isNone(lookup.success) || !timingSafeEqualString(lookup.success.value.tokenSha256, tokenSha256)) {
          yield* recordCheck("auth", "invalid_token", { reason: "not_found" })
          return { _tag: "Rejected", status: 401, code: "invalid_token" } satisfies McpAuthResult
        }

        const row = lookup.success.value
        if (row.revoked) {
          yield* recordCheck("auth", "token_revoked")
          return { _tag: "Rejected", status: 401, code: "token_revoked" } satisfies McpAuthResult
        }
        if (row.expired) {
          yield* recordCheck("auth", "token_expired")
          return { _tag: "Rejected", status: 401, code: "token_expired" } satisfies McpAuthResult
        }

        const normalizedScope = row.repoScope === null ? null : row.repoScope.toLowerCase()
        if (
          targetRepoId !== undefined &&
          normalizedScope !== null &&
          normalizedScope !== targetRepoId.toLowerCase()
        ) {
          yield* recordCheck("auth", "repo_scope_mismatch")
          return { _tag: "Rejected", status: 403, code: "repo_scope_mismatch" } satisfies McpAuthResult
        }

        const scopes = MCP_SCOPES.filter((scope) => row.scopes.includes(scope))

        // Throttled (>= 60s), non-fatal `last_used_at` update so busy agents do not amplify write traffic.
        yield* withDb(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`
              UPDATE mcp_tokens
              SET last_used_at = clock_timestamp()
              WHERE id = ${row.id}::uuid
                AND revoked_at IS NULL
                AND (last_used_at IS NULL OR last_used_at < clock_timestamp() - interval '60 seconds')`
          }),
        ).pipe(Effect.catchCause(() => Effect.void))

        const principal: McpPrincipal = {
          tokenId: row.id,
          personId: row.personId,
          login: row.login,
          clientName: row.clientName,
          repoScope: normalizedScope,
          scopes,
          actor: agentActor(row.id, row.personId, row.login, null),
        }

        yield* recordCheck("auth", "authenticated", { scopeCount: scopes.length })
        return { _tag: "Authenticated", principal } satisfies McpAuthResult
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.as(
            recordCheck("auth", "unavailable", { errorCode: codeOf(Cause.squash(cause)) }),
            { _tag: "Rejected", status: 503, code: "unavailable" } as McpAuthResult,
          ),
        ),
        Effect.withSpan("mcp.authenticate"),
      )

    /**
     * Reads the person's newest confirmed deployment-repository role receipt when an MCP agent (which has no
     * browser session cookie) accesses the deployment's own repository (`RepoRoles` uses `SessionStore.freshRole`
     * on `roles.repository.id`, which would otherwise read `actor.role === null`).
     */
    const readFreshDeploymentRole = (personId: string): Effect.Effect<Role | null, RepoRoles.RoleRefused> =>
      withDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const windowMs = yield* SessionStore.RoleFreshMs
          const rows = yield* sql<{
            readonly role: Role | null
            readonly verifiedAt: string | null
            readonly nowMs: string
          }>`
            SELECT
              ${SessionStore.latestRole(sql, sql`p.id`)} AS role,
              extract(epoch FROM ${SessionStore.latestRoleVerifiedAt(sql, sql`p.id`)}) * 1000 AS "verifiedAt",
              extract(epoch FROM clock_timestamp()) * 1000 AS "nowMs"
            FROM people p
            WHERE p.id = ${personId}::uuid`
          const row = rows[0]
          if (row === undefined || row.verifiedAt === null) return null
          if (!SessionStore.roleFresh(Number(row.verifiedAt), Number(row.nowMs), windowMs)) {
            return yield* Effect.fail(new RepoRoles.RoleRefused({ code: "unavailable", stage: "database" }))
          }
          return row.role
        }),
      ).pipe(
        Effect.mapError((error) =>
          error instanceof RepoRoles.RoleRefused
            ? error
            : new RepoRoles.RoleRefused({ code: "unavailable", stage: "database" }),
        ),
      )

    /** Resolves `actor`'s live role on `repository`, never trusting any cached/frozen role on an agent credential. */
    const resolveRoleFor = (
      actor: Actor,
      repository: Repository,
    ): Effect.Effect<Role | null, RepoRoles.RoleRefused> => {
      if (deps.resolveRole !== undefined) {
        return deps.resolveRole(actor, repository).pipe(Effect.provide(context))
      }
      if (deps.roles === undefined) {
        return Effect.fail(new RepoRoles.RoleRefused({ code: "not_configured", stage: "configuration" }))
      }
      const roles = deps.roles
      return Effect.gen(function* () {
        const subject =
          actor.act?.kind === "agent" &&
          actor.session === undefined &&
          repository.id === roles.repository.id &&
          roles.workBasis?.(repository, true) !== "local"
            ? { ...actor, role: yield* readFreshDeploymentRole(actor.subject.id) }
            : actor
        const resolved = yield* roles.resolve(subject, repository).pipe(Effect.provide(context))
        return resolved.role
      })
    }

    /** Resolves live repository visibility. Unknown visibility fails closed (`false`). */
    const checkIsPublic = (repository: Repository): Effect.Effect<boolean, McpToolError> => {
      if (deps.isRepoPublic !== undefined) {
        return deps.isRepoPublic(repository).pipe(
          Effect.provide(context),
          Effect.mapError(mapRoleRefusalToToolError),
        )
      }
      if (deps.roles?.publicCopy !== undefined) {
        return deps.roles.publicCopy(repository).pipe(
          Effect.provide(context),
          Effect.mapError(mapRoleRefusalToToolError),
        )
      }
      return withDb(GitHubStore.isPublic(repository.id)).pipe(
        Effect.mapError(
          () =>
            new McpToolError({
              code: "unavailable",
              message: "Unable to verify repository visibility right now.",
            }),
        ),
        Effect.map(Option.getOrElse(() => false)),
      )
    }

    /**
     * Resolves live per-repo role + visibility for `principal` (or anonymous) on `owner/name` and enforces `repoScope`.
     * Returns `{ owner, name, repoId, role, isPublic }` cleanly (including `{ role: null, isPublic: false }` on a
     * private repo where the caller holds no role, so `worker/mcp/Tools.ts` `readAccess` denies private reads and
     * `listTools` hides privileged tools instead of falling back to admin visibility).
     */
    const resolveRepoAccess = (
      principal: Option.Option<McpPrincipal>,
      owner: string,
      name: string,
    ): Effect.Effect<McpRepoAccess, McpToolError> =>
      Effect.gen(function* () {
        if (!isRepository(owner, name)) {
          return yield* new McpToolError({
            code: "invalid_params",
            message: "Expected a GitHub repository in owner/name form.",
          })
        }

        const canonicalId = repoId(owner, name)
        const repository = repositoryOf(`${owner}/${name}`)

        // Enforce repo pinning BEFORE any GitHub or DB lookup so scoped tokens cannot probe other repos.
        if (Option.isSome(principal)) {
          const pinned = principal.value.repoScope
          if (pinned !== null && pinned.toLowerCase() !== canonicalId) {
            return yield* new McpToolError({
              code: "forbidden",
              message: "This MCP token is scoped to a different repository.",
            })
          }
        }

        if (Option.isNone(principal)) {
          const isPublic = yield* checkIsPublic(repository)
          return {
            owner,
            name,
            repoId: canonicalId,
            role: null,
            isPublic,
          } satisfies McpRepoAccess
        }

        // Always strip any role carried in on the actor; authority comes exclusively from live resolution.
        const freshActor = agentActor(principal.value.tokenId, principal.value.personId, principal.value.login, null)
        const roleResult = yield* resolveRoleFor(freshActor, repository).pipe(Effect.result)

        if (roleResult._tag === "Success") {
          const liveRole = roleResult.success
          const isPublic =
            liveRole !== null
              ? yield* checkIsPublic(repository).pipe(Effect.orElseSucceed(() => false))
              : yield* checkIsPublic(repository)
          return {
            owner,
            name,
            repoId: canonicalId,
            role: liveRole,
            isPublic,
          } satisfies McpRepoAccess
        }

        const refused = roleResult.failure
        if (RepoRoles.CANT_ACT.has(refused.code)) {
          const isPublic = yield* checkIsPublic(repository)
          return {
            owner,
            name,
            repoId: canonicalId,
            role: null,
            isPublic,
          } satisfies McpRepoAccess
        }

        return yield* mapRoleRefusalToToolError(refused)
      }).pipe(
        Effect.tap((access) => recordCheck("repo", access.role ?? (access.isPublic ? "public" : "private_none"))),
        Effect.tapError((error) => recordCheck("repo", error.code)),
        Effect.withSpan("mcp.repo_access"),
      )

    /**
     * Enforces write authorization:
     * 1. Authenticated principal (else `authentication`, triggering RFC 9728 401 challenge in Protocol.ts)
     * 2. Principal carries `act.kind === "agent"` bound to its token id (else `forbidden`)
     * 3. Token carries `"mcp:write"` scope (else `forbidden`)
     * 4. Live `resolveRepoAccess` succeeds (enforcing repo validation, `repoScope`, and live role)
     * 5. `rankOf(access.role) >= rankOf(minimum)` (else `forbidden`)
     */
    const requireWriteAccess = (
      principal: Option.Option<McpPrincipal>,
      owner: string,
      name: string,
      minimum: Role,
    ): Effect.Effect<{ readonly principal: McpPrincipal; readonly access: McpRepoAccess }, McpToolError> =>
      Effect.gen(function* () {
        if (Option.isNone(principal)) {
          return yield* new McpToolError({
            code: "authentication",
            message: "Authentication is required for write operations.",
          })
        }

        const current = principal.value
        if (current.actor.act?.kind !== "agent" || current.actor.act.id !== `mcp:${current.tokenId}`) {
          return yield* new McpToolError({
            code: "forbidden",
            message: "MCP writes require a valid agent act.",
          })
        }

        if (!current.scopes.includes("mcp:write")) {
          return yield* new McpToolError({
            code: "forbidden",
            message: "This MCP token is read-only and lacks mcp:write scope.",
          })
        }

        const access = yield* resolveRepoAccess(principal, owner, name)
        if (rankOf(access.role) < rankOf(minimum)) {
          return yield* new McpToolError({
            code: "forbidden",
            message: `Requires the ${minimum} role or above on ${owner}/${name}.`,
          })
        }

        const hydrated: McpPrincipal = {
          ...current,
          actor: agentActor(current.tokenId, current.personId, current.login, access.role),
        }
        return { principal: hydrated, access }
      }).pipe(
        Effect.tap(() => recordCheck("write", "allowed")),
        Effect.tapError((error) => recordCheck("write", error.code)),
        Effect.withSpan("mcp.write_access"),
      )

    const oauth = yield* makeOAuthHandlers({
      database: deps.database,
      sessions: resolvedSessions,
      resolveRole: resolveRoleFor,
    })

    return McpAuthService.of({
      authenticate,
      resolveRepoAccess,
      requireWriteAccess,
      listTokens: oauth.listTokens,
      revokeToken: oauth.revokeToken,
      handleOAuthOrTokenRoute: oauth.handleOAuthOrTokenRoute,
    })
  })

/** Effect Layer providing {@link McpAuthService} over `deps`. */
export const layer = <E, R, R2>(
  deps: McpAuthDeps<E, R, R2>,
): Layer.Layer<McpAuthService, never, R | R2> =>
  Layer.effect(McpAuthService, makeMcpAuthService(deps))

/** Alias of {@link layer} for explicit live wiring in `worker/ChatApiProgram.ts`. */
export const McpAuthServiceLive = layer
