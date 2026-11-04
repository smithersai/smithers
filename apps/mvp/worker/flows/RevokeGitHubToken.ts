import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Metric, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { codeOf } from "../ErrorCode.ts"
import { type GitHubAuth, GitHubRefused } from "../GitHubAuth.ts"
import type { SessionKeys } from "../SessionKeys.ts"
import * as SessionStore from "../SessionStore.ts"
import * as Cleanup from "./RevokeReplacedGitHubToken.ts"
import { SqlClient as Sql } from "effect/sql"

// Preserve this flow and its action names for existing durable histories. EndSession now moves credentials into
// cleanup in its transaction. RevokeToken drains that cleanup; exhausted attempts leave it for the durable sweeper.

/** The execution that signs session `sessionId` out: one per session, so starting it again is a no-op. */
export const revokeExecutionId = (sessionId: string): string => `auth-revoke-${sessionId}`

/**
 * What the flow did: revoked the token on GitHub and forgot it (GitHub no longer having it counts), forgot it after
 * every revocation attempt failed, forgot a token that no longer opens (SESSION_SECRET changed), found no token, or
 * found the session live and left it alone.
 */
const Revoked = Schema.Struct({
  outcome: Schema.Literals(["revoked", "forgotten", "unreadable", "none", "live"]),
})
type Revoked = typeof Revoked.Type

/** The revocation couldn't finish: GitHub was unavailable or refused the App, or Postgres failed. The step retries. */
export class RevocationFailed extends Schema.TaggedError<RevocationFailed>()("@smthrs/mvp/auth/RevocationFailed", {
  reason: Schema.Literals(["github_unavailable", "github_misconfigured", "database", "unreadable"]),
}) {}

/** What ending the session did: ended it, or found it over already. */
const Ended = Schema.Struct({ outcome: Schema.Literals(["ended", "over"]) })

/**
 * Sign-out steps, by `step` (`end`, `revoke`, `forget`) and `outcome`: `Ended`'s or `Revoked`'s, or `failed` for one
 * failed attempt.
 */
export const revocations = Metric.counter("smithers_auth_token_revocations", {
  description: "Sign-out steps and GitHub token revocations, by step and outcome",
  incremental: true,
})

const payload = { sessionId: Schema.String }

/**
 * The first step ends the session and transfers its sealed tokens to durable cleanup. Only Postgres can fail it, and
 * the revocation waits for it, so its retry policy never gives up.
 */
export const EndSession = Action.make("auth/EndSession", {
  payload,
  success: Ended,
  error: RevocationFailed,
  capabilities: ["db:write:sessions", "db:write:host_sessions", "db:write:github_token_cleanups", "db:write:session_end_receipts"],
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 }),
})

/** The step: revoke the ended session's GitHub access token on GitHub, then forget its tokens. */
export const RevokeToken = Action.make("auth/RevokeToken", {
  payload,
  success: Revoked,
  error: RevocationFailed,
  capabilities: ["db:write:sessions", "db:write:host_sessions", "db:write:github_token_cleanups", "db:write:session_end_receipts"],
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, maxAttempts: 5 }),
})

/**
 * The step after exhausted attempts preserves cleanup for the sweeper. Only Postgres can
 * fail it, so its retry policy never gives up.
 */
export const ForgetTokens = Action.make("auth/ForgetTokens", {
  payload,
  success: Revoked,
  error: RevocationFailed,
  capabilities: ["db:write:sessions", "db:write:host_sessions", "db:write:github_token_cleanups", "db:write:session_end_receipts"],
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 }),
})

/** `auth/RevokeGitHubToken`: signs a session out, revoking its GitHub token and forgetting it. */
export const RevokeGitHubToken = Flow.make("auth/RevokeGitHubToken", {
  description: "Sign a session out: end it, revoke its GitHub token on GitHub, then forget its GitHub tokens.",
  capabilities: ["db:write:sessions", "db:write:host_sessions", "db:write:github_token_cleanups", "db:write:session_end_receipts"],
  modelInvocable: false,
  payload,
  success: Revoked,
  error: RevocationFailed,
  body: Node.capture({}, (request) =>
    EndSession.call(request).pipe(
      Node.andThen(RevokeToken.call(request).pipe(Node.catch({ onFailure: () => ForgetTokens.call(request) }))),
    )),
})

/** What the revocation needs besides Postgres: the session keys, to open the token, and GitHub. */
export interface Services {
  readonly keys: SessionKeys
  readonly github: GitHubAuth["Service"]
}

const outcome = (value: Revoked["outcome"]): Revoked => ({ outcome: value })

/**
 * One revocation of session `sessionId`'s GitHub token, against the `SqlClient` in context. A live session is left
 * alone: the flow ends it first. Fails with GitHub's failure when GitHub was unavailable or refused the App, and with Postgres' failure.
 */
export const revoke = (sessionId: string, services: Services) =>
  Effect.gen(function* () {
    const found = yield* SessionStore.held(sessionId)
    if (Option.isSome(found) && found.value.live) return outcome("live")
    // Old durable runs still call this action. Cleanup rows now own tokens even after retention removes the session.
    yield* SessionStore.forgetTokens(sessionId)
    const sql = yield* Sql.SqlClient
    const rows = yield* sql<{ id: string }>`SELECT id FROM github_token_cleanups WHERE session_id = ${sessionId} AND finished_at IS NULL ORDER BY id`
    for (const row of rows) yield* Cleanup.revoke(row.id, services)
    return outcome(rows.length > 0 ? "revoked" : "none")
  })

/** A failure as a step reports it, by reason only: GitHub's failure, or anything Postgres did. */
const failed = (error: unknown) =>
  new RevocationFailed({
    reason: error instanceof Cleanup.CleanupFailed ? error.reason : !(error instanceof GitHubRefused)
      ? "database"
      : error.reason === "misconfigured"
      ? "github_misconfigured"
      : "github_unavailable",
  })

/**
 * One step over `database`, with its records: an `auth.revoke_token` log line and span, by `step`, and
 * `smithers_auth_token_revocations`. None carries a token, a login or GitHub's text.
 */
const recorded = <A extends { readonly outcome: string }, E, R>(
  sessionId: string,
  step: "end" | "revoke" | "forget",
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
) =>
  effect.pipe(
    Effect.provide(database),
    Effect.tapError((error) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(revocations, { step, outcome: "failed" }), 1),
        Effect.logWarning("auth.revoke_token").pipe(
          Effect.annotateLogs({ sessionId, step, outcome: "failed", errorCode: codeOf(error) }),
        ),
      )
    ),
    Effect.mapError(failed),
    Effect.tap((result) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(revocations, { step, outcome: result.outcome }), 1),
        Effect.logInfo("auth.revoke_token").pipe(Effect.annotateLogs({ sessionId, step, outcome: result.outcome })),
      )
    ),
    Effect.withSpan("auth.revoke_token", {
      attributes: { "smithers.auth.session_id": sessionId, "smithers.auth.step": step },
    }),
  )

/** Ends session `sessionId` for signing out, over `database`, with its records; a session that ended is left alone. */
export const end = <E, R>(sessionId: string, database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  recorded(
    sessionId,
    "end",
    Effect.map(SessionStore.revoke({ id: sessionId }, "sign_out"), (ended) => ({
      outcome: Option.isSome(ended) ? "ended" as const : "over" as const,
    })),
    database,
  )

/** One revocation over `database`, with its records. */
export const observed = <E, R>(
  sessionId: string,
  services: Services,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
) => recorded(sessionId, "revoke", revoke(sessionId, services), database)

/** Forgets the session's tokens after a revocation that failed every attempt, over `database`, with its records. */
export const forget = <E, R>(sessionId: string, database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  recorded(sessionId, "forget", Effect.as(SessionStore.forgetTokens(sessionId), outcome("forgotten")), database)

/**
 * Registers `auth/RevokeGitHubToken` with its steps, reaching Postgres through `database` and GitHub through
 * `services`.
 */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, services: Services) =>
  Interpreter.layerWithImplementations(
    RevokeGitHubToken,
    Layer.mergeAll(
      EndSession.toLayer(({ sessionId }) => end(sessionId, database)),
      RevokeToken.toLayer(({ sessionId }) => observed(sessionId, services, database)),
      ForgetTokens.toLayer(({ sessionId }) => forget(sessionId, database)),
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
