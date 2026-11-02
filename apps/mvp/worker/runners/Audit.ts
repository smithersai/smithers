import { Cause, Clock, Effect, type Layer, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { refusesPersonOnly, Sessions } from "../Actor.ts"
import { codeOf } from "../ErrorCode.ts"

// The runner audit (decision 0148, docs/features/agent-runners.md#audit): `GET /api/runners/audit`, for an Admin of
// the deployment's own repository (the session's role) acting in person. It lists every live runner on every
// repository with who registered it, when, and the App's installation on its repository as Smithers recorded it, and
// flags each runner registered where no installation was recorded, or before the installation record was last written:
// before 2026-11-02 such a registration could take the deployment-wide role instead of the role GitHub gives on the
// repository. Never a token or a token's digest.

/** The route's path. */
export const ROUTE = "/api/runners/audit"

/** Whether a path is the audit route. */
export const handles = (path: string): boolean => path === ROUTE

/**
 * The column a runner's registration is compared with: `github_repositories` keeps no time the installation was first
 * recorded, and `checked_at` is set by every write of the row (worker/github/Store.ts).
 */
export const INSTALLATION_TIME = "github_repositories.checked_at"

/** Why a runner's registration may not have proved access to its repository. */
export type Flag = "no_installation" | "installation_recorded_after_added"

/** One live runner as the audit lists it. */
export interface Row {
  readonly repoId: string
  readonly name: string
  /** The person who registered it (`runners.added_by`), and their GitHub login when Smithers knows them. */
  readonly addedBy: string
  readonly addedByLogin: string | null
  readonly addedAt: string
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
      return HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
    }
    const response = yield* Effect.gen(function* () {
      if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
      const actor = yield* (yield* Sessions).resolve
      if (Option.isNone(actor)) return refuse(401, "authentication")
      if (yield* refusesPersonOnly(actor.value, "runner")) return refuse(403, "forbidden")
      // The session's role is the role on the deployment's own repository (decision 0079).
      if (actor.value.role !== "admin") return refuse(403, "forbidden")
      const rows = yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{
        readonly repoId: string
        readonly name: string
        readonly addedBy: string
        readonly addedByLogin: string | null
        readonly addedAt: string
        readonly labels: ReadonlyArray<string>
        readonly seenAt: string | null
        readonly recorded: boolean
        readonly checkedAt: string | null
        readonly recordedAfter: boolean
      }>`
        SELECT r.repo_id AS "repoId", r.name, r.added_by AS "addedBy", p.github_login AS "addedByLogin",
          to_json(r.added_at)#>>'{}' AS "addedAt", r.labels, to_json(r.seen_at)#>>'{}' AS "seenAt",
          coalesce(g.installation_id IS NOT NULL, false) AS recorded,
          to_json(g.checked_at)#>>'{}' AS "checkedAt",
          coalesce(g.checked_at > r.added_at, false) AS "recordedAfter"
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
        labels: row.labels,
        seenAt: row.seenAt,
        installation: { recorded: row.recorded, checkedAt: row.checkedAt },
        flags: [
          ...(row.recorded ? [] : ["no_installation" as const]),
          ...(row.recorded && row.recordedAfter ? ["installation_recorded_after_added" as const] : []),
        ],
      }))
      fields.runners = runners.length
      fields.flagged = runners.filter((runner) => runner.flags.length > 0).length
      fields.outcome = "listed"
      return HttpServerResponse.jsonUnsafe({ installationTime: INSTALLATION_TIME, runners }, { headers: noStore })
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
