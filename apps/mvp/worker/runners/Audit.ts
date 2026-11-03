import { Cause, Clock, Effect, type Layer, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { refusesPersonOnly, Sessions } from "../Actor.ts"
import { codeOf } from "../ErrorCode.ts"
import * as SessionStore from "../SessionStore.ts"

// The runner audit (decision 0148, docs/features/agent-runners.md#audit): `GET /api/runners/audit`, for an Admin of
// the deployment's own repository (the session's role) acting in person. It lists every live runner on every
// repository with who registered it, when, whether a registration through the repository's Admin role authorized it,
// and the App's installation on its repository as Smithers recorded it. It flags each runner that claims nothing until
// someone acts: `needs_registration` (no registration through the route that takes the Admin role GitHub gives on the
// repository; migration `0095_runner_reauthorization` cleared every earlier one) and `no_installation`. Never a token
// or a token's digest.

/** The route's path. */
export const ROUTE = "/api/runners/audit"

/** Whether a path is the audit route. */
export const handles = (path: string): boolean => path === ROUTE

/** Why a runner claims nothing until someone acts. */
export type Flag = "needs_registration" | "no_installation"

/** One live runner as the audit lists it. */
export interface Row {
  readonly repoId: string
  readonly name: string
  /** The person who registered it (`runners.added_by`), and their GitHub login when Smithers knows them. */
  readonly addedBy: string
  readonly addedByLogin: string | null
  readonly addedAt: string
  /** When a registration through the repository's Admin role authorized it (decision 0148), or null. */
  readonly authorizedAt: string | null
  readonly labels: ReadonlyArray<string>
  readonly seenAt: string | null
  readonly installation: { readonly recorded: boolean; readonly checkedAt: string | null }
  readonly flags: ReadonlyArray<Flag>
}

const noStore = { "cache-control": "no-store" }

/** The audit route over `database`. It reads who is asking from `Sessions`. */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const fetch = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const startedAt = yield* Clock.currentTimeMillis
    const fields: Record<string, string | number> = {}
    const refuse = (status: number, code: string) => {
      fields.code = code
      return HttpServerResponse.jsonUnsafe({ code }, { status, headers: status === 503 ? { ...noStore, "retry-after": "5" } : noStore })
    }
    const response = yield* Effect.gen(function* () {
      if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
      const actor = yield* (yield* Sessions).resolve
      if (Option.isNone(actor)) return refuse(401, "authentication")
      if (yield* refusesPersonOnly(actor.value, "runner")) return refuse(403, "forbidden")
      // The deployment-wide audit requires current, confirmed authority even if the actor was resolved earlier.
      const role = yield* SessionStore.freshRole(actor.value).pipe(Effect.provide(database))
      if (role !== "admin") return refuse(403, "forbidden")
      const rows = yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{
        readonly repoId: string
        readonly name: string
        readonly addedBy: string
        readonly addedByLogin: string | null
        readonly addedAt: string
        readonly authorizedAt: string | null
        readonly labels: ReadonlyArray<string>
        readonly seenAt: string | null
        readonly recorded: boolean
        readonly checkedAt: string | null
      }>`
        SELECT r.repo_id AS "repoId", r.name, r.added_by AS "addedBy", p.github_login AS "addedByLogin",
          to_json(r.added_at)#>>'{}' AS "addedAt", to_json(r.repo_authorized_at)#>>'{}' AS "authorizedAt",
          r.labels, to_json(r.seen_at)#>>'{}' AS "seenAt",
          coalesce(g.installation_id IS NOT NULL, false) AS recorded,
          to_json(g.checked_at)#>>'{}' AS "checkedAt"
        FROM runners r
        LEFT JOIN github_repositories g ON g.repo_id = r.repo_id
        LEFT JOIN people p ON p.id::text = r.added_by
        WHERE r.removed_at IS NULL
        ORDER BY r.repo_id, r.name`).pipe(Effect.provide(database))
      const runners: Array<Row> = rows.map((row) => ({
        repoId: row.repoId,
        name: row.name,
        addedBy: row.addedBy,
        addedByLogin: row.addedByLogin,
        addedAt: row.addedAt,
        authorizedAt: row.authorizedAt,
        labels: row.labels,
        seenAt: row.seenAt,
        installation: { recorded: row.recorded, checkedAt: row.checkedAt },
        flags: [
          ...(row.authorizedAt === null ? ["needs_registration" as const] : []),
          ...(row.recorded ? [] : ["no_installation" as const]),
        ],
      }))
      fields.runners = runners.length
      fields.flagged = runners.filter((runner) => runner.flags.length > 0).length
      fields.outcome = "listed"
      // What the runner cutover marked (ops/runner-cutover/cutover.ts): it doesn't run until an Admin writes it again.
      const reconfirm = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.all({
          agents: sql`
            SELECT repo_id AS "repoId", name, coding, updated_by AS "updatedBy", to_json(reconfirm_at)#>>'{}' AS "markedAt"
            FROM agents WHERE reconfirm_at IS NOT NULL ORDER BY repo_id, name`,
          overflow: sql`
            SELECT repo_id AS "repoId", updated_by AS "updatedBy", to_json(reconfirm_at)#>>'{}' AS "markedAt"
            FROM repo_overflow WHERE reconfirm_at IS NOT NULL ORDER BY repo_id`,
        })).pipe(Effect.provide(database))
      return HttpServerResponse.jsonUnsafe({ runners, reconfirm }, { headers: noStore })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          fields.errorCode = codeOf(Cause.squash(cause))
          return refuse(503, "unavailable")
        })
      ),
    )
    fields.status = response.status
    fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
    yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
      "runner.audit",
    ).pipe(Effect.annotateLogs({ ...fields, outcome: String(fields.outcome ?? fields.code ?? "refused") }))
    return response
  }).pipe(Effect.withSpan("runner.audit", { kind: "server" }))
  return { fetch }
}
