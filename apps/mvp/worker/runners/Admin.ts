import * as WriteAuthority from "../WriteAuthority.ts"
import { AgentRunner } from "@smthrs/agent"
import { digestSync } from "@smthrs/crypto"
import { Cause, Clock, Context, Effect, type Layer, Metric, Option, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { repoId } from "../../src/features/repo/contract.ts"
import {
  ADMIN_RECEIPTS_ROUTE,
  adminExecutionId,
  MAX_ADMIN_BODY_BYTES,
  parseAdminRoute,
  type Refusal,
} from "../../src/features/runners/contract.ts"
import { refusesPersonOnly, Sessions } from "#vibelang/emitted/worker/Actor"
import { readBounded } from "#vibelang/emitted/worker/Body"
import { installedOn, repoRoleOn, roleOn } from "../branch/Access.ts"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import * as Flows from "#vibelang/emitted/worker/Flows"
import { SecretKeys } from "../secrets/Keys.ts"
import * as AdminFlows from "./AdminFlows.ts"
import * as Overflow from "./Overflow.ts"
import type * as RepoRoles from "../github/RepoRoles.ts"
import * as Fence from "./Fence.ts"
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
export const handles = (path: string): boolean =>
  parseAdminRoute(path) !== undefined || path.startsWith(ADMIN_RECEIPTS_ROUTE)

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

/** Ordering identity is captured before shared buffering; authority is still resolved only after EOF. */
class Expected extends Context.Service<Expected, { readonly generation: number; readonly coding?: number }>()("runner.admin.Expected") {}

export const ordered = <E, R, E2, R2>(database: Layer.Layer<SqlClient.SqlClient, E, R>, handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E2, R2>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const route = parseAdminRoute(request.url.split("?")[0]!)
    const retained = yield* Effect.serviceOption(Expected)
    if (Option.isSome(retained)) return yield* handler.pipe(Effect.provideService(Expected, retained.value))
    if (route === undefined || (request.method !== "PUT" && request.method !== "DELETE")) {
      return yield* handler.pipe(Effect.provideService(Expected, { generation: -1 }))
    }
    const repo = repoId(route.owner, route.name)
    const expected = yield* Effect.gen(function* () {
      const generation = yield* Store.generationOf(Store.resourceKey(
        route.kind === "agents" ? "agents" : "runners", repo, route.kind === "overflow" ? Overflow.RUNNER : route.item,
      ))
      const coding = route.kind === "agents" ? { coding: yield* Store.generationOf(Store.codingKey(repo)) } : {}
      return { generation, ...coding }
    }).pipe(Effect.provide(database), Effect.catchCause((cause) => Effect.gen(function* () {
      yield* Effect.logWarning("runner.admin_order").pipe(Effect.annotateLogs({ outcome: "unavailable", errorCode: codeOf(Cause.squash(cause)) }))
      return undefined
    })))
    if (expected === undefined) return HttpServerResponse.jsonUnsafe({ code: "unavailable" }, { status: 503, headers: noStore })
    return yield* handler.pipe(Effect.provideService(Expected, expected))
  })

type Fields = Record<string, string | number | boolean>

/**
 * The Admin routes over `database`. They read who is asking from `Sessions`, their role from `BranchRoles`, and start
 * the flows through `Flows.FlowStarter`.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => Effect.gen(function* () {
  /** `GET /api/runners/admin-receipts/<execution>`: the receipt of an action the person asking started. */
  const receipt = (request: HttpServerRequest.HttpServerRequest, execution: string) =>
    Effect.gen(function* () {
      const noStoreJson = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status, headers: noStore })
      if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
      const actor = yield* (yield* Sessions).resolve
      if (Option.isNone(actor)) return noStoreJson({ code: "authentication" }, 401)
      // The person who started the action, acting directly: never an agent, flow or sandbox acting for them.
      if (actor.value.act !== undefined) return noStoreJson({ code: "forbidden" }, 403)
      const found = yield* Fence.receiptOf(decodeURIComponent(execution), actor.value.subject.id).pipe(Effect.provide(database))
      return found === undefined ? noStoreJson({ code: "not_found" }, 404) : noStoreJson(found)
    }).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ code: "unavailable" }, { status: 503, headers: noStore }))))

  const fetch = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = request.url.split("?")[0]!
    if (path.startsWith(ADMIN_RECEIPTS_ROUTE)) {
      return yield* receipt(request, path.slice(ADMIN_RECEIPTS_ROUTE.length))
    }
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
      // A write's body is read whole before who is asking and their role are: a body that arrives slowly can't carry
      // an authority read before it past a change to that authority (decision 0148).
      const body = op === "put" ? yield* readBounded(request, MAX_ADMIN_BODY_BYTES).pipe(Effect.result) : undefined
      const actor = yield* sessions.resolve
      if (Option.isNone(actor)) return refuse(401, "authentication")
      if (yield* refusesPersonOnly(actor.value, route.kind === "agents" ? "agent" : "runner")) {
        return refuse(403, "forbidden")
      }
      const repo = repoId(route.owner, route.name)
      // A write grants a machine the repository's jobs, their prompts and code, and a pull request the App writes: it
      // needs the App's recorded installation there and the Admin role GitHub gives there, never the deployment's
      // (decision 0148). Retiring a runner or agent takes that role where the installation is recorded, else the role
      // the person works with; reading an agent, the role the person works with. A write carries the authority it was
      // admitted by in its fence (worker/runners/Fence.ts), which its own transaction checks again.
      const installed = yield* installedOn(repo).pipe(Effect.provide(database))
      const resolved = op === "put" || (op === "delete" && installed)
        ? yield* repoRoleOn(actor.value, repo).pipe(Effect.provide(database))
        : { role: yield* roleOn(actor.value, repo, installed), held: Option.none<RepoRoles.Held>() }
      if (resolved.role !== "admin") return refuse(403, "forbidden")
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
      const authority = Option.isSome(resolved.held)
        ? { _tag: "Repo" as const, held: resolved.held.value, session: WriteAuthority.sessionOf(actor.value) ?? null }
        : actor.value.session === undefined
        ? { _tag: "Local" as const }
        : {
          _tag: "Session" as const,
          personId: actorId,
          sessionId: actor.value.session,
          ...(actor.value.alias === undefined ? {} : { alias: actor.value.alias }),
        }
      const expected = yield* Expected
      const fence: Fence.Fence = {
        execution: executionId,
        expiresAt: (yield* Clock.currentTimeMillis) + Fence.FENCE_SECONDS * 1000,
        ...expected,
        authority,
      }
      const start = (flow: (typeof AdminFlows.flows)[number], payload: unknown) =>
        starter.start(flow, { executionId, payload }).pipe(Effect.result)
      /** The answer to an action started: its name and the execution whose receipt says how it ended. */
      const started = (outcome: string) => {
        fields.outcome = outcome
        fields.execution = executionId
        return HttpServerResponse.jsonUnsafe({ name: route.item, execution: executionId }, { status: 202, headers: noStore })
      }
      if (op === "delete") {
        const flow = route.kind === "runners"
          ? AdminFlows.RemoveRunner
          : route.kind === "agents"
          ? AdminFlows.RemoveAgent
          : AdminFlows.RemoveOverflow
        if ((yield* start(flow, { repoId: repo, name: route.item, actorId, fence }))._tag === "Failure") {
          return refuse(503, "unavailable")
        }
        return started("removing")
      }
      if (body === undefined || body._tag === "Failure") {
        return body?._tag === "Failure" && body.failure.reason === "too_large" ? refuse(413, "too_large") : refuse(400, "invalid")
      }
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
          // Admitted above by the Admin role GitHub gives on the repository (decision 0148).
          repoAuthorized: true,
          fence,
        }
        if ((yield* start(AdminFlows.SetOverflow, payload))._tag === "Failure") return refuse(503, "unavailable")
      } else if (route.kind === "runners") {
        const runner = yield* decodeRunner(body.success).pipe(Effect.option)
        if (Option.isNone(runner)) return refuse(400, "invalid")
        // Admitted above by the Admin role GitHub gives on the repository (decision 0148).
        const payload = { repoId: repo, name: route.item, ...runner.value, actorId, repoAuthorized: true, fence }
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
        const payload = { repoId: repo, agent: agent.value, coding: settings.value.coding ?? false, actorId, fence }
        if ((yield* start(AdminFlows.SetAgent, payload))._tag === "Failure") return refuse(503, "unavailable")
      }
      return started("setting")
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
  return { fetch: ordered(database, fetch), admit: <E2, R2>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E2, R2>) => ordered(database, handler) }
})
