import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { Actor } from "./Actor.ts"

/** The sign-in authority retained by a write, including an alias when it came through one. */
export const Session = Schema.Struct({
  personId: Schema.String,
  sessionId: Schema.String,
  alias: Schema.optional(Schema.String),
})
export type Session = typeof Session.Type

/** Local development has no session. A signed-in write always retains the session it was admitted by. */
export const sessionOf = (actor: Actor): Session | undefined => actor.session === undefined ? undefined : {
  personId: actor.subject.id,
  sessionId: actor.session,
  ...(actor.alias === undefined ? {} : { alias: actor.alias }),
}

/**
 * In the writing transaction, lock the session and alias before judging either by the database's current clock.
 * Revocation then serializes with the write. A read never calls this seam; a local write makes no query.
 */
export const holds = (session: Session | undefined) => Effect.gen(function* () {
  if (session === undefined) return true
  const sql = yield* SqlClient.SqlClient
  const [locked] = yield* sql`
    SELECT 1 FROM sessions WHERE id::text = ${session.sessionId} AND person_id::text = ${session.personId} FOR SHARE`
  if (locked === undefined) return false
  if (session.alias !== undefined) {
    const [alias] = yield* sql`
      SELECT 1 FROM host_sessions WHERE id::text = ${session.alias} AND parent_id::text = ${session.sessionId} FOR SHARE`
    if (alias === undefined) return false
  }
  const [row] = yield* sql<{ readonly live: boolean }>`
    SELECT s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
      AND (${session.alias ?? null}::text IS NULL OR EXISTS (
        SELECT 1 FROM host_sessions h WHERE h.id::text = ${session.alias ?? null}
          AND h.parent_id = s.id AND h.revoked_at IS NULL)) AS live
    FROM sessions s WHERE s.id::text = ${session.sessionId} AND s.person_id::text = ${session.personId}`
  return row?.live === true
})

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
