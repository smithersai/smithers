import { AgentRunner } from "@smthrs/agent"
import { Cause, Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { repoId } from "../../src/features/repo/contract.ts"
import {
  adminExecutionId,
  MAX_ADMIN_BODY_BYTES,
  parseAdminRoute,
  type Refusal,
} from "../../src/features/runners/contract.ts"
import { refusesPersonOnly, Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { installedOn, roleOn } from "../branch/Access.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Flows from "../Flows.ts"
import * as AdminFlows from "./AdminFlows.ts"

// The Admin routes for a repository's runners and agents (decision 0136, docs/features/agent-runners.md#admin):
//
// - `PUT /api/repos/<owner>/<name>/runners/<runner> { tokenSha256, labels, capacity }` registers a runner machine
//   (`admin/AddRunner`); `DELETE` retires it (`admin/RemoveRunner`). The runner made its token itself
//   (`smthrs runner token`); only its SHA-256 comes here.
// - `PUT /api/repos/<owner>/<name>/agents/<agent> { labels, profile, maxHours?, restarts?, coding? }` names an external
//   agent (`admin/SetAgent`); `DELETE` removes it (`admin/RemoveAgent`).
//
// Each needs an Admin of the repository (the role they work with there, decision 0079) acting in person, never an
// agent, flow or sandbox acting for them; the route admits the write, then starts the flow and answers 202.

/** Admin route requests, by `kind`, `op` and `outcome`. */
export const requests = Metric.counter("smithers_runner_admin_requests", {
  description: "Requests to the runner and agent Admin routes, by kind, op and outcome",
  incremental: true,
})

/** Whether a path is one of the Admin routes. */
export const handles = (path: string): boolean => parseAdminRoute(path) !== undefined

const noStore = { "cache-control": "no-store" }

const RunnerBody = Schema.Struct({
  tokenSha256: AdminFlows.TokenSha256,
  labels: Schema.Array(AgentRunner.Label),
  capacity: AdminFlows.Capacity,
})
const AgentBody = Schema.Struct({
  labels: Schema.Array(AgentRunner.Label),
  profile: AgentRunner.Profile,
  maxHours: Schema.optional(Schema.Int),
  restarts: Schema.optional(Schema.Int),
  coding: Schema.optional(Schema.Boolean),
})
const decodeRunner = Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerBody))
const decodeAgentBody = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentBody))
const decodeAgent = Schema.decodeUnknownEffect(AgentRunner.Agent)
const isName = Schema.is(AgentRunner.Name)

type Fields = Record<string, string | number | boolean>

/**
 * The Admin routes over `database`. They read who is asking from `Sessions`, their role from `BranchRoles`, and start
 * the flows through `Flows.FlowStarter`.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => Effect.gen(function* () {
  const fetch = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const sessions = yield* Sessions
    const starter = yield* Flows.FlowStarter
    const startedAt = yield* Clock.currentTimeMillis
    const route = parseAdminRoute(request.url.split("?")[0]!)!
    const op = request.method === "DELETE" ? "delete" : "put"
    const fields: Fields = { kind: route.kind, op }
    const refuse = (status: number, code: Refusal) => {
      fields.code = code
      return HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
    }
    const response = yield* Effect.gen(function* () {
      if (request.method !== "PUT" && request.method !== "DELETE") {
        return HttpServerResponse.empty({ status: 405, headers: { allow: "PUT, DELETE" } })
      }
      const actor = yield* sessions.resolve
      if (Option.isNone(actor)) return refuse(401, "authentication")
      if (yield* refusesPersonOnly(actor.value, route.kind === "runners" ? "runner" : "agent")) {
        return refuse(403, "forbidden")
      }
      const repo = repoId(route.owner, route.name)
      const role = yield* roleOn(actor.value, repo, yield* installedOn(repo).pipe(Effect.provide(database)))
      if (role !== "admin") return refuse(403, "forbidden")
      if (!isName(route.item)) return refuse(400, "invalid")
      fields.repoId = repo
      fields.name = route.item
      const executionId = adminExecutionId(route.kind, op, crypto.randomUUID())
      const actorId = actor.value.subject.id
      const start = (flow: (typeof AdminFlows.flows)[number], payload: unknown) =>
        starter.start(flow, { executionId, payload }).pipe(Effect.result)
      if (op === "delete") {
        const flow = route.kind === "runners" ? AdminFlows.RemoveRunner : AdminFlows.RemoveAgent
        if ((yield* start(flow, { repoId: repo, name: route.item, actorId }))._tag === "Failure") {
          return refuse(503, "unavailable")
        }
        fields.outcome = "removing"
        return HttpServerResponse.jsonUnsafe({ name: route.item }, { status: 202, headers: noStore })
      }
      const body = yield* readBounded(request, MAX_ADMIN_BODY_BYTES).pipe(Effect.result)
      if (body._tag === "Failure") return body.failure.reason === "too_large" ? refuse(413, "too_large") : refuse(400, "invalid")
      if (route.kind === "runners") {
        const runner = yield* decodeRunner(body.success).pipe(Effect.option)
        if (Option.isNone(runner)) return refuse(400, "invalid")
        const payload = { repoId: repo, name: route.item, ...runner.value, actorId }
        if ((yield* start(AdminFlows.AddRunner, payload))._tag === "Failure") return refuse(503, "unavailable")
      } else {
        const settings = yield* decodeAgentBody(body.success).pipe(Effect.option)
        if (Option.isNone(settings)) return refuse(400, "invalid")
        const agent = yield* decodeAgent({
          name: route.item,
          labels: settings.value.labels,
          profile: settings.value.profile,
          maxHours: settings.value.maxHours ?? 4,
          restarts: settings.value.restarts ?? 1,
        }).pipe(Effect.option)
        if (Option.isNone(agent) || route.item === "smithers") return refuse(400, "invalid")
        const payload = { repoId: repo, agent: agent.value, coding: settings.value.coding ?? false, actorId }
        if ((yield* start(AdminFlows.SetAgent, payload))._tag === "Failure") return refuse(503, "unavailable")
      }
      fields.outcome = "setting"
      return HttpServerResponse.jsonUnsafe({ name: route.item }, { status: 202, headers: noStore })
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
    const outcome = String(fields.outcome ?? fields.code ?? "refused")
    yield* Metric.update(Metric.withAttributes(requests, { kind: route.kind, op, outcome }), 1)
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, outcome })
    yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
      "runner.admin_request",
    ).pipe(Effect.annotateLogs({ ...fields, outcome }))
    return response
  }).pipe(Effect.withSpan("runner.admin_request", { kind: "server" }))
  return { fetch }
})
