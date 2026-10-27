// A real service-binding hop through the production admission/cache policy, with the farm Electric as the container
// transport. Workerd cannot emulate the edge cache; these checks deliberately make no collapse-ratio assertion.
import { DurableObject } from "cloudflare:workers"
import { ShapeProxy } from "@smthrs/effect-electric"
import { Effect } from "effect"
import { FetchHttpClient, HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"
import { serve } from "../ElectricCache.ts"
import { GATEWAY_URL, upstream } from "../ElectricUpstream.ts"

interface Env {
  readonly ROLE: string
  readonly TABLE: string
  readonly ELECTRIC_URL: string
  readonly ELECTRIC_OBJECT: { readonly getByName: (name: string) => { readonly fetch: (request: Request) => Promise<Response> } }
  readonly ELECTRIC_GATEWAY: { readonly fetch: typeof fetch }
}

let arrivals = 0

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.ROLE === "gateway") {
      if (new URL(request.url).pathname === "/arrivals") return Response.json(arrivals)
      return HttpEffect.toWebHandler(serve((admitted) => Effect.gen(function* () {
        arrivals++
        const web = yield* HttpServerRequest.toWeb(admitted)
        const response = yield* Effect.tryPromise(() => env.ELECTRIC_OBJECT.getByName("electric").fetch(web))
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

// Real cross-script Durable Object with the test host's real Electric transport. The production host starts a
// Cloudflare container; workerd cannot run that image, so this host uses the farm Electric service instead.
export class ElectricObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const target = new URL(this.env.ELECTRIC_URL)
    url.host = target.host
    url.protocol = target.protocol
    return fetch(url, { signal: request.signal })
  }
}
