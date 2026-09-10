import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { testConfigLayer } from "./Config"
import type { ServerConfigShape } from "./Config"
import { transportLayer } from "./Http"
import { handleAuthNavigation, probeAuthSession, proxyToIdentity, requireTurnSession, validateSession, validReturnTo } from "./identity"

/*
 * The identity seam as Effects over injected layers: the transport is a
 * function, the configuration a record, and no global is patched. The router
 * tests hold the same behaviours at the HTTP surface; these hold the
 * validation outcomes the router branches on.
 */

const IDENTITY = "https://identity.test"

interface Seen {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: string
}

const wire = (answer: (request: Request) => Response | Promise<Response>) => {
  const seen: Array<Seen> = []
  const layer = transportLayer(async (input, init) => {
    const request = new Request(input, init)
    seen.push({ url: request.url, method: request.method, headers: request.headers, body: await request.clone().text() })
    return answer(request)
  })
  return { seen, layer }
}

const config = (overrides: Partial<ServerConfigShape> = {}) =>
  testConfigLayer({ identityUpstreamUrl: IDENTITY, identityServiceToken: Redacted.make("service-token"), ...overrides })

const run = <A>(effect: Effect.Effect<A, never, any>, ...layers: ReadonlyArray<Layer.Layer<any>>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(...(layers as [Layer.Layer<any>])))))

const session = (cookie?: string): Request =>
  new Request("https://mvp.test/api/agent/turn", { method: "POST", headers: cookie === undefined ? {} : { cookie } })

const jsonAnswer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("validateSession", () => {
  test("posts the cookie and the service token to /api/identity/validate and reads the identity back", async () => {
    const { seen, layer } = wire(() => jsonAnswer(200, { login: "will", allowlisted: true, admin: true, scopes: ["a", 7] }))
    const outcome = await run(validateSession(session("smithers_session=abc")), layer, config())
    expect(outcome).toEqual({
      status: "valid",
      identity: { login: "will", allowlisted: true, admin: true, scopes: ["a"] }
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ url: `${IDENTITY}/api/identity/validate`, method: "POST", body: "{}" })
    expect(seen[0]!.headers.get("cookie")).toBe("smithers_session=abc")
    expect(seen[0]!.headers.get("x-smithers-service-token")).toBe("service-token")
  })

  test("a 401 is invalid; any other refusal is the seam being unavailable, with its status named", async () => {
    const refused = await run(validateSession(session("smithers_session=abc")), wire(() => new Response("{}", { status: 401 })).layer, config())
    expect(refused).toEqual({ status: "invalid" })
    const broken = await run(validateSession(session("smithers_session=abc")), wire(() => new Response("{}", { status: 500 })).layer, config())
    expect(broken.status).toBe("unavailable")
    if (broken.status === "unavailable") {
      expect(broken.response.status).toBe(502)
      expect(await broken.response.json()).toEqual({ status: "error", message: "The identity service answered HTTP 500." })
    }
  })

  test("a loginless answer is signed-out for a cookieless request and malformed for one that sent a cookie", async () => {
    const answer = () => jsonAnswer(200, { state: "signed-out", login: null })
    expect(await run(validateSession(session()), wire(answer).layer, config())).toEqual({ status: "invalid" })
    const withCookie = await run(validateSession(session("smithers_session=abc")), wire(answer).layer, config())
    expect(withCookie.status).toBe("unavailable")
    if (withCookie.status === "unavailable") {
      expect(await withCookie.response.json()).toEqual({
        status: "error",
        message: "The identity service returned a malformed session response."
      })
    }
  })

  test("an unreachable seam is a 502 and a deadline a 504 naming its milliseconds, never a false sign-in", async () => {
    const down = await run(
      validateSession(session()),
      wire(() => Promise.reject(new Error("connection reset"))).layer,
      config()
    )
    expect(down.status).toBe("unavailable")
    if (down.status === "unavailable") {
      expect(down.response.status).toBe(502)
      expect(await down.response.json()).toEqual({ status: "error", message: "The identity service is unreachable." })
    }
    const stalled = wire((request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
      })
    )
    const slow = await run(validateSession(session()), stalled.layer, config({ upstreamTimeoutMs: 20 }))
    expect(slow.status).toBe("unavailable")
    if (slow.status === "unavailable") {
      expect(slow.response.status).toBe(504)
      expect(await slow.response.json()).toEqual({ status: "error", message: "The identity service did not answer within 20ms." })
    }
  })

  test("with no identity seam every session is invalid and nothing is fetched", async () => {
    const { seen, layer } = wire(() => jsonAnswer(200, { login: "will" }))
    expect(await run(validateSession(session("smithers_session=abc")), layer, testConfigLayer())).toEqual({ status: "invalid" })
    expect(seen).toEqual([])
  })
})

describe("requireTurnSession", () => {
  test("stays out of the way without a seam, refuses 401 signed out and 403 off the allowlist, and admits a member", async () => {
    expect(await run(requireTurnSession(session()), wire(() => jsonAnswer(200, {})).layer, testConfigLayer())).toBeUndefined()
    const signedOut = await run(requireTurnSession(session()), wire(() => new Response("{}", { status: 401 })).layer, config())
    expect(signedOut).toBeInstanceOf(Response)
    expect((signedOut as Response).status).toBe(401)
    expect(await (signedOut as Response).json()).toEqual({ status: "error", message: "Sign in to run a Smithers turn." })
    const stranger = await run(
      requireTurnSession(session("smithers_session=abc")),
      wire(() => jsonAnswer(200, { login: "stranger", allowlisted: false })).layer,
      config()
    )
    expect((stranger as Response).status).toBe(403)
    const member = await run(
      requireTurnSession(session("smithers_session=abc")),
      wire(() => jsonAnswer(200, { login: "will", allowlisted: true })).layer,
      config()
    )
    expect(member).toEqual({ login: "will", allowlisted: true, admin: false, scopes: [] })
  })
})

describe("proxyToIdentity", () => {
  test("forwards the path and query, strips client identity claims, keeps the cookie, and states its own origin", async () => {
    const { seen, layer } = wire(() => jsonAnswer(200, { ok: true }))
    const response = await run(
      proxyToIdentity(
        new Request("https://mvp.test/api/auth/session?probe=1", {
          headers: {
            cookie: "smithers_session=abc",
            "x-user-id": "evil",
            "x-smithers-admin-token": "forged",
            authorization: "Bearer forged"
          }
        })
      ),
      layer,
      config()
    )
    expect(response.status).toBe(200)
    expect(seen[0]!.url).toBe(`${IDENTITY}/api/auth/session?probe=1`)
    expect(seen[0]!.headers.get("cookie")).toBe("smithers_session=abc")
    expect(seen[0]!.headers.get("x-user-id")).toBeNull()
    expect(seen[0]!.headers.get("x-smithers-admin-token")).toBeNull()
    expect(seen[0]!.headers.get("authorization")).toBeNull()
    expect(seen[0]!.headers.get("origin")).toBe("https://mvp.test")
  })

  test("the sibling's admin surface is the canonical 404 and never forwarded; no seam is a 501", async () => {
    const { seen, layer } = wire(() => jsonAnswer(200, { ok: true }))
    const hidden = await run(proxyToIdentity(new Request("https://mvp.test/api/identity/admin/allowlist")), layer, config())
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toEqual({ status: "error", message: "Not found." })
    expect(seen).toEqual([])
    const unset = await run(proxyToIdentity(new Request("https://mvp.test/api/auth/session")), layer, testConfigLayer())
    expect(unset.status).toBe(501)
    expect(((await unset.json()) as { message: string }).message).toContain("IDENTITY_UPSTREAM_URL")
  })

  test("an unreachable seam is a 502 envelope and a deadline a 504, never a thrown error", async () => {
    const down = await run(
      proxyToIdentity(new Request("https://mvp.test/api/auth/session")),
      wire(() => Promise.reject(new Error("connection refused"))).layer,
      config()
    )
    expect(down.status).toBe(502)
    expect(((await down.json()) as { message: string }).message).toContain("The identity service is unreachable right now")
    const slow = await run(
      proxyToIdentity(new Request("https://mvp.test/api/auth/session")),
      wire((request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
        })
      ).layer,
      config({ upstreamTimeoutMs: 20 })
    )
    expect(slow.status).toBe(504)
    expect(await slow.json()).toEqual({ status: "error", message: "The identity service did not answer within 20ms. Try again in a moment." })
  })
})

describe("probeAuthSession and the OAuth navigations", () => {
  test("the signed-out 401 is restated as a resolved 200; every other answer passes through", async () => {
    const probe = new Request("https://mvp.test/api/auth/session")
    const signedOut = await run(probeAuthSession(probe), wire(() => new Response("{}", { status: 401 })).layer, config())
    expect(signedOut.status).toBe(200)
    expect(await signedOut.json()).toEqual({ status: "signed-out" })
    const forbidden = await run(probeAuthSession(probe), wire(() => jsonAnswer(403, { error: "Forbidden origin" })).layer, config())
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ error: "Forbidden origin" })
  })

  test("the start leg keeps the validated return path in a cookie and the callback spends it", async () => {
    const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } })
    const started = await run(
      handleAuthNavigation(new Request("https://mvp.test/api/auth/github/start?return_to=%2Fsmithersai%2Fsmithers", { headers: { accept: "text/html" } }), "start"),
      wire(redirect("https://github.com/login/oauth/authorize?state=s")).layer,
      config()
    )
    expect(started.status).toBe(302)
    expect(started.headers.getSetCookie()).toEqual([
      "smithers_return_to=%2Fsmithersai%2Fsmithers; Path=/api/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax"
    ])
    const returned = await run(
      handleAuthNavigation(
        new Request("https://mvp.test/api/auth/github/callback?code=x&state=s", {
          headers: { accept: "text/html", cookie: "smithers_return_to=%2Fsmithersai%2Fsmithers" }
        }),
        "callback"
      ),
      wire(redirect("/?signed-in=github")).layer,
      config()
    )
    expect(returned.status).toBe(302)
    expect(returned.headers.get("location")).toBe("/smithersai/smithers?signed-in=github")
    expect(returned.headers.getSetCookie()[0]).toContain("Max-Age=0")
  })

  test("an unreachable seam on a browser navigation is the branded 502 page; a machine caller gets JSON", async () => {
    const down = wire(() => Promise.reject(new Error("connection refused")))
    const page = await run(
      handleAuthNavigation(new Request("https://mvp.test/api/auth/github/start", { headers: { accept: "text/html" } }), "start"),
      down.layer,
      config()
    )
    expect(page.status).toBe(502)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(await page.text()).toContain("GitHub sign-in can't start right now.")
    const machine = await run(
      handleAuthNavigation(new Request("https://mvp.test/api/auth/github/start", { headers: { accept: "application/json" } }), "start"),
      down.layer,
      config()
    )
    expect(machine.status).toBe(502)
    // The proxy's own envelope, untouched: no second prefix.
    expect(await machine.json()).toEqual({ status: "error", message: "The identity service is unreachable right now: connection refused" })
  })

  test("an identity deadline on a navigation is the 504 page for a browser and the proxy's 504 envelope, verbatim, for a machine", async () => {
    const stalled = wire((request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
      })
    )
    const page = await run(
      handleAuthNavigation(new Request("https://mvp.test/api/auth/github/callback?code=x&state=y", { headers: { accept: "text/html" } }), "callback"),
      stalled.layer,
      config({ upstreamTimeoutMs: 20 })
    )
    expect(page.status).toBe(504)
    expect(page.headers.get("content-type")).toContain("text/html")
    const html = await page.text()
    expect(html).toContain("GitHub sign-in didn't finish.")
    expect(html).toContain("HTTP 504")
    const machine = await run(
      handleAuthNavigation(new Request("https://mvp.test/api/auth/github/start", { headers: { accept: "application/json" } }), "start"),
      stalled.layer,
      config({ upstreamTimeoutMs: 20 })
    )
    expect(machine.status).toBe(504)
    expect(await machine.json()).toEqual({ status: "error", message: "The identity service did not answer within 20ms. Try again in a moment." })
  })

  test("validReturnTo admits only a same-origin page path", () => {
    expect(validReturnTo("/smithersai/smithers?tab=issues")).toBe("/smithersai/smithers?tab=issues")
    for (const bad of ["https://evil.example/", "//evil.example/", "/\\evil", "/api/auth/github/start", "/", "", "relative", `/${"a".repeat(512)}`]) {
      expect(validReturnTo(bad)).toBeUndefined()
    }
  })
})
