import { Effect, Metric } from "effect"
import { SqlClient } from "effect/sql"
import type { Role } from "#vibelang/source/worker/Actor"
import * as WriteAuthority from "./WriteAuthority.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { latestRole, latestRoleVerifiedAt, RoleFreshMs } from "./SessionStore.ts"
import type { Session } from "./WriteAuthority.ts"

export const checks = Metric.counter("smithers_protected_authority_checks", {
  incremental: true, description: "Protected write authority checks, by held, unavailable or denied outcome",
})

export const commitChecks = Metric.counter("smithers_protected_authority_commit_checks", {
  incremental: true, description: "Protected writes checked after all mutations, by held or unavailable outcome",
})

/** Read under the role/person lock already held by check. Missing and future observations have no authority. */
const roleDeadline = (sql: SqlClient.SqlClient, authority: Session) => Effect.gen(function* () {
  if (authority.scope === undefined) return sql`'-infinity'::timestamptz`
  if (authority.scope._tag === "Repo") {
    const held: RepoRoles.Held = authority.scope.held
    return sql`coalesce((SELECT CASE WHEN checked_at <= clock_timestamp()
      THEN checked_at + make_interval(secs => ${held.freshSeconds ?? RepoRoles.FRESH_SECONDS})
      ELSE '-infinity'::timestamptz END FROM github_repo_roles
      WHERE repo_id = ${held.repoId} AND person_id = ${held.personId}), '-infinity'::timestamptz)`
  }
  const window = yield* RoleFreshMs
  const verified = latestRoleVerifiedAt(sql, sql`${authority.personId}::uuid`)
  return sql`CASE WHEN ${verified} <= clock_timestamp()
    THEN ${verified} + (${window} * interval '1 millisecond') ELSE '-infinity'::timestamptz END`
})

const live = (authority: Session) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ live: boolean }>`SELECT clock_timestamp() <
    least(${WriteAuthority.deadline(sql, authority)}, ${yield* roleDeadline(sql, authority)}) AS live`
  return row?.live === true
})

/** In the final transaction, distinguish missing authority from a live person's confirmed permission denial. */
export const check = (authority: Session | null | undefined, roles: ReadonlyArray<Role>) => Effect.gen(function* () {
  if (authority === null) return "held" as const // explicit sessionless local development
  if (authority?.scope === undefined) return "unavailable" as const
  if (authority.scope._tag === "Repo") {
    const held = authority.scope.held
    if (held.personId !== authority.personId) return "unavailable" as const
    // A fresh locked role can confirm denial; a missing, older or expired observation cannot.
    const role = yield* RepoRoles.checkHeld(held, roles)
    if (!(yield* WriteAuthority.holds(authority))) return "unavailable" as const
    // The role may have aged out while the session or alias lock waited.
    return (yield* live(authority)) ? role : "unavailable" as const
  }
  const sql = yield* SqlClient.SqlClient
  // SessionStore records all verified role observations under this same person lock.
  const [person] = yield* sql`SELECT 1 FROM people WHERE id::text = ${authority.personId} FOR SHARE`
  if (person === undefined || !(yield* WriteAuthority.holds(authority))) return "unavailable" as const
  if (!(yield* live(authority))) return "unavailable" as const
  const [row] = yield* sql<{ readonly role: Role | null }>`SELECT ${latestRole(sql, sql`${authority.personId}::uuid`)} AS role`
  return row?.role != null && roles.includes(row.role) ? "held" as const : "denied" as const
}).pipe(
  Effect.tap(outcome => Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(checks, { outcome }), 1)
    yield* Effect.annotateCurrentSpan({ "protected.authority.outcome": outcome })
    if (outcome !== "held") yield* Effect.logWarning("protected.authority").pipe(Effect.annotateLogs({ outcome }))
  })),
  Effect.withSpan("protected.authority"),
)

/** Stores that already return retryable stale authority keep their boolean check. */
export const holds = (authority: Session | null | undefined, roles: ReadonlyArray<Role>) =>
  Effect.map(check(authority, roles), outcome => outcome === "held")

/** Both grants and denials must survive every settings, audit and receipt-fold wait before settlement commits. */
export const requireAtCommit = (authority: Session | null | undefined) => Effect.gen(function* () {
  if (authority == null) return // explicit local/internal writes already checked by their caller
  const outcome = (yield* live(authority)) ? "held" : "unavailable"
  yield* Metric.update(Metric.withAttributes(commitChecks, { outcome }), 1)
  yield* Effect.annotateCurrentSpan({ "protected.authority.stage": "commit", "protected.authority.outcome": outcome })
  if (outcome === "unavailable") {
    yield* Effect.logWarning("protected.authority").pipe(Effect.annotateLogs({ stage: "commit", outcome }))
    return yield* new WriteAuthority.Expired({})
  }
}).pipe(Effect.withSpan("protected.authority"))
