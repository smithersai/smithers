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

/** A retained session's expiry as a SQL fragment, for the writer's current-clock check and remaining lock budget. */
export const deadline = (sql: SqlClient.SqlClient, session: Session | null | undefined) => session == null
  ? sql`'infinity'::timestamptz`
  : sql`(SELECT expires_at FROM sessions WHERE id::text = ${session.sessionId} AND person_id::text = ${session.personId})`
