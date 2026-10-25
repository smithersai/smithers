import { ShapeProxy } from "@smthrs/effect-electric"
import { Cause, Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../../src/features/chat/contract.ts"
import {
  MAX_SANDBOX_LIMITS_BODY_BYTES,
  SANDBOX_LIMIT_COLUMNS,
  SANDBOX_LIMITS_TABLE,
} from "../../src/features/spend/contract.ts"
import { SandboxLimitsRequest } from "../../src/features/spend/schema.ts"
import { refusesPersonOnly, Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import * as ShapeAccess from "../ShapeAccess.ts"
import * as Budget from "./Budget.ts"

// The sandbox limits as Admins set them (ruling AUTH-5, decision 0103, docs/features/sandbox-budgets.md#the-limits):
//
// - `POST /api/sandbox-limits { awake, perPerson, monthlyAlertUsd }`: an Admin, in person, sets them. The next machine
//   that wakes is admitted under them and the next hourly spend sample alerts under them, with no deploy.
// - `GET /api/shapes/sandbox-limits`: the limits, to Admins only; anyone else is refused 403 before Electric.
//
// Records carry the limits and the outcome; never who set them.

/** `POST /api/sandbox-limits` requests, by `status`. */
export const requests = Metric.counter("smithers_sandbox_limit_requests", {
  description: "POST /api/sandbox-limits requests, by status",
  incremental: true,
})

/** `GET /api/shapes/sandbox-limits` requests, by `status` and `live`. */
export const shapes = Metric.counter("smithers_sandbox_limit_shape_requests", {
  description: "GET /api/shapes/sandbox-limits requests, by status and live",
  incremental: true,
})

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxLimitsRequest))

type Fields = Record<string, string | number | boolean>

const noStore = { "cache-control": "no-store" }
const refusal = (status: number, code: string) => HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })

/** Only an Admin in person reads the limits. */
const audience = Effect.as(ShapeAccess.admin, "admin")

/**
 * Reads Electric's connection (`ShapeProxy.config`) and returns the routes: `set` for `POST /api/sandbox-limits`, and
 * the shape `limits`. Each `set` is a log line `sandbox.limits`, a span `sandbox.limits.request` and a count. `database`
 * opens a Postgres client for the scope of each request.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })

    const set = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const startedAt = yield* Clock.currentTimeMillis
      const fields: Fields = {}
      const response = yield* Effect.gen(function* () {
        if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
        const actor = yield* (yield* Sessions).resolve
        if (Option.isNone(actor)) return refusal(401, "authentication")
        // What machines may cost is the Admin's own choice: an agent, flow or sandbox acting for them is refused.
        if (yield* refusesPersonOnly(actor.value, "sandbox/limits")) return refusal(403, "person_only")
        if (actor.value.role !== "admin") return refusal(403, "forbidden")
        const body = yield* readBounded(request, MAX_SANDBOX_LIMITS_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(
          Effect.result,
        )
        if (body._tag === "Failure") {
          return body.failure.reason === "too_large" ? refusal(413, "too_large") : refusal(400, "invalid")
        }
        const limits = yield* decode(body.success).pipe(Effect.option)
        if (Option.isNone(limits)) return refusal(400, "invalid")
        Object.assign(fields, limits.value)
        const txid = yield* Budget.setLimits(limits.value, actor.value.subject.id).pipe(Effect.provide(database))
        return HttpServerResponse.jsonUnsafe({ txid }, { headers: noStore })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            fields.errorCode = codeOf(Cause.squash(cause))
            return refusal(503, "unavailable")
          })
        ),
      )
      fields.status = response.status
      fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
      yield* Metric.update(Metric.withAttributes(requests, { status: String(response.status) }), 1)
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
        "sandbox.limits",
      ).pipe(Effect.annotateLogs(fields))
      return response
    }).pipe(Effect.withSpan("sandbox.limits.request", { kind: "server" }))

    const limits = ShapeProxy.make({
      ...connection,
      shape: Effect.map(audience, (reader) => ({
        table: SANDBOX_LIMITS_TABLE,
        where: "audience = $1",
        params: { "1": reader },
        columns: [...SANDBOX_LIMIT_COLUMNS],
      })),
      name: "sandbox.limits.shape",
      metric: shapes,
    })

    return { set, limits }
  })
