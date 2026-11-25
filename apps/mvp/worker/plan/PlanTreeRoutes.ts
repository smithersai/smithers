import * as Cloudflare from "@alchemy.run/cloudflare"
import { McpAdapter, type Principal } from "@smthrs/app-core"
import { ShardProtocol } from "@smthrs/sync"
import { RuntimeContext } from "alchemy"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Reactivity from "effect/reactivity/Reactivity"
import { readBounded } from "../Body.ts"
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
      const body = yield* readBounded(request, 65_536)
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

/** The host opens a verifier scoped to each named repository shard. */
export const live = (
  credentialsFor: (shard: ShardProtocol.ShardId) => Effect.Effect<Principal.Credentials, never, RuntimeContext>
) => PlanTreeObject.make(Effect.gen(function*() {
  const state = yield* Cloudflare.DurableObjectState
  return Effect.gen(function*() {
    const shard = yield* Schema.decodeUnknownEffect(ShardProtocol.ShardId)(state.raw.id.name).pipe(Effect.orDie)
    const credentials = yield* credentialsFor(shard)
    const plan = yield* PlanTreeShard.make(state.raw.storage, shard, credentials)
      .pipe(Effect.provide(Reactivity.layer), Effect.orDie)
    return { fetch: handle(plan) }
  })
}))

/** Register the three routes with the host's authorized namespace dispatcher. */
export const register = <E, R>(
  dispatch: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) => [
  HttpRouter.route("POST", "/api/plan/mcp", dispatch),
  HttpRouter.route("GET", "/api/plan/pull", dispatch),
  HttpRouter.route("GET", "/api/plan/snapshot", dispatch)
]
