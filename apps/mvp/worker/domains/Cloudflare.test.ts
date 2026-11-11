import { Effect, Fiber, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import * as Cf from "./Cloudflare.ts"
import { HostnameRejected, HostnameTaken, ProviderUnavailable, type Provider } from "./Provider.vibe"

const token = "private-test-token"
const custom = (extra: Partial<Cf.CustomHostname> = {}): Cf.CustomHostname => ({ id: "id/1", hostname: "www.example.com", ...extra })
const run = <A, E>(fetch: typeof globalThis.fetch, use: (p: Provider) => Effect.Effect<A, E>) => Cf.make({ zoneId: "zone/id", zone: "zone.test", target: "target.test", token: Redacted.make(token) }).pipe(Effect.flatMap(use), Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch))

// A stateful custom-hostnames server; errors can happen before or after a committed POST.
const network = (options: { post?: number; message?: string; lost?: boolean; get?: number; raw?: string } = {}) => {
  const rows = new Map<string, Cf.CustomHostname>()
  const calls: Array<Request> = []
  const bodies: Array<unknown> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    calls.push(request)
    expect(request.headers.get("authorization")).toBe(`Bearer ${token}`)
    const url = new URL(request.url)
    expect(url.pathname).toContain("/zones/zone%2Fid/custom_hostnames")
    if (request.method === "POST") {
      const body = await request.json() as { hostname: string }
      bodies.push(body)
      const row = custom({ hostname: body.hostname })
      if (options.post === undefined || options.post === 200 || options.post === 201 || options.lost) rows.set(row.hostname, row)
      return Response.json(options.post && options.post >= 400 ? { errors: options.message === undefined ? [] : [{ message: options.message }] } : { result: row }, { status: options.post ?? 201 })
    }
    if (options.get !== undefined) return new Response(options.raw ?? "{}", { status: options.get })
    if (url.searchParams.has("hostname")) return Response.json({ result: [...rows.values()].filter(row => row.hostname === url.searchParams.get("hostname")) })
    const row = [...rows.values()].find(row => row.id === decodeURIComponent(url.pathname.split("/").at(-1)!))
    if (request.method === "DELETE" && row) rows.delete(row.hostname)
    return Response.json({ result: row }, { status: row ? 200 : 404 })
  }
  return { rows, calls, bodies, fetch }
}

test("hostname and certificate status groups", () => {
  for (const status of ["active", "active_redeploying", "provisioned", "test_active", "test_active_apex"]) expect(Cf.verificationOf(status)).toBe("active")
  for (const status of ["blocked", "pending_blocked", "moved", "deleted", "pending_deletion", "test_blocked", "test_failed"]) expect(Cf.verificationOf(status)).toBe("failed")
  for (const status of [undefined, "pending", "future"]) expect(Cf.verificationOf(status)).toBe("pending")
  expect(Cf.certificateOf("active")).toBe("active")
  for (const status of ["expired", "deleted", "inactive", "deactivating", "initializing_timed_out", "validation_timed_out", "issuance_timed_out", "deployment_timed_out", "deletion_timed_out"]) expect(Cf.certificateOf(status)).toBe("failed")
  for (const status of [undefined, "pending", "future"]) expect(Cf.certificateOf(status)).toBe("pending")
})

test("registration orders routing, ownership and complete certificate records", () => {
  const row = custom({ ownership_verification: { type: "txt", name: "ownership", value: "proof" }, ssl: { validation_records: [{}, { txt_name: "missing" }, { txt_value: "missing" }, { txt_name: "ssl", txt_value: "challenge" }] } })
  expect(Cf.registrationOf(row, "target")).toEqual({ id: "id/1", verification: "pending", certificate: "pending", records: [{ type: "CNAME", name: row.hostname, value: "target" }, { type: "TXT", name: "ownership", value: "proof" }, { type: "TXT", name: "ssl", value: "challenge" }] })
  expect(Cf.registrationOf({ ...row, hostname: "example.com", status: "active", ssl: { ...row.ssl, status: "active" } }, "target").records).toEqual([{ type: "ALIAS", name: "example.com", value: "target" }])
  for (const ownership_verification of [undefined, {}, { name: "name" }, { value: "value" }]) expect(Cf.registrationOf(custom({ ownership_verification }), "target").records).toHaveLength(1)
  expect(Cf.registrationOf(custom({ ssl: {} }), "target").records).toHaveLength(1)
})

test("registration reports the first problem, bounded and absent when active", () => {
  for (const status of ["blocked", "pending_blocked", "moved"]) expect(Cf.registrationOf(custom({ status, verification_errors: ["other"] }), "t").problem).toBe(status === "moved" ? "moved" : "blocked")
  expect(Cf.registrationOf(custom({ verification_errors: ["first", "second"], ssl: { validation_errors: [{ message: "ssl" }] } }), "t").problem).toBe("first")
  expect(Cf.registrationOf(custom({ verification_errors: [], ssl: { validation_errors: [{}, { message: "" }, { message: "ssl" }] } }), "t").problem).toBe("ssl")
  expect(Cf.registrationOf(custom({ ssl: { validation_errors: [] } }), "t")).not.toHaveProperty("problem")
  expect(Cf.registrationOf(custom({ status: "active", ssl: { status: "pending", validation_errors: [{ message: "waiting" }] } }), "t").problem).toBe("waiting")
  expect(Cf.registrationOf(custom({ status: "active", ssl: { status: "active" }, verification_errors: ["old"] }), "t")).not.toHaveProperty("problem")
  expect(Cf.registrationOf(custom({ verification_errors: ["x".repeat(201)] }), "t").problem).toBe("x".repeat(Cf.MAX_PROBLEM_LENGTH))
})

test.each([200, 201])("create %s, find existing, status and idempotent delete", async post => {
  const n = network({ post })
  n.rows.set("other.example.com", custom({ hostname: "other.example.com", id: "other" }))
  await Effect.runPromise(run(n.fetch, p => Effect.gen(function* () {
    expect([p.name, p.zone, p.target]).toEqual(["cloudflare", "zone.test", "target.test"])
    const registration = yield* p.ensure("www.example.com")
    expect(yield* p.ensure("www.example.com")).toEqual(registration)
    expect(yield* p.status(registration.id, "www.example.com")).toEqual(Option.some(registration))
    yield* p.remove(registration.id)
    expect(yield* p.status(registration.id, "www.example.com")).toEqual(Option.none())
    yield* p.remove(registration.id)
  })))
  expect(n.bodies).toEqual([{ hostname: "www.example.com", ssl: { method: "http", type: "dv" } }])
  expect(n.rows.size).toBe(1)
})

test("finds a committed create whose response was lost", async () => {
  const n = network({ post: 400, lost: true })
  const registration = await Effect.runPromise(run(n.fetch, p => p.ensure("www.example.com")))
  expect(registration.id).toBe("id/1")
  expect(n.calls.map(r => r.method)).toEqual(["GET", "POST", "GET"])
})

test.each([[409, undefined], [400, "already exists"], [422, "duplicate hostname"], [403, "forbidden"], [400, undefined], [400, "x".repeat(201)], [429, undefined], [500, undefined], [503, undefined]] as const)("create failure %s %s", async (post, message) => {
  const n = network({ post, ...(message === undefined ? {} : { message }) })
  const failure = await Effect.runPromise(run(n.fetch, p => Effect.flip(p.ensure("www.example.com"))))
  expect(failure).toEqual(post >= 500 || post === 429 ? new ProviderUnavailable({ code: `http_${post}` }) : post === 409 || /already|duplicate/.test(message ?? "") ? new HostnameTaken() : new HostnameRejected({ reason: (message ?? `http_${post}`).slice(0, 200) }))
  expect(JSON.stringify(failure)).not.toContain(token)
})

test.each(["{}", "null", "42", "{"])("invalid list envelope %s", async raw => {
  expect(await Effect.runPromise(run(network({ get: 200, raw }).fetch, p => Effect.flip(p.ensure("www.example.com"))))).toEqual(new ProviderUnavailable({ code: "http_200" }))
})

test("list, status and remove server failures", async () => {
  for (const op of ["ensure", "status", "remove"] as const) {
    const failure = await Effect.runPromise(run(network({ get: 500 }).fetch, p => Effect.flip((op === "ensure" ? Effect.asVoid(p.ensure("www.example.com")) : op === "status" ? Effect.asVoid(p.status("id", "www.example.com")) : p.remove("id")))))
    expect(failure).toEqual(new ProviderUnavailable({ code: "http_500" }))
    expect(JSON.stringify(failure)).not.toContain(token)
  }
})

test("transport and body failures hide the token", async () => {
  for (const body of [false, true]) {
    const fetch: typeof globalThis.fetch = async () => {
      if (!body) throw new Error(token)
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(token)) } }))
    }
    const failure = await Effect.runPromise(run(fetch, p => Effect.flip(p.ensure("www.example.com"))))
    expect(failure).toEqual(new ProviderUnavailable({ code: "unreachable" }))
    expect(JSON.stringify(failure)).not.toContain(token)
  }
})

test("timeout and custom API origin", async () => {
  const fetch: typeof globalThis.fetch = async input => { expect(String(input)).toContain("https://custom.test/"); return new Promise(() => {}) }
  await Effect.runPromise(Effect.gen(function* () {
    const p = yield* Cf.make({ zoneId: "z", zone: "zone", target: "target", token: Redacted.make(token), apiUrl: "https://custom.test" })
    const fiber = yield* Effect.forkChild(Effect.flip(p.ensure("www.example.com")))
    yield* TestClock.adjust("11 seconds")
    const failure = yield* Fiber.join(fiber)
    expect(failure).toEqual(new ProviderUnavailable({ code: "timeout" }))
    expect(JSON.stringify(failure)).not.toContain(token)
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.provide(TestClock.layer())))
})
