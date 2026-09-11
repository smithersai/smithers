import { afterEach, describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { CLOUD_AUTH_BODY_LIMIT, createCloudAuth, parseCloudCredentials } from "./CloudAuth"
import type { CloudAuth, CloudKeychain } from "./CloudAuth"

/*
 * An in-memory keychain double: the real one is macOS `security`, which a
 * test must never touch (RepositoryAuthority discipline: tests bind honest
 * doubles instead of a shared machine resource).
 */
const memoryKeychain = (): CloudKeychain & { readonly store: Map<string, string> } => {
  const store = new Map<string, string>()
  return {
    store,
    read: async (service, account) => store.get(`${service}:${account}`) ?? null,
    write: async (service, account, secret) => void store.set(`${service}:${account}`, secret),
    remove: async (service, account) => void store.delete(`${service}:${account}`)
  }
}

const callbackBody = (url: string, value: Record<string, unknown>): string => JSON.stringify({ ...value, callback_state: new URL(url).searchParams.get("callback_state") })

/*
 * Every fixture auth runs on this frozen clock. Production expiry is
 * `expiresAt <= now()`, so a credential pinned to a wall-clock date would
 * silently turn these sign-in assertions into signed-out ones the day the
 * real clock passed it; the fixture expiry is stated relative to NOW instead.
 */
const NOW = Date.parse("2026-01-01T00:00:00Z")
const now = (): number => NOW
/** An ISO instant `offsetMs` from the frozen clock. */
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

const CREDENTIALS = {
  token: "smithers_test_token",
  username: "will",
  email: "will@codeplane.app",
  expiresAt: at(24 * 60 * 60 * 1000)
}

/*
 * The fake Smithers Cloud upstream: when the login URL is opened it POSTs the
 * credentials to the callback port (the GitHub CLI flow's half), and it
 * answers the scope probe. `probeStatus`/`probeBody` shape the probe answer.
 */
const fakeUpstream = (
  options: { readonly probeStatus?: number; readonly probeBody?: string; readonly probeDelayMs?: number } = {}
) => {
  const requests: Array<{ readonly path: string; readonly authorization: string | null }> = []
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      requests.push({ path: url.pathname, authorization: request.headers.get("authorization") })
      if (url.pathname === "/api/auth/github/cli") {
        const port = Number(url.searchParams.get("callback_port"))
        // The real flow renders a GitHub page that eventually posts the minted
        // PAT back; the double posts it directly.
        void fetch(`http://127.0.0.1:${port}/callback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...CREDENTIALS, callback_state: url.searchParams.get("callback_state") })
        })
        return new Response("<html>login</html>", { headers: { "content-type": "text/html" } })
      }
      if (url.pathname === "/api/user/workspaces") {
        if (options.probeDelayMs !== undefined) await Bun.sleep(options.probeDelayMs)
        return new Response(options.probeBody ?? "[]", { status: options.probeStatus ?? 200 })
      }
      return new Response("not found", { status: 404 })
    }
  })
  return { server, requests, origin: `http://127.0.0.1:${server.port}` }
}

let auth: CloudAuth | undefined
let upstream: Server<undefined> | undefined

afterEach(async () => {
  await auth?.stop()
  upstream?.stop(true)
  auth = undefined
  upstream = undefined
})

describe("parseCloudCredentials", () => {
  test("accepts the callback shape and refuses anything else whole", () => {
    expect(parseCloudCredentials(CREDENTIALS)).toEqual(CREDENTIALS)
    expect(parseCloudCredentials({ token: "x" })).toBeNull()
    expect(parseCloudCredentials({ ...CREDENTIALS, token: "" })).toBeNull()
    expect(parseCloudCredentials("nope")).toBeNull()
    expect(parseCloudCredentials({ ...CREDENTIALS, expiresAt: undefined, expires_at: CREDENTIALS.expiresAt })?.expiresAt).toBe(CREDENTIALS.expiresAt)
  })
})

describe("cloud sign-in", () => {
  test("a fresh attempt rejects missing and previous callback state before probing", async () => {
    let probes = 0
    auth = await createCloudAuth({ now, api: "https://cloud-auth.test", keychain: memoryKeychain(), fetchImpl: async () => { probes++; return new Response("[]") } })
    const first = await auth.start()
    if (!("url" in first)) throw new Error(first.error)
    await auth.signOut()
    const current = await auth.start()
    if (!("url" in current)) throw new Error(current.error)
    expect(new URL(first.url).searchParams.get("callback_state")).not.toBe(new URL(current.url).searchParams.get("callback_state"))
    const port = new URL(current.url).searchParams.get("callback_port")
    const callback = `http://127.0.0.1:${port}/callback`
    const headers = { "content-type": "application/json" }
    for (const body of [JSON.stringify(CREDENTIALS), callbackBody(first.url, CREDENTIALS)]) {
      expect((await fetch(callback, { method: "POST", headers, body })).status).toBe(403)
    }
    expect((await fetch(callback, { method: "POST", headers: { ...headers, origin: new URL(callback).origin }, body: callbackBody(current.url, CREDENTIALS) })).status).toBe(403)
    expect(auth.session().state).toBe("signing-in")
    expect(probes).toBe(0)
    expect((await fetch(callback, { method: "POST", headers, body: callbackBody(current.url, CREDENTIALS) })).status).toBe(200)
  })

  test("foreign browser callbacks and invalid hosts cannot claim a login attempt", async () => {
    let probes = 0
    const saved = memoryKeychain()
    const api = "https://cloud-auth.test"
    auth = await createCloudAuth({ now, api, keychain: saved, fetchImpl: async () => { probes++; return new Response("[]") } })
    const started = await auth.start()
    if (!("url" in started)) throw new Error(started.error)
    const port = new URL(started.url).searchParams.get("callback_port")
    const callback = `http://127.0.0.1:${port}/callback`
    for (const contentType of ["application/json", "text/plain"]) {
      const response = await fetch(callback, { method: "POST", headers: { origin: "https://foreign.test", "content-type": contentType }, body: callbackBody(started.url, CREDENTIALS) })
      expect(response.status).toBe(403)
    }
    expect((await fetch(callback, { method: "POST", headers: { origin: "null", "content-type": "application/json" }, body: callbackBody(started.url, CREDENTIALS) })).status).toBe(403)
    expect((await fetch(callback, { method: "POST", headers: { host: `rebound.test:${port}`, "content-type": "application/json" }, body: callbackBody(started.url, CREDENTIALS) })).status).toBe(403)
    expect((await fetch(callback, { method: "POST", headers: { "content-type": "text/plain" }, body: callbackBody(started.url, CREDENTIALS) })).status).toBe(415)
    expect(auth.session().state).toBe("signing-in")
    expect(auth.token()).toBeUndefined()
    expect(probes).toBe(0)
    expect(saved.store.size).toBe(0)
    const trusted = await fetch(callback, { method: "POST", headers: { origin: api, "content-type": "application/json; charset=utf-8" }, body: callbackBody(started.url, CREDENTIALS) })
    expect(trusted.status).toBe(200)
    const deadline = Date.now() + 1000
    while (auth.session().state !== "signed-in" && Date.now() < deadline) await Bun.sleep(5)
    expect(auth.token()).toBe(CREDENTIALS.token)
    expect(probes).toBe(1)
  })

  test("oversized callback bodies do not consume the attempt", async () => {
    auth = await createCloudAuth({ now, api: "https://cloud-auth.test", keychain: memoryKeychain(), fetchImpl: async () => new Response("[]") })
    const started = await auth.start()
    if (!("url" in started)) throw new Error(started.error)
    const port = new URL(started.url).searchParams.get("callback_port")
    const callback = `http://127.0.0.1:${port}/callback`
    const headers = { "content-type": "application/json" }
    const oversized = JSON.stringify({ ...CREDENTIALS, username: "x".repeat(CLOUD_AUTH_BODY_LIMIT) })
    expect((await fetch(callback, { method: "POST", headers, body: oversized })).status).toBe(413)
    const streamed = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(oversized))
      controller.close()
    } })
    expect((await fetch(callback, { method: "POST", headers, body: streamed })).status).toBe(413)
    expect(auth.session().state).toBe("signing-in")
    expect((await fetch(callback, { method: "POST", headers, body: callbackBody(started.url, CREDENTIALS) })).status).toBe(200)
  })

  test("only the first callback settles the attempt; a replay or a racing local process is refused", async () => {
    const upstream = fakeUpstream()
    const keychain = memoryKeychain()
    const auth: CloudAuth = await createCloudAuth({ now, api: upstream.origin, keychain, log: () => {} })
    try {
      const started = await auth.start()
      if (!("url" in started)) throw new Error(started.error)
      const port = Number(new URL(started.url).searchParams.get("callback_port"))
      // The double's callback races the fake upstream's own POST; whichever lands second must be refused.
      const first = await fetch(`http://127.0.0.1:${port}/callback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: callbackBody(started.url, { ...CREDENTIALS, token: "smithers_attacker_token", username: "mallory" })
      })
      const second = await fetch(`http://127.0.0.1:${port}/callback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: callbackBody(started.url, { ...CREDENTIALS, token: "smithers_attacker_token_2", username: "mallory2" })
      }).catch(() => null)
      expect([200, 409]).toContain(first.status)
      if (second !== null) expect(second.status).toBe(409)
      await new Promise((resolve) => setTimeout(resolve, 50))
      // Whichever POST won, exactly one username is the session's, and it is never the loser's.
      expect(auth.session().username).not.toBe("mallory2")
      expect(auth.session().state).toBe("signed-in")
    } finally {
      await auth.stop()
      upstream.server.stop(true)
    }
  })

  test("start answers the CLI login URL; the callback signs in; the session never carries the token", async () => {
    const fake = fakeUpstream()
    upstream = fake.server
    const keychain = memoryKeychain()
    auth = await createCloudAuth({ now, api: fake.origin, keychain, waitTimeoutMs: 5000 })
    expect(auth.session()).toEqual({ state: "signed-out", username: null, expiresAt: null })

    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    const login = new URL(started.url)
    expect(login.origin).toBe(fake.origin)
    expect(login.pathname).toBe("/api/auth/github/cli")
    expect(login.searchParams.get("scopes")?.split(",")).toEqual(["read:user", "read:organization", "read:repository", "write:repository", "read:workspace", "write:workspace", "write:agent", "write:approval"])
    expect(login.searchParams.get("callback_state")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const callbackPort = Number(login.searchParams.get("callback_port"))
    expect(callbackPort).toBeGreaterThan(0)
    expect(auth.session().state).toBe("signing-in")

    // The renderer opens the URL in the system browser; the double posts back.
    const page = await fetch(started.url)
    expect(page.status).toBe(200)
    const deadline = Date.now() + 5000
    while (auth.session().state !== "signed-in") {
      if (Date.now() > deadline) throw new Error("the callback never signed the session in")
      await Bun.sleep(10)
    }
    const session = auth.session()
    expect(session).toEqual({ state: "signed-in", username: "will", expiresAt: CREDENTIALS.expiresAt })
    expect(JSON.stringify(session)).not.toContain(CREDENTIALS.token)
    // The bearer stays Bun-side, for the proxy alone.
    expect(auth.token()).toBe(CREDENTIALS.token)
    // At rest in the keychain under the API host.
    expect(keychain.store.get(`smithers-cloud:127.0.0.1:${fake.server.port}`)).toBe(JSON.stringify(CREDENTIALS))
    // The probe ran once, with the bearer, and answered 200: not degraded.
    const probes = fake.requests.filter((request) => request.path === "/api/user/workspaces")
    expect(probes).toHaveLength(1)
    expect(probes[0]?.authorization).toBe(`Bearer ${CREDENTIALS.token}`)
  })

  test("a 403 insufficient-scope probe answer degrades the session", async () => {
    const fake = fakeUpstream({ probeStatus: 403, probeBody: JSON.stringify({ error: "insufficient token scope" }) })
    upstream = fake.server
    auth = await createCloudAuth({ now, api: fake.origin, keychain: memoryKeychain(), waitTimeoutMs: 5000 })
    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    await fetch(started.url)
    const deadline = Date.now() + 5000
    while (auth.session().state !== "signed-in") {
      if (Date.now() > deadline) throw new Error("the callback never signed the session in")
      await Bun.sleep(10)
    }
    expect(auth.session()).toEqual({
      state: "signed-in",
      username: "will",
      expiresAt: CREDENTIALS.expiresAt,
      scopes: "degraded"
    })
  })

  test("the session reports signed-in only once the scope probe has answered", async () => {
    // A slow probe used to let a reader see signed-in with no scope verdict
    // and then watch it degrade; the first signed-in observation carries it.
    const fake = fakeUpstream({
      probeStatus: 403,
      probeBody: JSON.stringify({ error: "insufficient token scope" }),
      probeDelayMs: 300
    })
    upstream = fake.server
    auth = await createCloudAuth({ now, api: fake.origin, keychain: memoryKeychain(), waitTimeoutMs: 5000 })
    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    await fetch(started.url)
    const deadline = Date.now() + 5000
    while (auth.session().state !== "signed-in") {
      if (Date.now() > deadline) throw new Error("the callback never signed the session in")
      await Bun.sleep(10)
    }
    expect(auth.session().scopes).toBe("degraded")
  })

  test("a 403 that does not name scope does not degrade", async () => {
    const fake = fakeUpstream({ probeStatus: 403, probeBody: JSON.stringify({ error: "forbidden" }) })
    upstream = fake.server
    auth = await createCloudAuth({ now, api: fake.origin, keychain: memoryKeychain(), waitTimeoutMs: 5000 })
    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    await fetch(started.url)
    const deadline = Date.now() + 5000
    while (auth.session().state !== "signed-in") {
      if (Date.now() > deadline) throw new Error("the callback never signed the session in")
      await Bun.sleep(10)
    }
    expect(auth.session().scopes).toBeUndefined()
  })

  test("a callback that never arrives expires the attempt back to signed-out", async () => {
    auth = await createCloudAuth({ now, api: "http://127.0.0.1:1", keychain: memoryKeychain(), waitTimeoutMs: 50 })
    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    expect(auth.session().state).toBe("signing-in")
    await Bun.sleep(150)
    expect(auth.session().state).toBe("signed-out")
  })

  test("a malformed callback body is refused and the attempt stays open", async () => {
    auth = await createCloudAuth({ now, api: "http://127.0.0.1:1", keychain: memoryKeychain(), waitTimeoutMs: 5000 })
    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    const port = Number(new URL(started.url).searchParams.get("callback_port"))
    const bad = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: callbackBody(started.url, { token: "" })
    })
    expect(bad.status).toBe(400)
    expect(auth.session().state).toBe("signing-in")
    const good = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: callbackBody(started.url, CREDENTIALS)
    })
    expect(good.status).toBe(200)
  })

  test("sign-out forgets the credential and clears the keychain entry", async () => {
    const fake = fakeUpstream()
    upstream = fake.server
    const keychain = memoryKeychain()
    auth = await createCloudAuth({ now, api: fake.origin, keychain, waitTimeoutMs: 5000 })
    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    await fetch(started.url)
    const deadline = Date.now() + 5000
    while (auth.session().state !== "signed-in") {
      if (Date.now() > deadline) throw new Error("the callback never signed the session in")
      await Bun.sleep(10)
    }
    await auth.signOut()
    expect(auth.session()).toEqual({ state: "signed-out", username: null, expiresAt: null })
    expect(auth.token()).toBeUndefined()
    expect(keychain.store.size).toBe(0)
  })

  test("a previous launch's credential restores from the keychain", async () => {
    const keychain = memoryKeychain()
    keychain.store.set("smithers-cloud:api.smithers-cloud.test", JSON.stringify(CREDENTIALS))
    auth = await createCloudAuth({ now, api: "https://api.smithers-cloud.test", keychain, fetchImpl: async () => new Response("[]") })
    expect(auth.session()).toEqual({ state: "signed-in", username: "will", expiresAt: CREDENTIALS.expiresAt })
    expect(auth.token()).toBe(CREDENTIALS.token)
  })

  test("a restored credential lives up to its expiry instant and not through it", async () => {
    // Production refuses `expiresAt <= now()`: the instant itself is already dead.
    for (const [expiresAt, state] of [[at(1), "signed-in"], [at(0), "signed-out"], [at(-1), "signed-out"]] as const) {
      const keychain = memoryKeychain()
      keychain.store.set("smithers-cloud:api.smithers-cloud.test", JSON.stringify({ ...CREDENTIALS, expiresAt }))
      auth = await createCloudAuth({ now, api: "https://api.smithers-cloud.test", keychain, fetchImpl: async () => new Response("[]") })
      expect(auth.session().state).toBe(state)
      expect(auth.token()).toBe(state === "signed-in" ? CREDENTIALS.token : undefined)
      // An expired credential is not merely ignored: it leaves the keychain.
      expect(keychain.store.size).toBe(state === "signed-in" ? 1 : 0)
      await auth.stop()
      auth = undefined
    }
  })

  test("SMITHERS_CLOUD_TOKEN is the dev/CI override: read first, never stored", async () => {
    const keychain = memoryKeychain()
    keychain.store.set("smithers-cloud:api.smithers-cloud.test", JSON.stringify(CREDENTIALS))
    auth = await createCloudAuth({ now, api: "https://api.smithers-cloud.test", keychain, envToken: "smithers_env_override", fetchImpl: async () => new Response("[]") })
    expect(auth.token()).toBe("smithers_env_override")
    expect(auth.session().state).toBe("signed-in")
    // The override is not a login: no stored credential is touched or reported.
    expect(auth.session().username).toBeNull()
    const started = await auth.start()
    expect("error" in started).toBe(true)
  })
})
