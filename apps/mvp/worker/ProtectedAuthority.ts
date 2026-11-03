import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Role } from "./Actor.ts"
import * as WriteAuthority from "./WriteAuthority.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { latestRole } from "./SessionStore.ts"
import type { Session } from "./WriteAuthority.ts"

/** In the final transaction, serialize with role observations as well as sign-out. */
export const holds = (authority: Session | null | undefined, roles: ReadonlyArray<Role>) => Effect.gen(function* () {
  if (authority === null) return true // explicit sessionless local development
  if (authority?.scope === undefined) return false
  if (authority.scope._tag === "Repo") {
    const held = authority.scope.held
    return held.personId === authority.personId && held.role !== null && roles.includes(held.role)
      && (yield* RepoRoles.holds(held)) && (yield* WriteAuthority.holds(authority))
  }
  const sql = yield* SqlClient.SqlClient
  // SessionStore records all verified role observations under this same person lock.
  const [person] = yield* sql`SELECT 1 FROM people WHERE id::text = ${authority.personId} FOR SHARE`
  if (person === undefined || !(yield* WriteAuthority.holds(authority))) return false
  const [row] = yield* sql<{ readonly role: Role | null }>`SELECT ${latestRole(sql, sql`${authority.personId}::uuid`)} AS role`
  return row?.role != null && roles.includes(row.role)
})
