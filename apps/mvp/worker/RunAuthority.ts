import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { Actor } from "./Actor.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { authority, roleFresh, RoleFreshMs } from "./SessionStore.ts"
import { mayRead } from "./stack/Access.ts"

/** Inside a run start or stop transaction: lock the authority's rows, then judge them by Postgres' current clock. */
export const stillAdmitted = (actor: Actor, resolved: RepoRoles.Resolved) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (actor.session !== undefined) {
      // Role observations serialize on the person; sign-out and alias revocation serialize on their session rows.
      const [person] = yield* sql`SELECT 1 FROM people WHERE id::text = ${actor.subject.id} FOR SHARE`
      if (person === undefined) return "authentication" as const
      const [session] = yield* sql`
        SELECT 1 FROM sessions WHERE id::text = ${actor.session} AND person_id::text = ${actor.subject.id} FOR SHARE`
      if (session === undefined) return "authentication" as const
      if (actor.alias !== undefined) {
        const [alias] = yield* sql`
          SELECT 1 FROM host_sessions WHERE id::text = ${actor.alias} AND parent_id::text = ${actor.session} FOR SHARE`
        if (alias === undefined) return "authentication" as const
      }
    }
    // Preserve the precise role receipt that admitted the request. This locks it and checks its freshness after waiting.
    if (Option.isSome(resolved.held) && !(yield* RepoRoles.holds(resolved.held.value))) return "forbidden" as const
    let role = resolved.role
    if (actor.session !== undefined) {
      // All authority locks are now held. A locking SELECT could have waited past the session's sliding expiry, its
      // or its alias's absolute deadline, or a reauthentication that restamped the row with another key.
      const found = yield* authority(actor.session, actor.alias ?? null, actor.cookieKey)
      if (Option.isNone(found)) return "authentication" as const
      // On the deployment's repository the newest session role receipt decides, including an ended session's demotion.
      if (Option.isNone(resolved.held)) {
        role = found.value.role
        // A demotion refuses outright; a grant needs a confirmation as fresh as the one that admitted the request.
        const fresh = roleFresh(found.value.roleVerifiedAt, found.value.serverNow, yield* RoleFreshMs)
        if (!fresh && mayRead(Option.some({ ...actor, role }))) return "unavailable" as const
      }
    }
    return mayRead(Option.some({ ...actor, role })) ? undefined : "forbidden" as const
  })
