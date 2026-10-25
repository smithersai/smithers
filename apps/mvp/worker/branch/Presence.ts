import { Cause, Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import { Sessions } from "../Actor.ts"
import { codeOf } from "../ErrorCode.ts"
import { branchAccess, canView } from "./Access.ts"
import { Rooms } from "./Rooms.ts"
import { isUpgrade, sameOrigin } from "./Upgrade.ts"

// `GET /api/branches/<id>/room` with `Upgrade: websocket` (decision 0013 §4, docs/features/branch-workspace.md#presence):
// joins the page's socket to the branch's room, where everyone on the branch sees who else is and where. Only this
// app's own pages may (the `Origin` must be the request's), and only someone who may view the branch: the room stamps
// who they are from the session, never from anything the page sends. A change of sharing reaches the room through
// `Rooms.enforce` (worker/branch/Shares.ts).

/** Room join requests, by `outcome`: `joined`, or the refusal's code. */
export const joins = Metric.counter("smithers_branch_room_joins", {
  description: "GET /api/branches/<id>/room requests, by outcome",
  incremental: true,
})

const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))

const noStore = { "cache-control": "no-store" }

type Fields = Record<string, string | number | boolean>

/**
 * The room route over `database`, which opens a Postgres client for each request's scope. It reads who is asking from
 * `Sessions` and reaches the branch's room through `Rooms`. Each request is a span `branch.room`, a log line with the
 * branch, the access and the outcome, and a count; never a login.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => (branchId: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const startedAt = yield* Clock.currentTimeMillis
    const fields: Fields = {}
    const refuse = (status: number, code: string) => {
      fields.code = code
      return HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
    }
    const response = yield* Effect.gen(function* () {
      if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
      if (!isUpgrade(request)) return refuse(426, "upgrade")
      if (!sameOrigin(request)) return refuse(403, "origin")
      if (!isUuid(branchId)) return refuse(404, "not_found")
      fields.branchId = branchId.toLowerCase()
      const actor = yield* (yield* Sessions).resolve
      if (Option.isNone(actor)) return refuse(401, "authentication")
      const branch = yield* branchAccess(actor, branchId.toLowerCase()).pipe(Effect.provide(database))
      if (branch === undefined) return refuse(404, "not_found")
      if (!canView(branch.access)) return refuse(403, "forbidden")
      fields.access = branch.access
      const joined = yield* (yield* Rooms).join(branch.branchId, {
        principal: actor.value.subject.id,
        name: actor.value.login ?? actor.value.subject.id,
        // The role on the branch's repository the room re-checks shares with (decision 0079).
        role: branch.role,
        access: branch.access,
      })
      fields.outcome = "joined"
      return joined
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
    const outcome = String(fields.outcome ?? fields.code ?? "method")
    yield* Metric.update(Metric.withAttributes(joins, { outcome }), 1)
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, outcome })
    yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
      "branch.room",
    ).pipe(Effect.annotateLogs({ ...fields, outcome }))
    return response
  }).pipe(Effect.withSpan("branch.room", { kind: "server" }))
