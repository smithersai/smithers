// How ChatApi calls Electric's gateway (infra/ElectricUpstream.ts): a shape route's request to Electric goes through
// the gateway's service binding when the Worker has one, and through the global fetch to `ELECTRIC_URL` when it
// doesn't (`alchemy dev`). The binding here is a recording `fetch`, the shape Cloudflare gives a service binding.
import { ShapeProxy } from "@smthrs/effect-electric"
import { Effect, Logger, Option } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { describe, expect, test } from "vitest"
import { GATEWAY_BINDING, GATEWAY_URL, upstream } from "./ElectricUpstream.ts"

/** A service binding's `fetch` that records each URL it was asked for and answers an empty shape log. */
const binding = () => {
  const urls: Array<string> = []
  return {
    urls,
    fetch: async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input))
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    },
  }
}

/** A shape route as ChatApi serves it, with `env` as the Worker's bindings and `global` as the global fetch. */
const route = (env: Record<string, unknown>, global: typeof globalThis.fetch) =>
  HttpEffect.toWebHandler(
    ShapeProxy.make({ url: GATEWAY_URL, shape: { table: "items" } }).pipe(
      Effect.provide(upstream(env)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, global),
      Effect.provide(Logger.layer([])),
    ),
  )

describe("upstream", () => {
  test("with the gateway's binding, Electric is called through it and never through the global fetch", async () => {
    const gateway = binding()
    const global = binding()
    const response = await route({ [GATEWAY_BINDING]: gateway }, global.fetch)(
      new Request("http://app.test/api/shapes/items?offset=-1&handle=h-1"),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("[]")
    expect(gateway.urls).toEqual([`${GATEWAY_URL}/v1/shape?handle=h-1&offset=-1&table=items`])
    expect(global.urls).toEqual([])
  })

  test("without it, or with a binding that isn't a service, nothing is provided and the global fetch calls Electric", async () => {
    for (const env of [{}, { [GATEWAY_BINDING]: "http://elsewhere" }, { [GATEWAY_BINDING]: null }]) {
      const global = binding()
      const response = await route(env, global.fetch)(new Request("http://app.test/api/shapes/items?offset=-1"))
      expect(response.status).toBe(200)
      await response.arrayBuffer()
      expect(global.urls).toEqual([`${GATEWAY_URL}/v1/shape?offset=-1&table=items`])
      const provided = await Effect.runPromise(
        Effect.serviceOption(ShapeProxy.Upstream).pipe(Effect.provide(upstream(env))),
      )
      expect(Option.isNone(provided)).toBe(true)
    }
  })
})
