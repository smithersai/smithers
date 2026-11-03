import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ROLES } from "../../src/features/auth/contract.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import * as WriteAuthority from "../WriteAuthority.ts"
import { latestRole } from "../SessionStore.ts"

// The fence every Admin action on a repository's runners, agents and overflow carries (decision 0148,
// docs/features/agent-runners.md#admin). The route reads the request's body first, then the authority it admits the
// action by, and hands the flow:
//
// - `authority`: the repository's role row and the admitting session and alias (`Repo`, revalidated through
//   `RepoRoles.holds` and the shared `WriteAuthority` write seam);
//   on the deployment's own repository, or one where Smithers recorded no installation, the sign-in session whose role
//   it was (`Session`: the session, and the alias it came through on another host, still live, and the person's newest
//   role Admin); with no session, local development's or a test's own person (`Local`), which only the expiry bounds.
// - `expiresAt`: `FENCE_SECONDS` from admission. An action that runs later writes nothing.
// - `generation`, `coding`: the resource's generation it was admitted against, and for an agent, the repository's
//   coding selection's (`admin_generations`, 0 for none yet), so an action that waited never overwrites a newer write.
//
// The writing transaction (worker/runners/Store.ts) takes the resource's lock (an advisory lock on its key, so even one
// not yet written serializes), answers a replay with the outcome already recorded before it changes anything, then
// locks the rows it writes and the authority's rows, checks the authority and the expiry by the clock as it stands then,
// and the generations; only then does it write, and remaining lock waits are bounded by the earliest session, role
// or fence expiry.
// Refused, it writes nothing and records why, `authorization_expired` or `superseded`, under the execution id, which
// the route answered with its 202. A payload with no fence (an action started before fences) is
// `authorization_expired`. A Worker still on the release before fences writes unfenced until it is replaced.

/** How long an admitted Admin action may wait for its write. */
export const FENCE_SECONDS = 5 * 60

/** The role row an action was admitted by (`RepoRoles.Held`). */
export const Held = Schema.Struct({
  repoId: Schema.String,
  personId: Schema.String,
  role: Schema.NullOr(Schema.Literals(ROLES)),
  checkedAt: Schema.optional(Schema.String),
})

/** An Admin action's fence (above). */
export const Fence = Schema.Struct({
  execution: Schema.String,
  expiresAt: Schema.Number,
  generation: Schema.Int,
  coding: Schema.optional(Schema.Int),
  authority: Schema.Union([
    Schema.TaggedStruct("Repo", {
      held: Held,
      // null is explicit local development; absent is a legacy payload that lost its sign-in authority.
      session: Schema.optional(Schema.NullOr(WriteAuthority.Session)),
    }),
    Schema.TaggedStruct("Session", {
      personId: Schema.String,
      sessionId: Schema.String,
      alias: Schema.optional(Schema.String),
    }),
    Schema.TaggedStruct("Local", {}),
  ]),
})
export type Fence = typeof Fence.Type

/** How an action that wrote nothing was refused. */
export type Refused = "authorization_expired" | "superseded"

/** Every outcome a receipt records. */
export type Outcome = "set" | "removed" | "missing" | Refused

/**
 * Inside the writing transaction, its resource locks held: whether the fence's authority still holds and the fence
 * hasn't expired. The authority's rows are locked first (`FOR SHARE`: the role row; or the person, the session and its
 * alias), so a change to them waits for the write, or the write sees the change; then each is judged by the clock as it
 * stands (`clock_timestamp()`), the fence's expiry last, right before the write.
 */
export const authorityHolds = (fence: Fence) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const held = fence.authority._tag === "Repo"
      ? fence.authority.session === undefined ? false
        : (yield* RepoRoles.holds(fence.authority.held)) && (fence.authority.session === null ||
          fence.authority.session.personId === fence.authority.held.personId && (yield* WriteAuthority.holds(fence.authority.session)))
      : fence.authority._tag === "Session"
      ? yield* sessionHolds(fence.authority.personId, fence.authority.sessionId, fence.authority.alias)
      : true
    if (!held) return false
    const [now] = yield* sql<{ readonly live: boolean }>`
      SELECT clock_timestamp() < ${deadline(sql, fence)} AS live`
    return now!.live
  })

/**
 * Whether the sign-in session (and the alias it came through) is live and the person's newest role is Admin: the
 * person's row, the session's and the alias's locked first, so neither a role recorded nor a session ended lands in
 * between.
 */
const sessionHolds = (personId: string, sessionId: string, alias: string | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [person] = yield* sql`SELECT 1 FROM people WHERE id::text = ${personId} FOR SHARE`
    if (person === undefined) return false
    if (!(yield* WriteAuthority.holds({ personId, sessionId, ...(alias === undefined ? {} : { alias }) }))) return false
    const [row] = yield* sql<{ readonly admin: boolean | null }>`
      SELECT ${latestRole(sql, sql`${personId}::uuid`)} = 'admin' AS admin`
    return row?.admin === true
  })

/** The earliest authority deadline, read in the database's clock from the rows this transaction holds. */
const deadline = (sql: SqlClient.SqlClient, fence: Fence) => {
  const session = fence.authority._tag === "Session" ? fence.authority
    : fence.authority._tag === "Repo" ? fence.authority.session : undefined
  const role = fence.authority._tag === "Repo" ? fence.authority.held : undefined
  return sql`least(to_timestamp(${fence.expiresAt}::float8 / 1000),
    ${WriteAuthority.deadline(sql, session)},
    ${role === undefined ? sql`'infinity'::timestamptz` : sql`(
      SELECT checked_at + make_interval(secs => ${RepoRoles.FRESH_SECONDS}) FROM github_repo_roles
      WHERE repo_id = ${role.repoId} AND person_id = ${role.personId})`})`
}

/**
 * Inside an admitted write's transaction: bound remaining lock waits by the earliest of fence expiry, session expiry
 * and repository-role freshness. Also judge that deadline now, after generation reads, without another round trip.
 */
export const untilExpiry = (fence: Fence) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ readonly live: boolean }>`
    SELECT set_config('lock_timeout',
      greatest(1, floor(extract(epoch FROM ${deadline(sql, fence)} - clock_timestamp()) * 1000))::bigint || 'ms', true),
      clock_timestamp() < ${deadline(sql, fence)} AS live`
  return row?.live === true
})

/** A write finishing after its authority deadline rolls back and is refused. */
export class LateCommit extends Schema.TaggedError<LateCommit>()("@smthrs/mvp/runners/LateCommit", {}) {}

/** Final check after all writes, against the same earliest authority deadline. */
export const stillHolds = (fence: Fence) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly live: boolean }>`SELECT coalesce(clock_timestamp() < ${deadline(sql, fence)}, false) AS live`,
      (rows) => rows[0]?.live === true,
    ))

/** Records how an Admin action ended, once per execution. */
export const receipt = (
  execution: string,
  action: { readonly repoId: string; readonly kind: "runners" | "agents" | "overflow"; readonly name: string },
  op: "put" | "delete",
  outcome: Outcome,
  actorId: string,
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`
      INSERT INTO admin_receipts (execution, repo_id, kind, name, op, outcome, actor_id)
      VALUES (${execution}, ${action.repoId}, ${action.kind}, ${action.name}, ${op}, ${outcome}, ${actorId})
      ON CONFLICT (execution) DO NOTHING`)

/** The outcome recorded for `execution`: what a replay of the same action answers. */
export const recorded = (execution: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly outcome: Outcome }>`SELECT outcome FROM admin_receipts WHERE execution = ${execution}`,
      (rows) => rows[0]?.outcome,
    ))

/** The receipt of `execution`, for `actorId` alone: none while the action hasn't ended. */
export const receiptOf = (execution: string, actorId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly kind: string; readonly name: string; readonly op: string; readonly outcome: Outcome }>`
        SELECT kind, name, op, outcome FROM admin_receipts WHERE execution = ${execution} AND actor_id = ${actorId}`,
      (rows) => rows[0],
    ))
