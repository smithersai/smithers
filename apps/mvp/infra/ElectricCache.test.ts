// Workers Cache keeps only the gateway responses Electric marks public, and never a refusal, a must-refetch, an
// overload or an error (infra/ElectricCache.ts).
import { Effect, Logger } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import { cacheControl, cachePolicy, enabledFor, LONG_POLL_TIMEOUT_MS, NO_STORE, serve } from "./ElectricCache.ts"

/** Electric 1.8.1's `cache-control` for each kind of answer (lib/electric/shapes/api/response.ex). */
const INITIAL = "public, max-age=604800, s-maxage=3600, stale-while-revalidate=2629746"
const LIVE = "public, max-age=5, stale-while-revalidate=5"
const MUST_REFETCH = "public, max-age=60, must-revalidate"

describe("cacheControl", () => {
  test("a 200 Electric marks public keeps Electric's own lifetime, initial and live alike", () => {
    expect(cacheControl(200, INITIAL)).toBe(INITIAL)
    expect(cacheControl(200, LIVE)).toBe(LIVE)
    expect(cacheControl(200, "Public,max-age=60")).toBe("Public,max-age=60")
  })

  test("every other status is no-store, a public 409 must-refetch included", () => {
    for (const status of [204, 400, 401, 403, 404, 409, 429, 500, 503]) {
      expect(cacheControl(status, MUST_REFETCH)).toBe(NO_STORE)
    }
  })

  test("a 200 without a public cache-control is no-store, never the cache's heuristic lifetime", () => {
    expect(cacheControl(200, undefined)).toBe(NO_STORE)
    expect(cacheControl(200, "no-store")).toBe(NO_STORE)
    expect(cacheControl(200, "private, max-age=60")).toBe(NO_STORE)
    expect(cacheControl(200, "max-age=60, publicity")).toBe(NO_STORE)
  })
})

describe("cachePolicy", () => {
  test("reads Electric's cache-control from the response's headers", () => {
    const headers = { "cache-control": LIVE, "electric-cursor": "7" }
    const answer = HttpServerResponse.text("[]", { status: 200, headers })
    expect(cachePolicy(answer).headers).toMatchObject({ "cache-control": LIVE, "electric-cursor": "7" })
    const refetch = HttpServerResponse.text("[]", { status: 409, headers: { "cache-control": MUST_REFETCH } })
    expect(cachePolicy(refetch).headers["cache-control"]).toBe(NO_STORE)
  })

  test("reads it from a raw web Response, whose body passes on untouched", async () => {
    const raw = new Response("[]", { status: 200, headers: { "cache-control": INITIAL } })
    const answer = cachePolicy(HttpServerResponse.raw(raw, { status: 200 }))
    expect(answer.headers["cache-control"]).toBe(INITIAL)
    const web = HttpServerResponse.toWeb(answer)
    expect(web.headers.get("cache-control")).toBe(INITIAL)
    expect(await web.text()).toBe("[]")
  })

  test("a raw web Response without one, or any other body, is no-store", () => {
    const bare = HttpServerResponse.raw(new Response("[]"), { status: 200 })
    expect(cachePolicy(bare).headers["cache-control"]).toBe(NO_STORE)
    expect(cachePolicy(HttpServerResponse.empty({ status: 200 })).headers["cache-control"]).toBe(NO_STORE)
  })
})


test("finite responses are enabled, but both SSE forms bypass the cache", () => {
  expect(enabledFor("/v1/shape?table=items")).toBe(true)
  expect(enabledFor("/v1/shape?table=messages&live=true")).toBe(true)
  expect(enabledFor("/v1/shape?live_sse=true")).toBe(false)
  expect(enabledFor("/v1/shape?experimental_live_sse=true")).toBe(false)
  expect(enabledFor("/v1/shape?live_sse=false")).toBe(true)
  const answer = HttpServerResponse.text("[]", { headers: { "cache-control": INITIAL } })
  expect(cachePolicy(answer, false).headers["cache-control"]).toBe(NO_STORE)
})

test("a contradictory public directive cannot override a refusal to cache", () => {
  for (const directive of ["private", 'private="authorization"', "no-store", "no-cache"]) {
    expect(cacheControl(200, `public, max-age=60, ${directive}`)).toBe(NO_STORE)
  }
})

test("an explicit response header takes precedence over a raw body's header", () => {
  const response = HttpServerResponse.raw(new Response("[]", { headers: { "cache-control": INITIAL } }), {
    status: 200, headers: { "cache-control": "private" },
  })
  expect(cachePolicy(response).headers["cache-control"]).toBe(NO_STORE)
  expect(cachePolicy(HttpServerResponse.raw("[]", { status: 200 })).headers["cache-control"]).toBe(NO_STORE)
})

test("the live hold is ten seconds while Electric's five-second TTL is preserved", () => {
  expect(LONG_POLL_TIMEOUT_MS).toBe(10_000)
  expect(cacheControl(200, LIVE)).toBe(LIVE)
})

test("the entrypoint refuses non-shapes before transport and keeps admitted bodies and headers", async () => {
  const calls: string[] = []
  const handler = HttpEffect.toWebHandler(serve((request) => Effect.sync(() => {
    calls.push(request.url)
    return HttpServerResponse.raw(new Response("[]", { headers: { "cache-control": LIVE, "electric-cursor": "next" } }), { status: 200 })
  })).pipe(Effect.provide(Logger.layer([]))))
  const refused = await handler(new Request("http://gateway/metrics"))
  expect(refused.status).toBe(404)
  expect(refused.headers.get("cache-control")).toBe(NO_STORE)
  await refused.text()
  expect(calls).toEqual([])
  for (const query of ["offset=-1", "offset=0_0&live=true", "live_sse=true"]) {
    const response = await handler(new Request(`http://gateway/v1/shape?${query}`))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe(query === "live_sse=true" ? NO_STORE : LIVE)
    expect(response.headers.get("electric-cursor")).toBe("next")
    expect(await response.text()).toBe("[]")
  }
  expect(calls).toHaveLength(3)
})

test("an injected overloaded transport produces a noncacheable retryable refusal", async () => {
  const handler = HttpEffect.toWebHandler(serve(() => Effect.fail({ overloaded: true })).pipe(Effect.provide(Logger.layer([]))))
  const response = await handler(new Request("http://gateway/v1/shape?live=true"))
  expect(response.status).toBe(503)
  expect(response.headers.get("retry-after")).toBe("5")
  expect(response.headers.get("cache-control")).toBe(NO_STORE)
  await response.text()
})
