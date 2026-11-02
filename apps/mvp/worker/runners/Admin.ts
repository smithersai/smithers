import { AgentRunner } from "@smthrs/agent"
import { digestSync } from "@smthrs/crypto"
import { Cause, Clock, Effect, type Layer, Metric, Option, Redacted, Schema } from "effect"
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
import { installedOn, repoRoleOn, roleOn } from "../branch/Access.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Flows from "../Flows.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import * as AdminFlows from "./AdminFlows.ts"
import * as Overflow from "./Overflow.ts"
import * as Store from "./Store.ts"

// The Admin routes for a repository's runners and agents (decision 0136, docs/features/agent-runners.md#admin):
//
// - `PUT /api/repos/<owner>/<name>/runners/<runner> { tokenSha256, labels, capacity }` registers a runner machine
//   (`admin/AddRunner`); `DELETE` retires it (`admin/RemoveRunner`). The runner made its token itself
//   (`smthrs runner token`); only its SHA-256 comes here.
// - `PUT /api/repos/<owner>/<name>/agents/<agent> { labels, profile, maxHours?, restarts?, coding? }` names an external
//   agent (`admin/SetAgent`); `DELETE` removes it (`admin/RemoveAgent`). `GET` answers `{ name, coding }` once the write
//   has landed, 404 before: a 202 means the flow started, and until it writes, TODOs read the repository's old agent.
// - `PUT /api/repos/<owner>/<name>/overflow/cloudflare { connectionId, profile, argv, labels?, minQueuedSeconds?,
//   capacity? }` turns the repository's Cloudflare overflow on (`admin/SetOverflow`, decision 0144) with one of the
//   Admin's own API-key connections; `DELETE` turns it off (`admin/RemoveOverflow`). The route mints the overflow
//   runner's token itself and seals it under SECRETS_KEY before the flow starts: no person, journal or log sees it, and
//   each PUT rotates it. Without SECRETS_KEY it is `503 unavailable`.
//
// Each needs an Admin of the repository acting in person, never an agent, flow or sandbox acting for them; the route
// admits the write, then starts the flow and answers 202. A PUT needs the App's recorded installation on the repository
// and the Admin role GitHub gives there (decision 0148); a GET or DELETE, the role they work with there (decision 0079).

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
const OverflowBody = Schema.Struct({
  connectionId: Overflow.Setting.fields.connectionId,
  profile: Overflow.Setting.fields.profile,
  argv: Overflow.Setting.fields.argv,
  labels: Schema.optional(Overflow.Setting.fields.labels),
  minQueuedSeconds: Schema.optional(Overflow.Setting.fields.minQueuedSeconds),
  capacity: Schema.optional(Overflow.Setting.fields.capacity),
})
const decodeOverflow = Schema.decodeUnknownEffect(Schema.fromJsonString(OverflowBody))

/** A fresh runner token: 32 random bytes as base64url, as `smthrs runner token` makes one. */
const mintToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

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
    const op = request.method === "DELETE" ? "delete" : request.method === "GET" ? "get" : "put"
    const fields: Fields = { kind: route.kind, op }
    const refuse = (status: number, code: Refusal) => {
      fields.code = code
      return HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
    }
    const response = yield* Effect.gen(function* () {
      const readable = route.kind === "agents"
      if (request.method !== "PUT" && request.method !== "DELETE" && !(op === "get" && readable)) {
        return HttpServerResponse.empty({ status: 405, headers: { allow: readable ? "GET, PUT, DELETE" : "PUT, DELETE" } })
      }
      const actor = yield* sessions.resolve
      if (Option.isNone(actor)) return refuse(401, "authentication")
      if (yield* refusesPersonOnly(actor.value, route.kind === "agents" ? "agent" : "runner")) {
        return refuse(403, "forbidden")
      }
      const repo = repoId(route.owner, route.name)
      // A write grants a machine the repository's jobs, their prompts and code, and a pull request the App writes: it
      // needs the App's recorded installation there and the Admin role GitHub gives there, never the deployment's
      // (decision 0148). Reading an agent, or retiring a runner or agent, takes the role the person works with.
      const role = op === "put"
        ? yield* repoRoleOn(actor.value, repo).pipe(Effect.provide(database))
        : yield* roleOn(actor.value, repo, yield* installedOn(repo).pipe(Effect.provide(database)))
      if (role !== "admin") return refuse(403, "forbidden")
      if (!isName(route.item)) return refuse(400, "invalid")
      if (route.kind === "overflow" && route.item !== "cloudflare") return refuse(404, "not_found")
      fields.repoId = repo
      fields.name = route.item
      if (op === "get") {
        const agent = yield* Store.agent(repo, route.item).pipe(Effect.provide(database))
        if (Option.isNone(agent)) return refuse(404, "not_found")
        fields.outcome = "read"
        return HttpServerResponse.jsonUnsafe(agent.value, { headers: noStore })
      }
      const executionId = adminExecutionId(route.kind, op, crypto.randomUUID())
      const actorId = actor.value.subject.id
      const start = (flow: (typeof AdminFlows.flows)[number], payload: unknown) =>
        starter.start(flow, { executionId, payload }).pipe(Effect.result)
      if (op === "delete") {
        const flow = route.kind === "runners"
          ? AdminFlows.RemoveRunner
          : route.kind === "agents"
          ? AdminFlows.RemoveAgent
          : AdminFlows.RemoveOverflow
        if ((yield* start(flow, { repoId: repo, name: route.item, actorId }))._tag === "Failure") {
          return refuse(503, "unavailable")
        }
        fields.outcome = "removing"
        return HttpServerResponse.jsonUnsafe({ name: route.item }, { status: 202, headers: noStore })
      }
      const body = yield* readBounded(request, MAX_ADMIN_BODY_BYTES).pipe(Effect.result)
      if (body._tag === "Failure") return body.failure.reason === "too_large" ? refuse(413, "too_large") : refuse(400, "invalid")
      if (route.kind === "overflow") {
        const wanted = yield* decodeOverflow(body.success).pipe(Effect.option)
        if (Option.isNone(wanted)) return refuse(400, "invalid")
        // SECRETS_KEY seals the token; a host that provides none (or has it off) can't turn overflow on.
        const keys = Option.flatten(yield* Effect.serviceOption(SecretKeys))
        if (Option.isNone(keys)) return refuse(503, "unavailable")
        // The key that pays is the Admin's own, active, on a model wire.
        const connection = yield* Overflow.connectionOf(actorId, wanted.value.connectionId).pipe(Effect.provide(database))
        if (Option.isNone(connection)) return refuse(400, "invalid")
        const origin = new URL(request.originalUrl).origin
        const token = mintToken()
        const sealed = yield* keys.value.cipher.seal(Redacted.make(token), Overflow.tokenContext(repo, keys.value.version))
        const payload = {
          repoId: repo,
          personId: actorId,
          origin,
          connectionId: wanted.value.connectionId,
          profile: wanted.value.profile,
          argv: wanted.value.argv,
          labels: wanted.value.labels ?? [],
          minQueuedSeconds: wanted.value.minQueuedSeconds ?? 60,
          capacity: wanted.value.capacity ?? 2,
          tokenSha256: digestSync(token),
          token: { ciphertext: sealed.ciphertext, nonce: sealed.nonce, keyVersion: keys.value.version },
          actorId,
        }
        if ((yield* start(AdminFlows.SetOverflow, payload))._tag === "Failure") return refuse(503, "unavailable")
      } else if (route.kind === "runners") {
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
