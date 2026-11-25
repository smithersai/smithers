import * as Cloudflare from "@alchemy.run/cloudflare"
import { McpAdapter, Principal } from "@smthrs/app-core"
import type { ObjectDatabase } from "@smthrs/platform-cloudflare"
import { ShardProtocol } from "@smthrs/sync"
import { Effect, Option, Schema } from "effect"
import { Headers, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Reactivity from "effect/reactivity/Reactivity"
import { memberOrAbove, rankOf, Sessions } from "../Actor.ts"
import { repositoryOf } from "../github/Config.ts"
import type { RepoRoles } from "../github/RepoRoles.ts"
import * as ArtifactVisibility from "../ops/ArtifactVisibility.ts"
import { holdsDeploymentAuthority } from "../DeploymentPolicy.vibe"
import { MAX_PLAN_MCP_BYTES, readBounded } from "../Body.ts"
import * as PlanTreeShard from "./PlanTreeShard.ts"

const respond = (body: unknown) => HttpServerResponse.jsonUnsafe(body)
const invalid = HttpServerResponse.empty({ status: 400 })
const forbidden = HttpServerResponse.empty({ status: 403 })

export const handle = (plan: PlanTreeShard.LivePlanTree) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "https://plan.internal")
    const tokenRef = /^Bearer ([^\s]+)$/.exec(request.headers["authorization"] ?? "")?.[1]
    if (tokenRef === undefined) return HttpServerResponse.empty({ status: 401 })
    const evidence = { kind: "mcp", transport: "http", tokenRef } as const
    if (request.method === "POST" && url.pathname === "/api/plan/mcp") {
      const mcp = yield* McpAdapter.make({ engine: plan.engine, evidence })
      const body = yield* readBounded(request, MAX_PLAN_MCP_BYTES)
      const reply = yield* mcp.handle(body)
      return reply === undefined
        ? HttpServerResponse.empty({ status: 202 })
        : HttpServerResponse.text(reply, { contentType: "application/json" })
    }
    if (request.method === "GET" && url.pathname === "/api/plan/pull") {
      if (!(yield* plan.canRead(evidence))) return forbidden
      const query = yield* ShardProtocol.decodePullQuery(url.searchParams)
      if (query.shard !== plan.shard) return forbidden
      return respond(yield* plan.journal.pull(query))
    }
    if (request.method === "GET" && url.pathname === "/api/plan/snapshot") {
      if (!(yield* plan.canRead(evidence))) return forbidden
      const shard = yield* Schema.decodeUnknownEffect(ShardProtocol.ShardId)(url.searchParams.get("shard"))
      if (shard !== plan.shard) return forbidden
      return respond(yield* plan.journal.snapshot(shard))
    }
    return HttpServerResponse.empty({ status: 404 })
  }).pipe(Effect.catch((error) => {
    if (error._tag === "@smthrs/app-core/AuthRefused") return Effect.succeed(HttpServerResponse.empty({ status: 401 }))
    if (error._tag === "BodyRefused" && error.reason === "too_large") {
      return Effect.succeed(HttpServerResponse.empty({ status: 413 }))
    }
    return Effect.succeed(invalid)
  }))

export class PlanTreeObject extends Cloudflare.DurableObject<PlanTreeObject, {}>()("PlanTreeObject") {}

const admissionHeader = "x-smithers-plan-admission"

const Admission = Schema.Struct({ subject: Schema.String, session: Schema.String, write: Schema.Boolean })
const decodeAdmission = Schema.decodeUnknownOption(Schema.fromJsonString(Admission))

/** The bound object's handler. The Worker sends a fresh request containing only its own admission. */
export const makeShardHandler = (storage: ObjectDatabase.Storage, shard: ShardProtocol.ShardId) =>
  Effect.gen(function*() {
    const grants: Record<string, Principal.Grant> = Object.create(null)
    const credentials = Principal.make({ verify: Principal.sessions(grants) })
    const plan = yield* PlanTreeShard.make(storage, shard, credentials).pipe(Effect.provide(Reactivity.layer))
    return Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const admission = decodeAdmission(request.headers[admissionHeader])
      if (Option.isNone(admission)) return forbidden
      const token = crypto.randomUUID()
      const { subject, session, write } = admission.value
      const capabilities = [PlanTreeShard.readCapability(shard)]
      if (write) capabilities.push(PlanTreeShard.writeCapability(shard))
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => { grants[token] = { kind: "mcp", subject, session, capabilities } }),
        () => handle(plan).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest,
          request.modify({ headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }))),
        () => Effect.sync(() => { delete grants[token] }),
      )
    })
  })

export const live = PlanTreeObject.make(Effect.gen(function*() {
  const state = yield* Cloudflare.DurableObjectState
  return Effect.gen(function*() {
    const shard = yield* Schema.decodeUnknownEffect(ShardProtocol.ShardId)(state.raw.id.name).pipe(Effect.orDie)
    return { fetch: yield* makeShardHandler(state.raw.storage, shard).pipe(Effect.orDie) }
  })
}))

const repoPlanPath = /^\/api\/repos\/([^/]+)\/([^/]+)\/plan\/(mcp|pull|snapshot)$/

export const handles = (path: string): boolean => repoPlanPath.test(path)

/** Only this Worker can call the bound object. It overwrites any client-supplied admission. */
export const dispatch = <R, E2, R2>(
  forward: (shard: ShardProtocol.ShardId, request: HttpServerRequest.HttpServerRequest) =>
    Effect.Effect<HttpServerResponse.HttpServerResponse, E2, R2>,
  roles: RepoRoles<R>,
  policy: ArtifactVisibility.Policy,
) => Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url, "https://plan.internal")
  const match = repoPlanPath.exec(url.pathname)
  const repo = match && ArtifactVisibility.canonicalRepositoryId(`${match[1]}/${match[2]}`)
  if (!repo || !match) return HttpServerResponse.empty({ status: 404 })
  const current = yield* (yield* Sessions).resolve
  if (Option.isNone(current)) return HttpServerResponse.empty({ status: 401 })
  const actor = current.value
  if (ArtifactVisibility.isOpsRepository({ fullName: repo, private: true }, policy)
    && !holdsDeploymentAuthority(actor, policy.admins)) return HttpServerResponse.empty({ status: 404 })
  const { role } = yield* roles.resolve(actor, repositoryOf(repo)).pipe(Effect.orElseSucceed(() => ({ role: null })))
  const shard = yield* Schema.decodeUnknownEffect(ShardProtocol.ShardId)(`repo:${repo}`)
  const permits = (capability: string) => actor.act === undefined ||
    (actor.act.ceiling !== undefined && actor.act.ceiling.length > 0 &&
      actor.act.ceiling.every((group) => group.includes(capability)))
  if (!memberOrAbove(role) || !permits(PlanTreeShard.readCapability(shard))) return forbidden
  const write = rankOf(role) >= rankOf("maintainer") && permits(PlanTreeShard.writeCapability(shard))
  const content = yield* (request.method === "POST" ? readBounded(request, MAX_PLAN_MCP_BYTES) : Effect.undefined).pipe(Effect.result)
  if (content._tag === "Failure") {
    return HttpServerResponse.empty({ status: content.failure.reason === "too_large" ? 413 : 400 })
  }
  const body = content.success
  const outgoing = HttpServerRequest.fromWeb(new Request(`https://plan.internal/api/plan/${match[3]}${url.search}`, {
    method: request.method,
    ...(body === undefined ? {} : { body }),
    headers: {
      [admissionHeader]: JSON.stringify({ subject: actor.subject.id, session: actor.session ?? actor.subject.id, write }),
    },
  }))
  return yield* forward(shard, outgoing)
}).pipe(
  Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503 })),
  Effect.withSpan("plan.route"),
)

