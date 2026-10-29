// How ChatApi calls Electric's gateway (infra/ElectricUpstream.ts): a shape route's request to Electric goes through
// the gateway's service binding when the Worker has one, and through the global fetch to `ELECTRIC_URL` when it
// doesn't (`alchemy dev`). The binding here is a recording `fetch`, the shape Cloudflare gives a service binding.
import { ShapeProxy } from "@smthrs/effect-electric"
import { Arbitrary, Effect, Logger, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { describe, expect, test } from "vitest"
import { GATEWAY_BINDING, GATEWAY_URL, upstream } from "./ElectricUpstream.ts"
import { serve } from "./ElectricCache.ts"

/** A service binding's `fetch` that records each URL it was asked for and answers an empty shape log. */
const binding = () => {
  const urls: Array<string> = []
  const headers: Array<Headers> = []
  return {
    urls,
    headers,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      headers.push(new Headers(init?.headers))
      urls.push(input instanceof Request ? input.url : String(input))
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    },
  }
}

/** A shape route as ChatApi serves it, with `env` as the Worker's bindings and `global` as the global fetch. */
const route = (env: Record<string, unknown>, global: typeof globalThis.fetch, options: Partial<ShapeProxy.Connection> = {}) =>
  HttpEffect.toWebHandler(
    ShapeProxy.make({ url: GATEWAY_URL, shape: { table: "items" }, ...options }).pipe(
      Effect.provide(upstream(env)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, global),
      Effect.provide(Logger.layer([])),
    ),
  )

describe("upstream", () => {
  test("an overloaded gateway's record joins the SDK's 503 response through the private binding", async () => {
    const log: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const logger = Logger.make((options) => void log.push(Logger.formatStructured.log(options)))
    const gateway = HttpEffect.toWebHandler(serve(() => Effect.fail({ overloaded: true })).pipe(
      Effect.provide(Logger.layer([logger])),
    ))
    const global = binding()
    const response = await route({ [GATEWAY_BINDING]: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => gateway(new Request(input, init)),
    } }, global.fetch)(new Request("http://app.test/api/shapes/items?offset=-1", {
      headers: { "x-request-id": "browser-private-value" },
    }))
    expect(response.status).toBe(503)
    await response.arrayBuffer()
    const correlationId = response.headers.get("x-request-id")
    expect(correlationId).toMatch(/^[a-f0-9]{16}$/)
    expect(log).toMatchObject([{
      message: "electric.gateway.request",
      annotations: { correlationId, status: 503, outcome: "overloaded" },
    }])
    expect(JSON.stringify(log)).not.toContain("browser-private-value")
    expect(global.urls).toEqual([])
  })

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


test("a private service binding never receives legacy Electric credentials in the URL or headers", async () => {
  for (const secretAs of ["parameter", "bearer"] as const) {
    const gateway = binding()
    const global = binding()
    const response = await route({ [GATEWAY_BINDING]: gateway }, global.fetch, {
      secret: Redacted.make("synthetic-regression-credential"), secretAs,
    })(new Request("http://app.test/api/shapes/items?offset=-1"))
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    expect(gateway.urls).toEqual([`${GATEWAY_URL}/v1/shape?offset=-1&table=items`])
    expect(gateway.headers[0]!.has("authorization")).toBe(false)
    expect(gateway.headers[0]!.has("cookie")).toBe(false)
    expect(global.urls).toEqual([])
  }
})


test("binding sanitization removes cookies and credentials while preserving noncredential headers", async () => {
  const gateway = binding()
  await Effect.runPromise(Effect.gen(function* () {
    const client = Option.getOrThrow(yield* Effect.serviceOption(ShapeProxy.Upstream))
    const response = yield* client.get(`${GATEWAY_URL}/v1/shape?secret=synthetic&table=items`, {
      headers: { authorization: "Bearer synthetic", cookie: "session=synthetic", "x-test": "kept" },
    })
    yield* response.text
  }).pipe(Effect.provide(upstream({ [GATEWAY_BINDING]: gateway })), Effect.provide(Logger.layer([]))))
  expect(gateway.urls).toEqual([`${GATEWAY_URL}/v1/shape?table=items`])
  expect(gateway.headers[0]!.has("authorization")).toBe(false)
  expect(gateway.headers[0]!.has("cookie")).toBe(false)
  expect(gateway.headers[0]!.get("x-test")).toBe("kept")
})

test("without a private binding the configured upstream still receives its Electric credential", async () => {
  const global = binding()
  const response = await route({}, global.fetch, {
    secret: Redacted.make("synthetic-regression-credential"), secretAs: "bearer",
  })(new Request("http://app.test/api/shapes/items?offset=-1"))
  await response.arrayBuffer()
  expect(global.headers[0]!.get("authorization")).toBe("Bearer synthetic-regression-credential")
})

/** The exact URL the private binding receives, after the SDK fixes the shape and strips browser input. */
const keyFor = async (shape: ShapeProxy.Shape, query: string) => {
  const gateway = binding()
  const handler = HttpEffect.toWebHandler(ShapeProxy.make({ url: GATEWAY_URL, shape }).pipe(
    Effect.provide(upstream({ [GATEWAY_BINDING]: gateway })),
    Effect.provide(FetchHttpClient.layer), Effect.provide(Logger.layer([])),
  ))
  const response = await handler(new Request(`http://app.test/api/shapes/personal?${query}`))
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  await response.arrayBuffer()
  return gateway.urls[0]!
}

test("canonical keys retain every protocol discriminator and use the first duplicate value", async () => {
  const shape = { table: "messages", where: "person = $1", params: { "1": "a +&%/雪" } }
  const params = new URLSearchParams({ handle: "h +/", offset: "1_0", cursor: "c&1", expired_handle: "old", "cache-buster": "fresh", live: "true" })
  const key = await keyFor(shape, params.toString())
  const reversed = new URLSearchParams([...params].reverse())
  reversed.append("offset", "ignored")
  expect(await keyFor(shape, reversed.toString())).toBe(key)
  expect(await keyFor(shape, params.toString().replaceAll("+", "%20"))).toBe(key)
  expect(new URL(key).searchParams.get("params[1]")).toBe(shape.params["1"])
  for (const name of params.keys()) {
    const changed = new URLSearchParams(params)
    changed.set(name, `${params.get(name)}-different`)
    expect(await keyFor(shape, changed.toString())).not.toBe(key)
  }
  expect(await keyFor(shape, `${params}&table=other&where=public&params%5B1%5D=other`)).toBe(key)
})

test("property: different person-scoped definitions never share a private cache key", async () => {
  const result = await Effect.runPromise(Arbitrary.checkEffect(
    Arbitrary.schema(Schema.Struct({ person: Schema.String.check(Schema.isUUID()), other: Schema.String.check(Schema.isUUID()), cursor: Schema.String })),
    ({ person, other, cursor }) => Effect.promise(async () => {
      if (person === other) return true
      const first = { table: "runs", where: "person_id = $1", params: { "1": person } }
      const second = { ...first, params: { "1": other } }
      const query = new URLSearchParams({ offset: "-1", cursor }).toString()
      const a = await keyFor(first, query)
      const b = await keyFor(second, query)
      return a !== b && new URL(a).searchParams.get("params[1]") === person &&
        new URL(b).searchParams.get("params[1]") === second.params["1"]
    }),
    { seed: "electric-person-scope", runs: 200 },
  ))
  expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
})
