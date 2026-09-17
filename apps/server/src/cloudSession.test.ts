import { expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { configLayer } from "./Config"
import { probeCloudSession } from "./cloudSession"
import { transportLayer } from "./Http"

const run = (options: { identity?: number; token?: boolean; scope?: number; message?: string; offline?: boolean; refusal?: string } = {}) => {
  const calls: Request[] = []
  const response = Effect.runPromise(probeCloudSession(new Request("https://web.test/api/cloud-auth/session", {
    headers: { cookie: "session=fixture" }
  })).pipe(Effect.provide(configLayer({
    IDENTITY_UPSTREAM_URL: "https://identity.test", IDENTITY_SERVICE_TOKEN: "service-fixture", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
  })), Effect.provide(transportLayer(async (input, init) => {
    const request = new Request(input, init)
    calls.push(request)
    const path = new URL(request.url).pathname
    if (path === "/api/identity/validate") return Response.json({ login: "ada", allowlisted: true, admin: false, scopes: ["read:user"] }, { status: options.identity ?? 200 })
    if (path === "/api/identity/cloud-token") {
      if (options.refusal !== undefined) return Response.json({ found: false, cloud: { status: "exchange_failed", reason: options.refusal } })
      return Response.json(options.token === false ? { found: false } : { found: true, token: "private-fixture-token" })
    }
    if (options.offline) throw new Error("offline")
    return Response.json({ message: options.message ?? "upstream refused" }, { status: options.scope ?? 200 })
  }))))
  return { response, calls }
}

test("the session exchange uses the validated login and never exposes its token", async () => {
  const { response, calls } = run()
  const answer = await response
  expect(answer.status).toBe(200)
  expect(answer.headers.get("cache-control")).toBe("no-store")
  expect(await answer.json()).toEqual({ state: "signed-in", username: "ada", expiresAt: null })
  expect(calls.map(request => new URL(request.url).pathname)).toEqual(["/api/identity/validate", "/api/identity/cloud-token", "/api/user/workspaces"])
  expect(calls[0]!.headers.get("cookie")).toBe("session=fixture")
  expect(await calls[1]!.json()).toEqual({ login: "ada" })
  expect(calls[1]!.headers.get("x-smithers-service-token")).toBe("service-fixture")
  expect(calls[2]!.headers.get("authorization")).toBe("Bearer private-fixture-token")
  expect(calls[2]!.headers.has("cookie")).toBe(false)
})

// A closed-alpha refusal is a fact about the account, not an outage: it must
// not be reported as Smithers Cloud being unreachable.
for (const refusal of ["access_not_granted", "NOT_ON_WAITLIST"]) {
  test(`a closed-alpha refusal refuses as the account, not as an outage: ${refusal}`, async () => {
    const { response, calls } = run({ refusal })
    const answer = await response
    expect(answer.status).toBe(403)
    expect(await answer.json()).toMatchObject({
      code: "account_not_allowlisted",
      message: "This account isn't off the closed-alpha waitlist yet."
    })
    expect(calls.map(request => new URL(request.url).pathname)).toEqual(["/api/identity/validate", "/api/identity/cloud-token"])
  })
}

test("signed-out identity never exchanges a token or calls Cloud", async () => {
  const { response, calls } = run({ identity: 401 })
  expect(await (await response).json()).toEqual({ state: "signed-out", username: null, expiresAt: null })
  expect(calls).toHaveLength(1)
})

test("Cloud scope failure is a signed-in degraded session, independent of GitHub scopes", async () => {
  const { response } = run({ scope: 403, message: "Insufficient scope: read:workspace" })
  expect(await (await response).json()).toEqual({ state: "signed-in", username: "ada", expiresAt: null, scopes: "degraded" })
})

for (const options of [{ identity: 500 }, { token: false }, { scope: 401 }, { scope: 403 }, { scope: 503 }, { offline: true }]) {
  test(`unavailable identity/token/scope is never reported as signed out or full scope: ${JSON.stringify(options)}`, async () => {
    const response = await run(options).response
    expect(response.status).toBeGreaterThanOrEqual(500)
    const body = await response.text()
    expect(body).not.toContain("signed-out")
    expect(body).not.toContain("private-fixture-token")
  })
}
