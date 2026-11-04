import { Duration, Effect, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { Actor } from "./Actor.ts"
import { ROLES } from "../src/features/auth/contract.ts"
import type * as RepoRoles from "./github/RepoRoles.ts"
import { sessionDeadline, sessionLive } from "./SessionStore.ts"

/** The sign-in authority retained by a write, including an alias when it came through one. */
export const Session = Schema.Struct({
  personId: Schema.String,
  sessionId: Schema.String,
  alias: Schema.optional(Schema.String),
  /** The key that verified the admitting cookie; older recorded payloads without it retain the legacy key. */
  cookieKey: Schema.optional(Schema.String),
  // Missing on legacy protected payloads: those fail closed rather than guessing the role's scope.
  scope: Schema.optional(Schema.Union([
    Schema.TaggedStruct("Deployment", {}),
    Schema.TaggedStruct("Repo", { held: Schema.Struct({ repoId: Schema.String, personId: Schema.String,
      role: Schema.NullOr(Schema.Literals(ROLES)), checkedAt: Schema.optional(Schema.String) }) }),
  ])),
})
export type Session = typeof Session.Type

/** Local development has no session. A signed-in write always retains the session it was admitted by. */
export const sessionOf = (actor: Actor): Session | undefined => actor.session === undefined ? undefined : {
  personId: actor.subject.id,
  sessionId: actor.session,
  ...(actor.alias === undefined ? {} : { alias: actor.alias }),
  cookieKey: actor.cookieKey ?? "legacy",
}

const checked = (live: boolean, alias: boolean) => Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan({ "write.authority.live": live, "write.authority.alias": alias })
  if (!live) yield* Effect.logWarning("write.authority_unavailable").pipe(Effect.annotateLogs({ reason: "session_authority" }))
  return live
})

/**
 * In the writing transaction, lock the session and alias before judging either by the database's current clock.
 * Revocation then serializes with the write. A read never calls this seam; a local write makes no query.
 */
export const holds = (session: Session | undefined) => Effect.gen(function* () {
  if (session === undefined) return true
  const sql = yield* SqlClient.SqlClient
  const [locked] = yield* sql`
    SELECT 1 FROM sessions WHERE id::text = ${session.sessionId} AND person_id::text = ${session.personId} FOR SHARE`
  if (locked === undefined) return yield* checked(false, session.alias !== undefined)
  if (session.alias !== undefined) {
    const [alias] = yield* sql`
      SELECT 1 FROM host_sessions WHERE id::text = ${session.alias} AND parent_id::text = ${session.sessionId} FOR SHARE`
    if (alias === undefined) return yield* checked(false, true)
  }
  return yield* live(session)
}).pipe(Effect.withSpan("write.authority"))

/** A single MVCC read for coedit; revocation can race the subsequent commit (decision 0151). */
export const live = (session: Session | undefined) => Effect.gen(function* () {
  if (session === undefined) return true
  const cookieKey = session.cookieKey ?? "legacy"
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ readonly live: boolean }>`
    SELECT ${yield* sessionLive(sql, sql`s`, undefined, session.alias === undefined ? cookieKey : undefined)}
      AND (${session.alias ?? null}::text IS NULL OR (h.id IS NOT NULL
        AND ${yield* sessionLive(sql, sql`s`, sql`h`, cookieKey)})) AS live
    FROM sessions s LEFT JOIN host_sessions h ON h.id::text = ${session.alias ?? null} AND h.parent_id = s.id
    WHERE s.id::text = ${session.sessionId} AND s.person_id::text = ${session.personId}`
  return yield* checked(row?.live === true, session.alias !== undefined)
}).pipe(Effect.withSpan("write.authority"))

/** The earliest session deadline, read under the authority locks held by this transaction. */
export const deadline = (sql: SqlClient.SqlClient, session: Session | undefined) => session === undefined
  ? sql`'infinity'::timestamptz`
  : sql`coalesce((SELECT least(s.expires_at, ${sessionDeadline(sql, sql`s`, session.alias === undefined ? undefined : sql`h`)})
      FROM sessions s LEFT JOIN host_sessions h ON h.id::text = ${session.alias ?? null} AND h.parent_id = s.id
      WHERE s.id::text = ${session.sessionId} AND s.person_id::text = ${session.personId}
        AND (${session.alias ?? null}::text IS NULL OR h.id IS NOT NULL)), '-infinity'::timestamptz)`

/** Raised inside a transaction so every preceding write rolls back before the route reports a retryable refusal. */
export class Expired extends Schema.TaggedError<Expired>()("WriteAuthorityExpired", {}) {}

/** Last check after all potentially blocking writes; session/key changes serialize on the already-held locks. */
export const requireAtCommit = (session: Session | undefined) => Effect.gen(function* () {
  if (session === undefined) return
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ live: boolean }>`SELECT clock_timestamp() < ${deadline(sql, session)} AS live`
  yield* Effect.annotateCurrentSpan({ "write.authority.stage": "commit" })
  if (!(yield* checked(row?.live === true, session.alias !== undefined))) return yield* new Expired({})
}).pipe(Effect.withSpan("write.authority"))

/** Fixed database bounds for a short write transaction, installed before its first lock. Postgres 17 owns the cap. */
export const bound = Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
  SELECT set_config('lock_timeout', '1s', true), set_config('statement_timeout', '2s', true),
    CASE WHEN current_setting('transaction_timeout')::interval > interval '0s'
      AND current_setting('transaction_timeout')::interval <= interval '5s'
      THEN current_setting('transaction_timeout') ELSE set_config('transaction_timeout', '5s', true) END`)

/** Explicit local authority is null; a missing legacy authority fails closed at delayed step execution. */
export const Admission = Schema.optional(Schema.NullOr(Session))
export const admitted = (authority: Session | null | undefined) =>
  authority === undefined ? Effect.succeed(false) : holds(authority ?? undefined)

/** Retain the scope that supplied a protected write's role, alongside its sign-in identity. */
export const protectedOf = (actor: Actor, held: Option.Option<RepoRoles.Held> = Option.none()): Session | null => {
  const session = sessionOf(actor)
  return session === undefined ? null : { ...session,
    scope: Option.isSome(held) ? { _tag: "Repo", held: held.value } : { _tag: "Deployment" } }
}


/** Budgets cover the complete Effect, including service/layer acquisition, BEGIN and COMMIT. */
export const WAIT_MILLIS = {
  role: 10_000, role_refresh: 10_000, retry_candidate: 2_000, run_status: 2_000,
  runner_lookup: 2_000, commit: 6_000,
} as const
export class WaitExpired extends Schema.TaggedError<WaitExpired>()("write/WaitExpired", {
  stage: Schema.Literals(Object.keys(WAIT_MILLIS) as Array<keyof typeof WAIT_MILLIS>),
  code: Schema.Literal("unavailable"),
  retryAfterSeconds: Schema.optional(Schema.Number),
}) {}
export const waitTimeouts = Metric.counter("smithers_write_wait_timeouts", { incremental: true,
  description: "Bounded synchronous write waits that expired, by stage" })

/** One bounded wait, with no detached work or renewed timer. Interruption cancels the underlying operation. */
export const wait = <A, E, R>(stage: keyof typeof WAIT_MILLIS, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeoutOrElse({ duration: Duration.millis(WAIT_MILLIS[stage]), orElse: () => Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(waitTimeouts, { stage }), 1)
    yield* Effect.logWarning("write.wait").pipe(Effect.annotateLogs({ stage, outcome: "timeout", budgetMs: WAIT_MILLIS[stage] }))
    return yield* new WaitExpired({ stage, code: "unavailable", retryAfterSeconds: 1 })
  }) }))
