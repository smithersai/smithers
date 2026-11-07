import { Effect, Fiber, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import * as Dns from "./Dns.ts"
import { ProviderUnavailable, type Provider } from "./Provider.vibe"

const run = <A, E>(fetch: typeof globalThis.fetch, use: (provider: Provider) => Effect.Effect<A, E>) =>
  Dns.make({ zone: "ZONE.TEST.", target: "TARGET.TEST.", dohUrl: "https://resolver.test/query" }).pipe(Effect.flatMap(use), Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch))

test("pointsAt accepts only the target as the CNAME: a shared address proves nothing", () => {
  const answer = (...records: Array<{ type?: number; data?: string }>) => ({ Answer: records })
  expect(Dns.pointsAt("target.test", answer({ type: 5, data: "TARGET.TEST." }))).toBe(true)
  expect(Dns.pointsAt("target.test.", answer({ type: 5, data: "target.test" }))).toBe(true)
  expect(Dns.pointsAt("target.test", answer({ type: 1, data: "192.0.2.1" }))).toBe(false)
  expect(Dns.pointsAt("target.test", answer({}, { type: 5 }, { type: 16, data: "target.test" }, { type: 5, data: "other.test" }))).toBe(false)
  expect(Dns.pointsAt("target.test", {})).toBe(false)
})

test.each([true, false])("resolver verifies=%s and exposes unmanaged routing", async verified => {
  const calls: Array<string> = []
  const zone = new Map(verified ? [["www.example.com CNAME", ["TARGET.TEST."]]] : [])
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    expect(url.origin + url.pathname).toBe("https://resolver.test/query")
    expect(request.headers.get("accept")).toBe("application/dns-json")
    const key = `${url.searchParams.get("name")} ${url.searchParams.get("type")}`
    calls.push(key)
    return Response.json({ Status: 0, Answer: (zone.get(key) ?? []).map(data => ({ type: 5, data })) })
  }
  await Effect.runPromise(run(fetch, p => Effect.gen(function* () {
    expect(p.zone).toBe("zone.test")
    expect(p.target).toBe("target.test")
    expect(p.name).toBe("dns")
    const registration = yield* p.ensure("www.example.com")
    expect(registration).toEqual({ id: "www.example.com", records: [{ type: "CNAME", name: "www.example.com", value: "target.test" }], verification: verified ? "active" : "pending", certificate: "unmanaged" })
    expect(yield* p.status("unused", "www.example.com")).toEqual(Option.some(registration))
    expect(yield* p.remove("unused")).toBeUndefined()
  })))
  expect(calls).toEqual(["www.example.com CNAME", "www.example.com CNAME"])
})

test.each(["doh_503", "unreachable", "malformed", "body_unreachable"])("resolver failure %s", async code => {
  const fetch: typeof globalThis.fetch = async () => {
    if (code === "unreachable") throw new Error("offline")
    if (code === "body_unreachable") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("broken body")) } }))
    return new Response(code === "malformed" ? "{" : "unavailable", { status: code === "doh_503" ? 503 : 200 })
  }
  expect(await Effect.runPromise(run(fetch, p => Effect.flip(p.ensure("example.com"))))).toEqual(new ProviderUnavailable({ code: code === "body_unreachable" ? "unreachable" : code }))
})

test("default resolver and timeout", async () => {
  const fetch: typeof globalThis.fetch = async input => {
    expect(String(input)).toContain(Dns.DOH_URL)
    return new Promise(() => {})
  }
  await Effect.runPromise(Effect.gen(function* () {
    const p = yield* Dns.make({ zone: "zone", target: "target" })
    const fiber = yield* Effect.forkChild(Effect.flip(p.ensure("example.com")))
    yield* TestClock.adjust("6 seconds")
    expect(yield* Fiber.join(fiber)).toEqual(new ProviderUnavailable({ code: "timeout" }))
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.provide(TestClock.layer())))
})
