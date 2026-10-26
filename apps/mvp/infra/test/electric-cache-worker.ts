// A real service-binding hop through the production admission/cache policy, with the farm Electric as the container
// transport. Workerd cannot emulate the edge cache; these checks deliberately make no collapse-ratio assertion.
import { ShapeProxy } from "@smthrs/effect-electric"
import { Effect } from "effect"
import { FetchHttpClient, HttpEffect, HttpServerResponse } from "effect/http"
import { serve } from "../ElectricCache.ts"
import { GATEWAY_URL, upstream } from "../ElectricUpstream.ts"

interface Env {
  readonly ROLE: string
  readonly TABLE: string
  readonly ELECTRIC_URL: string
  readonly ELECTRIC_GATEWAY: { readonly fetch: typeof fetch }
}

let arrivals = 0

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.ROLE === "gateway") {
      if (new URL(request.url).pathname === "/arrivals") return Response.json(arrivals)
      return HttpEffect.toWebHandler(serve((admitted) => Effect.tryPromise(async () => {
        arrivals++
        const url = new URL(admitted.originalUrl)
        const target = new URL(env.ELECTRIC_URL)
        url.host = target.host
        url.protocol = target.protocol
        const response = await fetch(url, { signal: request.signal })
        return HttpServerResponse.raw(response, { status: response.status })
      })))(request)
    }
    // Two fixed definitions, selected by the test route; no browser parameter can change their scope.
    const person = new URL(request.url).pathname === "/alice" ? "alice" : "bob"
    return HttpEffect.toWebHandler(ShapeProxy.make({
      url: GATEWAY_URL, shape: { table: env.TABLE, where: "person = $1", params: { "1": person } },
    }).pipe(Effect.provide(upstream({ ELECTRIC_GATEWAY: env.ELECTRIC_GATEWAY })), Effect.provide(FetchHttpClient.layer)))(request)
  },
}
