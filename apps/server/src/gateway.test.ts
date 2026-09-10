/*
 * Wave 11 — the per-user gateway seam, unit-proven against a relay double.
 *
 * The contract under test is WAVE4-RELAY-RECEIPT.md §5 (provision-or-resume is
 * idempotent; re-call at the half-life and ALWAYS adopt what comes back; the
 * 401/409/500-no_capacity taxonomy is distinct and never retry-looped) plus the
 * wave-11b Cloud token door (`POST /api/identity/cloud-token`, service-token,
 * by login, with typed `{found:false, cloud:{status}}` honesty).
 *
 * The hard invariant every one of these pins: a gateway token is an operator
 * credential with `scopes:["*"]` on the user's VM. It lives server-side only.
 *
 * Every upstream is a `Transport` layer, never a patched `globalThis.fetch`;
 * the store is the REAL GatewaySessionRegistry over in-memory storage
 * (src/memoryDurableObjects.ts), running under the same injected layers,
 * unless a test binds a Durable Object double. The route layer above this
 * seam (`/api/workflow/*`) is proven beside the router.
 */
import { afterEach, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { TestClock } from "effect/testing"
import { testConfigLayer } from "./Config"
import type { ServerConfigShape } from "./Config"
import { memoryStorage, storageLayer } from "./DurableStorage"
import type { NativeNamespace, NativeStorage } from "./DurableStorage"
import {
  callGateway,
  ensureGateway,
  fetchCloudToken,
  GatewaySessionRegistry,
  gatewayResolutionsLayer,
  gatewaySessionRequest,
  gatewaySessionsLayer,
  makeGatewayResolutions
} from "./gateway"
import type { GatewayRecord } from "./gateway"
import { transportLayer } from "./Http"
import type { FetchImplementation } from "./Http"
import { memoryDurableObjects } from "./memoryDurableObjects"

const GATEWAY_TOKEN = "smithers_gateway_secret-operator-token"
const CLOUD_TOKEN = "smithers_pat_cloud-identity"

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface RelayCall {
  readonly url: string
  readonly method: string
  readonly authorization: string | null
  readonly serviceToken: string | null
  readonly body: unknown
}

interface RelayScript {
  readonly cloudToken?: (call: RelayCall, attempt: number) => Response | undefined
  readonly provision?: (call: RelayCall, attempt: number, signal: AbortSignal) => Response | undefined | Promise<Response>
  readonly gateway?: (call: RelayCall, attempt: number, signal: AbortSignal) => Response | undefined | Promise<Response>
}

/**
 * The relay double: the identity cloud-token door plus the Cloud provision
 * route and a per-gateway RPC/REST surface, each answering the exact shapes
 * the receipts recorded. `script` lets a test bend one leg at a time.
 */
const relay = (script: RelayScript = {}): { readonly calls: RelayCall[]; readonly fetch: FetchImplementation } => {
  const calls: RelayCall[] = []
  const attempts = { cloudToken: 0, provision: 0, gateway: 0 }
  const fetch: FetchImplementation = async (input, init) => {
    const request = typeof input === "string"
      ? new Request(input, init)
      : input instanceof URL
      ? new Request(input.toString(), init)
      : new Request(input, init)
    const url = new URL(request.url)
    const raw = await request.clone().text()
    const call: RelayCall = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      serviceToken: request.headers.get("x-smithers-service-token"),
      body: raw === "" ? undefined : JSON.parse(raw)
    }
    calls.push(call)
    if (url.pathname === "/api/identity/cloud-token") {
      attempts.cloudToken += 1
      return (
        script.cloudToken?.(call, attempts.cloudToken) ??
          json(200, { valid: true, login: "codeplanesmithers", found: true, token: CLOUD_TOKEN })
      )
    }
    if (/^\/api\/repos\/[^/]+\/[^/]+\/gateway$/.test(url.pathname)) {
      attempts.provision += 1
      return (
        (await script.provision?.(call, attempts.provision, request.signal)) ??
          json(200, {
            base_url: "https://api.smithers-cloud.test/api/gateways/gw-1",
            token: GATEWAY_TOKEN,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            gateway_id: "gw-1",
            vm_id: "msb_1",
            status: "running"
          })
      )
    }
    if (url.pathname.startsWith("/api/gateways/")) {
      attempts.gateway += 1
      return (await script.gateway?.(call, attempts.gateway, request.signal)) ?? json(200, { ok: true, apiVersion: "v1", payload: [] })
    }
    throw new Error(`The relay double has no route for ${request.url}`)
  }
  return { calls, fetch }
}

/** Waits, on the live clock, until the relay double has seen a call ending in `suffix`. */
const untilCalled = (calls: ReadonlyArray<RelayCall>, suffix: string): Effect.Effect<void> =>
  Effect.promise(() =>
    new Promise<void>((resolve) => {
      const poll = () => (calls.some((call) => call.url.endsWith(suffix)) ? resolve() : setTimeout(poll, 1))
      poll()
    })
  )

/** A fetch that is accepted and never answers: only the caller's own deadline ends it. */
const silence = (signal: AbortSignal | undefined): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true })
  })

const config = (overrides: Partial<ServerConfigShape> = {}) =>
  testConfigLayer({
    identityUpstreamUrl: "https://identity.test",
    identityServiceToken: Redacted.make("service-token"),
    cloudApiBaseUrl: "https://api.smithers-cloud.test",
    ...overrides
  })

/*
 * The seam's whole world: one transport, one config, one session store. The
 * store is one fixture per test: records persist across `seam()` calls inside
 * a test (a deployment keeps them across Worker requests) and vanish between
 * tests. The registry runs the resolution itself, under the first `seam()`'s
 * transport and config.
 */
let durable: ReturnType<typeof memoryDurableObjects> | undefined
const seam = (
  fetch: FetchImplementation,
  options: { readonly config?: Partial<ServerConfigShape>; readonly namespace?: NativeNamespace } = {}
) => {
  const services = Layer.mergeAll(transportLayer(fetch), config(options.config))
  durable ??= memoryDurableObjects({ services })
  return Layer.mergeAll(services, gatewaySessionsLayer(options.namespace ?? durable.GATEWAY_SESSIONS))
}

/** An aged record, written through the registry's own PUT route: `seam()` must have been called first. */
const seed = (login: string, repo: string, record: GatewayRecord): Promise<void> => durable!.seedGatewayRecord(login, repo, record)

/** One registry object over `storage`, running under the seam's transport and config: a Durable Object double a test controls. */
const registryOver = (storage: NativeStorage, fetch: FetchImplementation, overrides: Partial<ServerConfigShape> = {}) => {
  const layers = Layer.mergeAll(storageLayer(storage), transportLayer(fetch), config(overrides), gatewayResolutionsLayer(makeGatewayResolutions()))
  return { fetch: (request: Request) => Effect.runPromise(gatewaySessionRequest(request).pipe(Effect.provide(layers))) }
}

const run = <A>(effect: Effect.Effect<A, never, never>): Promise<A> => Effect.runPromise(effect)

/** A provision-shape answer whose gateway differs per attempt, the §5 renew shape. */
const freshGateway = (attempt: number, extra: Record<string, unknown> = {}): Response =>
  json(200, {
    base_url: `https://api.smithers-cloud.test/api/gateways/gw-${attempt}`,
    token: `${GATEWAY_TOKEN}-${attempt}`,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    gateway_id: `gw-${attempt}`,
    ...extra
  })

afterEach(() => {
  durable = undefined
})

describe("wave 11 — provision-or-resume (§5)", () => {
  test("provisions with the user's Cloud token, adopts what comes back, and caches to the half-life", async () => {
    const { calls, fetch } = relay()
    const layer = seam(fetch)
    const first = await run(ensureGateway("codeplanesmithers", "codeplanesmithers/smithers-demo").pipe(Effect.provide(layer)))
    expect(first.status).toBe("ready")
    if (first.status !== "ready") return
    expect(first.record.gatewayId).toBe("gw-1")
    expect(first.record.token).toBe(GATEWAY_TOKEN)
    // The half-life cadence: re-resolve at the midpoint of the window.
    const window = first.record.expiresAt - Date.now()
    expect(first.record.renewAfter - Date.now()).toBeGreaterThan(window * 0.4)
    expect(first.record.renewAfter).toBeLessThan(first.record.expiresAt)

    // The door was called with the service token and the login; the
    // provision leg carried the Cloud token as a bearer.
    const door = calls.find((call) => call.url.endsWith("/api/identity/cloud-token"))
    expect(door?.serviceToken).toBe("service-token")
    expect(door?.body).toEqual({ login: "codeplanesmithers" })
    const provision = calls.find((call) => call.url.includes("/gateway"))
    expect(provision?.url).toBe("https://api.smithers-cloud.test/api/repos/codeplanesmithers/smithers-demo/gateway")
    expect(provision?.authorization).toBe(`Bearer ${CLOUD_TOKEN}`)

    // Inside the half-life a second resolve is free: no second provision.
    const second = await run(ensureGateway("codeplanesmithers", "codeplanesmithers/smithers-demo").pipe(Effect.provide(layer)))
    expect(second.status).toBe("ready")
    expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
  })

  test("the Cloud token door states an unset deployment as itself", async () => {
    const { calls, fetch } = relay()
    const unset = await run(fetchCloudToken("will").pipe(Effect.provide(seam(fetch, { config: { identityUpstreamUrl: undefined } }))))
    expect(unset).toEqual({ status: "not_configured", detail: "IDENTITY_UPSTREAM_URL is unset on this deployment." })
    const noToken = await run(fetchCloudToken("will").pipe(Effect.provide(seam(fetch, { config: { identityServiceToken: undefined } }))))
    expect(noToken).toEqual({ status: "not_configured", detail: "IDENTITY_SERVICE_TOKEN is unset on this deployment." })
    expect(calls).toHaveLength(0)
  })

  test("a resolved Durable Object write failure cannot report the gateway ready", async () => {
    const { calls, fetch } = relay()
    const registry = registryOver({
      get: async () => undefined,
      put: async () => {
        throw new Error("storage unavailable")
      }
    }, fetch)
    const namespace: NativeNamespace = { idFromName: (name) => name, get: () => registry }
    const outcome = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch, { namespace }))))
    expect(outcome).toEqual({ status: "unavailable", detail: "The gateway session store is unavailable: storage unavailable" })
    // The relay was asked, the record was minted, and it is not reported.
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(1)
  })

  test("a session store that cannot be reached cannot report the gateway ready", async () => {
    const { calls, fetch } = relay()
    const unreachable: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => {
          throw new Error("Durable Object reset because its code was updated.")
        }
      })
    }
    const outcome = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch, { namespace: unreachable }))))
    expect(outcome).toEqual({
      status: "unavailable",
      detail: "The gateway session store is unavailable: Durable Object reset because its code was updated."
    })
    expect(calls).toHaveLength(0)
    const overloaded: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response("overloaded", { status: 503 }) })
    }
    const refused = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch, { namespace: overloaded }))))
    expect(refused).toEqual({ status: "unavailable", detail: "The gateway session store answered HTTP 503: overloaded" })
    const odd: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => json(200, { record: null }) })
    }
    const shapeless = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch, { namespace: odd }))))
    expect(shapeless).toEqual({
      status: "unavailable",
      detail: "The gateway session store answered in a shape the gateway seam did not understand."
    })
  })

  test("a renew adopts a DIFFERENT gateway id, token and base url — nothing is assumed unchanged", async () => {
    // §5 item 3: the reprovision path legitimately hands back a different
    // gateway; every cached URL must be rebuilt from what came back.
    const { fetch } = relay({ provision: (_call, attempt) => freshGateway(attempt, { vm_id: `msb_${attempt}` }) })
    const layer = seam(fetch)
    const first = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(layer)))
    expect(first.status === "ready" && first.record.gatewayId).toBe("gw-1")
    // The renew path (what a relay 401 and a past-half-life record both take).
    const second = await run(ensureGateway("will", "will/mvp", true).pipe(Effect.provide(layer)))
    expect(second.status === "ready" && second.record.gatewayId).toBe("gw-2")
    expect(second.status === "ready" && second.record.token).toBe(`${GATEWAY_TOKEN}-2`)
    expect(second.status === "ready" && second.record.baseUrl).toBe("https://api.smithers-cloud.test/api/gateways/gw-2")
    // And the renewed record is what a later resolve reads back.
    const third = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(layer)))
    expect(third.status === "ready" && third.record.gatewayId).toBe("gw-2")
  })

  test("a bogus short expires_at cannot spin the provision loop — the renew floor holds", async () => {
    // The relay's `expires_at` is advisory (§5: always now + 1h, never
    // checked). A garbage timestamp must not turn the half-life cadence
    // into a per-call provision stampede, so the floor is a real minimum.
    const { calls, fetch } = relay({
      provision: () =>
        json(200, {
          base_url: "https://api.smithers-cloud.test/api/gateways/gw-1",
          token: GATEWAY_TOKEN,
          expires_at: new Date(Date.now() + 2).toISOString(),
          gateway_id: "gw-1"
        })
    })
    const layer = seam(fetch)
    const first = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(layer)))
    expect(first.status === "ready" && first.record.renewAfter - Date.now()).toBeGreaterThan(30_000)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(layer)))
    await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(layer)))
    expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
  })

  test("409 is 'still provisioning' — surfaced for the caller to poll, never stampeded", async () => {
    const { calls, fetch } = relay({
      provision: () => new Response("repo gateway provisioning is still in progress", { status: 409 })
    })
    const outcome = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch))))
    expect(outcome.status).toBe("provisioning")
    expect(outcome.status === "provisioning" && outcome.detail).toBe("The workspace for will/mvp is still being prepared.")
    // Exactly ONE provision attempt: this seam does not retry-loop.
    expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
  })

  /*
   * Repro apps/app/canary-repros/honesty/22.6: Smithers Cloud accepted the
   * provision POST and never answered, so the route hung past 70s and the
   * product left "Preparing your <repo> workspace…" standing with no run
   * card, no timeout and no error. A deadline turns silence into one of the
   * seam's own honest states — the request always ANSWERS.
   */
  test("a provision upstream that never answers becomes an honest state, not a hang", async () => {
    // The exact canary shape: the connection is accepted and nothing ever
    // comes back. The deadline is the registry's own (it provisions inside
    // the object, on the deployment's clock), so it is shortened, not faked.
    const { calls, fetch } = relay({ provision: (_call, _attempt, signal) => silence(signal) })
    const outcome = await run(
      ensureGateway("codeplanesmithers", "codeplanesmithers/canary-sandbox").pipe(
        Effect.provide(seam(fetch, { config: { upstreamTimeoutMs: 150 } }))
      )
    )
    expect(outcome.status).toBe("provisioning")
    if (outcome.status === "provisioning") {
      expect(outcome.detail).toBe(
        "Smithers Cloud hasn't finished preparing the workspace for codeplanesmithers/canary-sandbox yet — it took longer than 150ms to answer."
      )
    }
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(1)
  })

  test("the deadline is the deployment's UPSTREAM_TIMEOUT_MS, stated in the answer", async () => {
    const { fetch } = relay({ provision: (_call, _attempt, signal) => silence(signal) })
    const started = Date.now()
    const outcome = await run(
      ensureGateway("codeplanesmithers", "codeplanesmithers/canary-sandbox").pipe(
        Effect.provide(seam(fetch, { config: { upstreamTimeoutMs: 150 } }))
      )
    )
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(outcome.status).toBe("provisioning")
    if (outcome.status === "provisioning") {
      expect(outcome.detail).toContain("codeplanesmithers/canary-sandbox")
      expect(outcome.detail).toContain("longer than")
      expect(outcome.detail).toContain("150ms")
    }
  })

  test("the Cloud token deadline names the actual 20 ms duration", async () => {
    const { fetch } = relay({ cloudToken: () => undefined })
    const stalled: FetchImplementation = (input, init) =>
      new URL(input instanceof Request ? input.url : input.toString()).pathname === "/api/identity/cloud-token"
        ? silence(init?.signal ?? undefined)
        : fetch(input, init)
    const outcome = await run(fetchCloudToken("deadline-user").pipe(Effect.provide(seam(stalled, { config: { upstreamTimeoutMs: 20 } }))))
    expect(outcome).toEqual({
      status: "unavailable",
      detail: "The identity service is unreachable: The Cloud token door did not answer within 20ms."
    })
  })

  test("500 no_capacity is surfaced honestly and never retried", async () => {
    const { calls, fetch } = relay({ provision: () => json(500, { error: "no_capacity", message: "no worker has capacity" }) })
    const outcome = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch))))
    expect(outcome.status).toBe("no_capacity")
    expect(outcome.status === "no_capacity" && outcome.detail).toContain("no free workspace capacity")
    expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
  })

  test("a long 500 body is cut to its prefix, not refused — no_capacity past the ceiling still counts", async () => {
    const { fetch } = relay({
      provision: () => json(500, { error: "no_capacity", message: `no worker has capacity ${"x".repeat(4_000)}` })
    })
    const outcome = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch))))
    expect(outcome.status).toBe("no_capacity")
  })

  test("an unexplained 500 carries the upstream's first 240 characters", async () => {
    const { fetch } = relay({ provision: () => new Response(`  ${"boom ".repeat(100)}`, { status: 500 }) })
    const outcome = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch))))
    expect(outcome.status).toBe("unavailable")
    if (outcome.status !== "unavailable") return
    expect(outcome.detail.startsWith("Provisioning the workspace answered HTTP 500: boom boom")).toBe(true)
    expect(outcome.detail.length).toBeLessThanOrEqual("Provisioning the workspace answered HTTP 500: ".length + 240)
  })

  test("429 quota_exceeded is the same honest no-capacity truth, not a leaked status code", async () => {
    // Caught live on canary while verifying wave 12: the pool's other refusal
    // shape is `429 {"code":"quota_exceeded","message":"concurrent sandboxes
    // limit reached"}`, which used to surface as "answered HTTP 429: {…}".
    const { calls, fetch } = relay({
      provision: () => json(429, { code: "quota_exceeded", message: "concurrent sandboxes limit reached" })
    })
    const outcome = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch))))
    expect(outcome.status).toBe("no_capacity")
    expect(outcome.status === "no_capacity" && outcome.detail).toContain("no free workspace capacity")
    expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
  })

  test("a repo with no Smithers Cloud counterpart is its own state, not a raw HTTP failure", async () => {
    // Wave 12 §4: the watched set is a GITHUB set. A watched repo that has no
    // Cloud repository behind it answers 404 — a distinct, un-retryable state
    // the product states in its own words instead of leaking the status code.
    const { calls, fetch } = relay({ provision: () => json(404, { error: "not_found", message: "repository not found" }) })
    const outcome = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch))))
    expect(outcome.status).toBe("no_cloud_repo")
    expect(outcome.status === "no_cloud_repo" && outcome.detail).toContain("isn't on Smithers Cloud yet")
    // Stated once; never retry-looped.
    expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
  })

  test("401 re-mints the Cloud token through the door and retries exactly ONCE", async () => {
    const { calls, fetch } = relay({
      provision: (_call, attempt) => (attempt <= 2 ? new Response("unauthorized", { status: 401 }) : undefined)
    })
    const outcome = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch))))
    expect(outcome).toEqual({ status: "unavailable", detail: "Smithers Cloud rejected a freshly minted identity token." })
    // One re-mint, two provision attempts — bounded, not a loop.
    expect(calls.filter((call) => call.url.endsWith("/api/identity/cloud-token")).length).toBe(2)
    expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(2)
  })

  test("no Cloud identity is stated as itself, not as a generic failure", async () => {
    const { calls, fetch } = relay({
      cloudToken: () => json(200, { valid: true, found: false, cloud: { status: "no_github_token", reason: null } })
    })
    const outcome = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch))))
    expect(outcome.status).toBe("no_cloud_token")
    expect(outcome.status === "no_cloud_token" && outcome.detail).toContain("no_github_token")
    // Nothing was provisioned on a missing identity.
    expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(0)
  })

  test("a door that refuses is reported with its status and first 200 characters", async () => {
    const { fetch } = relay({ cloudToken: () => new Response(" service token rejected ", { status: 403 }) })
    const outcome = await run(ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch))))
    expect(outcome).toEqual({ status: "unavailable", detail: "The Cloud token door answered HTTP 403: service token rejected" })
  })

  test("concurrent callers for one workspace share ONE in-flight provision", async () => {
    // §5's "never stampede", in the shape a page load produces: a run card,
    // an EventSource and a projection read all resolving the same gateway
    // at once. One POST leaves the Worker; every caller adopts its answer.
    let release: (response: Response) => void = () => {}
    const gate = new Promise<Response>((resolve) => {
      release = resolve
    })
    const { calls, fetch } = relay({ provision: (_call, attempt) => (attempt === 1 ? gate : freshGateway(attempt)) })
    const layer = seam(fetch)
    const outcomes = await run(
      Effect.gen(function* () {
        const fibers = yield* Effect.forEach(
          [1, 2, 3],
          () => Effect.forkChild(ensureGateway("will", "will/mvp")),
        )
        // Every caller is past the cache read and waiting on the one POST.
        yield* Effect.sleep("20 millis")
        expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(1)
        release(freshGateway(1))
        return yield* Effect.forEach(fibers, Fiber.join)
      }).pipe(Effect.provide(layer))
    )
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["ready", "ready", "ready"])
    expect(outcomes.map((outcome) => outcome.status === "ready" && outcome.record.gatewayId)).toEqual(["gw-1", "gw-1", "gw-1"])
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(1)
    expect(calls.filter((call) => call.url.endsWith("/api/identity/cloud-token"))).toHaveLength(1)
    // A later forced renew is its own provision again: single flight, not a permanent cache.
    const renewed = await run(ensureGateway("will", "will/mvp", true).pipe(Effect.provide(layer)))
    expect(renewed.status === "ready" && renewed.record.gatewayId).toBe("gw-2")
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(2)
  })

  test("a caller that leaves mid-provision does not cancel the provision the others are waiting on", async () => {
    let release: (response: Response) => void = () => {}
    const gate = new Promise<Response>((resolve) => {
      release = resolve
    })
    const { calls, fetch } = relay({ provision: () => gate })
    const outcome = await run(
      Effect.gen(function* () {
        const leaver = yield* Effect.forkChild(ensureGateway("will", "will/mvp"))
        yield* Effect.sleep("10 millis")
        const stayer = yield* Effect.forkChild(ensureGateway("will", "will/mvp"))
        yield* Effect.sleep("10 millis")
        yield* Fiber.interrupt(leaver)
        release(freshGateway(1))
        return yield* Fiber.join(stayer)
      }).pipe(Effect.provide(seam(fetch)))
    )
    expect(outcome.status).toBe("ready")
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(1)
  })

  test("callGateway sets the bearer the browser cannot, and joins the relay's PATH base", async () => {
    const { calls, fetch } = relay()
    const call = await run(callGateway("will", "will/mvp", "/rpc", { method: "POST", body: {} }).pipe(Effect.provide(seam(fetch))))
    expect(call.status).toBe("ok")
    const rpc = calls.find((entry) => entry.url.endsWith("/rpc"))
    // base_url is a PATH base — URL-joining an absolute path would drop it.
    expect(rpc?.url).toBe("https://api.smithers-cloud.test/api/gateways/gw-1/rpc")
    expect(rpc?.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`)
  })

  test("a cached record whose gateway is GONE re-provisions and retries once", async () => {
    /*
     * §5: a gateway VM can idle-suspend or be recycled, so a cached record
     * can point at a base_url that no longer answers at all. That is stale
     * state, not a dead end — the record is rebuilt and the call retried.
     * (Caught for real: a persisted record survived a restart and every
     * relay call failed "Network connection lost" forever.)
     */
    const { calls, fetch } = relay({
      provision: (_call, attempt) => freshGateway(attempt),
      gateway: (call) => {
        if (call.url.includes("/api/gateways/gw-1/")) throw new Error("Network connection lost.")
        return json(200, { ok: true, payload: [] })
      }
    })
    const call = await run(callGateway("will", "will/mvp", "/rpc", { method: "POST", body: {} }).pipe(Effect.provide(seam(fetch))))
    expect(call.status).toBe("ok")
    const rpcCalls = calls.filter((entry) => entry.url.endsWith("/rpc"))
    expect(rpcCalls).toHaveLength(2)
    expect(rpcCalls[1]?.url).toContain("/api/gateways/gw-2/")
    // Bounded: exactly two provisions, never a loop.
    expect(calls.filter((entry) => entry.url.endsWith("/gateway")).length).toBe(2)
  })

  for (const failure of ["rejected fetch", "stalled headers"] as const) {
    for (const renewalFails of [false, true]) {
      test(`a non-replayable ${failure} is sent once even when renewal ${renewalFails ? "fails" : "succeeds"}`, async () => {
        const { calls, fetch } = relay({
          provision: (_call, attempt) => {
            if (attempt === 2 && renewalFails) return json(500, { error: "no_capacity" })
            return freshGateway(attempt)
          },
          gateway: (_call, attempt, signal) => {
            if (attempt > 1) return json(200, { ok: true, payload: [] })
            if (failure === "rejected fetch") return Promise.reject(new Error("Network connection lost."))
            return silence(signal)
          }
        })
        const layer = seam(fetch)
        const launch = callGateway("will", "will/mvp", "/rpc", {
          method: "POST",
          body: { workflow: "create-workflow", input: { prompt: "x" } },
          replayable: false
        })
        const call = failure === "rejected fetch"
          ? await run(launch.pipe(Effect.provide(layer)))
          : await run(
            Effect.gen(function* () {
              // The test clock starts at the wall clock so the records it
              // mints read as fresh to the live-clock call that follows.
              yield* TestClock.setTime(Date.now())
              const sending = yield* Effect.forkChild(launch)
              // The registry provisions in its own object first; once the
              // relay call is out, the headers stall past the seam's
              // deadline, on the test clock.
              yield* untilCalled(calls, "/rpc")
              yield* TestClock.adjust("20 seconds")
              return yield* Fiber.join(sending)
            }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer())))
          )
        expect(calls.filter((entry) => entry.url.endsWith("/rpc"))).toHaveLength(1)
        expect(call.status).toBe("unknown_outcome")
        expect("detail" in call && call.detail).toContain("may have been accepted")
        expect("detail" in call && call.detail).toContain(
          failure === "rejected fetch" ? "Network connection lost." : "The workspace gateway did not answer within 20000ms."
        )
        expect(calls.filter((entry) => entry.url.endsWith("/gateway"))).toHaveLength(2)
        if (!renewalFails) {
          const next = await run(callGateway("will", "will/mvp", "/rpc", { method: "POST", body: {} }).pipe(Effect.provide(layer)))
          expect(next.status).toBe("ok")
          const rpcCalls = calls.filter((entry) => entry.url.endsWith("/rpc"))
          expect(rpcCalls).toHaveLength(2)
          expect(rpcCalls[1]?.url).toContain("/api/gateways/gw-2/")
          expect(rpcCalls[1]?.authorization).toBe(`Bearer ${GATEWAY_TOKEN}-2`)
          expect(calls.filter((entry) => entry.url.endsWith("/gateway"))).toHaveLength(2)
        }
      })
    }
  }

  test("a gateway that stays unreachable states why, once, and stops", async () => {
    const { calls, fetch } = relay({
      gateway: () => {
        throw new Error("Network connection lost.")
      }
    })
    const call = await run(callGateway("will", "will/mvp", "/rpc", { method: "POST", body: {} }).pipe(Effect.provide(seam(fetch))))
    expect(call.status).toBe("unavailable")
    // The reason is stated, never swallowed into a flat sentence.
    expect(call.status === "unavailable" && call.detail).toBe("The workspace gateway is unreachable: Network connection lost.")
    expect(calls.filter((entry) => entry.url.endsWith("/rpc"))).toHaveLength(2)
  })

  test.each([true, false])("a 401 re-provisions and retries once with fresh credentials (replayable: %s)", async (replayable) => {
    const { calls, fetch } = relay({
      provision: (_call, attempt) => freshGateway(attempt),
      gateway: (_call, attempt) =>
        attempt === 1
          ? json(401, { message: "invalid gateway credentials" })
          : json(200, { ok: true, payload: [{ key: "create-workflow" }] })
    })
    const call = await run(
      callGateway("will", "will/mvp", "/rpc", { method: "POST", body: {}, replayable }).pipe(Effect.provide(seam(fetch)))
    )
    expect(call.status).toBe("ok")
    if (call.status !== "ok") return
    expect(await call.response.json()).toEqual({ ok: true, payload: [{ key: "create-workflow" }] })
    const rpcCalls = calls.filter((entry) => entry.url.endsWith("/rpc"))
    expect(rpcCalls).toHaveLength(2)
    // The retry adopted the reprovisioned gateway, id and token both.
    expect(rpcCalls[1]?.url).toContain("/api/gateways/gw-2/")
    expect(rpcCalls[1]?.authorization).toBe(`Bearer ${GATEWAY_TOKEN}-2`)
  })

  /*
   * Caught live on canary: a gateway provisioned an hour earlier answered
   * every relay call with a Cloudflare 502 — its VM had idle-suspended (§5:
   * "VM stops; the row stays `running`, so the relay keeps 200-ing until the
   * tunnel fails. Re-POST resumes it"). Nothing re-POSTed, so the run card
   * sat in "reconnecting" for as long as the cached record lived.
   */
  test("a relay tunnel failure resumes the workspace and retries the call once", async () => {
    const { calls, fetch } = relay({
      provision: (_call, attempt) => freshGateway(attempt),
      gateway: (_call, attempt) =>
        attempt === 1
          ? new Response("error code: 502\n", { status: 502, headers: { "content-type": "text/plain" } })
          : json(200, { ok: true, payload: [{ key: "create-workflow" }] })
    })
    const layer = seam(fetch)
    // An hour-old record, exactly what a live DO holds when the VM
    // behind it has since idle-suspended.
    await seed("will", "will/mvp", {
      gatewayId: "gw-0",
      baseUrl: "https://api.smithers-cloud.test/api/gateways/gw-0",
      token: `${GATEWAY_TOKEN}-0`,
      vmId: "msb_0",
      expiresAt: Date.now() + 30 * 60 * 1000,
      renewAfter: Date.now() + 20 * 60 * 1000,
      provisionedAt: Date.now() - 60 * 60 * 1000
    })
    const call = await run(
      callGateway("will", "will/mvp", "/rpc", { method: "POST", body: { runId: "run-1" }, replayable: true }).pipe(
        Effect.provide(layer)
      )
    )
    expect(call.status).toBe("ok")
    if (call.status !== "ok") return
    expect(call.response.status).toBe(200)
    const rpcCalls = calls.filter((entry) => entry.url.endsWith("/rpc"))
    expect(rpcCalls).toHaveLength(2)
    expect(rpcCalls[1]?.url).toContain("/api/gateways/gw-")
  })

  test("a tunnel failure never replays a call a repeat could duplicate", async () => {
    const { calls, fetch } = relay({ gateway: () => new Response("error code: 502\n", { status: 502 }) })
    const layer = seam(fetch)
    await seed("will", "will/mvp", {
      gatewayId: "gw-0",
      baseUrl: "https://api.smithers-cloud.test/api/gateways/gw-0",
      token: `${GATEWAY_TOKEN}-0`,
      vmId: null,
      expiresAt: Date.now() + 30 * 60 * 1000,
      renewAfter: Date.now() + 20 * 60 * 1000,
      provisionedAt: Date.now() - 60 * 60 * 1000
    })
    const call = await run(
      callGateway("will", "will/mvp", "/rpc", {
        method: "POST",
        body: { workflow: "create-workflow", input: { prompt: "x" } },
        replayable: false
      }).pipe(Effect.provide(layer))
    )
    // The workspace was resumed for the next attempt; this one is
    // reported as what it was, and the run was never launched twice.
    expect(call).toEqual({ status: "unavailable", detail: "Your workspace had gone to sleep. It is awake again — ask me once more." })
    expect(calls.filter((entry) => entry.url.includes("/rpc"))).toHaveLength(1)
    expect(calls.filter((entry) => entry.url.endsWith("/gateway"))).toHaveLength(1)
  })

  test("a tunnel failure right after provisioning is stated, not stampeded", async () => {
    const { calls, fetch } = relay({ gateway: () => new Response("error code: 502\n", { status: 502 }) })
    const layer = seam(fetch)
    // A record minted moments ago: re-POSTing again cannot resume
    // anything, and an EventSource reconnect loop must not drive one
    // provision call per retry.
    for (let index = 0; index < 4; index += 1) {
      const call = await run(callGateway("will", "will/mvp", "/projections", { method: "GET" }).pipe(Effect.provide(layer)))
      expect(call.status).toBe("ok")
      if (call.status === "ok") expect(call.response.status).toBe(502)
    }
    expect(calls.filter((entry) => entry.url.endsWith("/gateway"))).toHaveLength(1)
  })

  test("the read-only relay asks the box the login holds and never wakes or provisions one", async () => {
    const { calls, fetch } = relay({
      gateway: (_call, attempt) => (attempt === 1 ? new Response("error code: 502\n", { status: 502 }) : undefined)
    })
    const layer = seam(fetch)
    const read = { method: "POST", text: "{}", provision: false } as const
    // No record at all: nothing is provisioned to answer a read.
    const missing = await run(callGateway("will", "will/mvp", "/rpc", read).pipe(Effect.provide(layer)))
    expect(missing).toEqual({ status: "unavailable", detail: "No live workspace holds an answer for this read." })
    await seed("will", "will/mvp", {
      gatewayId: "gw-0",
      baseUrl: "https://api.smithers-cloud.test/api/gateways/gw-0",
      token: `${GATEWAY_TOKEN}-0`,
      vmId: null,
      expiresAt: Date.now() + 30 * 60 * 1000,
      renewAfter: Date.now() + 20 * 60 * 1000,
      provisionedAt: Date.now() - 60 * 60 * 1000
    })
    // A tunnel failure to a read is stated; the VM is not resumed for it.
    const asleep = await run(callGateway("will", "will/mvp", "/rpc", read).pipe(Effect.provide(layer)))
    expect(asleep).toEqual({ status: "unavailable", detail: "The workspace gateway answered HTTP 502 to a read." })
    const awake = await run(callGateway("will", "will/mvp", "/rpc", read).pipe(Effect.provide(layer)))
    expect(awake.status).toBe("ok")
    expect(calls.filter((entry) => entry.url.endsWith("/gateway"))).toHaveLength(0)
    expect(calls.filter((entry) => entry.url.endsWith("/api/identity/cloud-token"))).toHaveLength(0)
  })
})

describe("wave 11 — what the seam refuses on its own", () => {
  /*
   * `..` matches every character a repository name may contain, and URL
   * parsing resolves it away — `POST /api/repos/../admin/gateway` becomes
   * `POST /api/admin/gateway`, carrying the user's server-held Cloud token
   * to a route this seam never allowlisted. Holding the token server-side is
   * pointless if the browser can still choose where it is spent.
   */
  test("a dot-segment repo cannot steer the Cloud token off the provision route", async () => {
    const { calls, fetch } = relay()
    for (const repo of ["../admin", "../..", "owner/..", "./config", "codeplanesmithers/.", "not-a-repo", "owner/repo/extra", ""]) {
      const direct = await run(ensureGateway("codeplanesmithers", repo).pipe(Effect.provide(seam(fetch))))
      expect(direct).toEqual({ status: "unavailable", detail: `${repo} is not a repository this seam can address.` })
    }
    // Not one call left the Worker: no Cloud token was minted, let alone spent.
    expect(calls).toHaveLength(0)
  })

  test("a dot-PREFIXED repository name is real and stays legal", async () => {
    const { fetch } = relay()
    const outcome = await run(ensureGateway("codeplanesmithers", "codeplanesmithers/.github").pipe(Effect.provide(seam(fetch))))
    expect(outcome.status).toBe("ready")
  })

  test("two logins whose keys would concatenate identically keep separate records", async () => {
    const { fetch } = relay({ provision: (_call, attempt) => freshGateway(attempt, { vm_id: `msb_${attempt}`, status: "running" }) })
    const layer = seam(fetch)
    // ("ab", "c/d") and ("a", "bc/d") concatenate to the same string.
    const first = await run(ensureGateway("ab", "c/d").pipe(Effect.provide(layer)))
    const second = await run(ensureGateway("a", "bc/d").pipe(Effect.provide(layer)))
    expect(first.status).toBe("ready")
    expect(second.status).toBe("ready")
    if (first.status !== "ready" || second.status !== "ready") return
    expect(second.record.token).not.toBe(first.record.token)
  })

  test("the relay refuses a gateway path the product does not address", async () => {
    const { calls, fetch } = relay()
    const call = await run(
      callGateway("will", "will/mvp", "/admin/tokens", { method: "POST", text: "{}" }).pipe(Effect.provide(seam(fetch)))
    )
    expect(call).toEqual({ status: "unavailable", detail: "/admin/tokens is not a gateway path this seam relays." })
    // Not one call left the Worker: no Cloud token was minted, let alone spent.
    expect(calls).toHaveLength(0)
  })
})

describe("owning workspace routing", () => {
  const first = "83e75ae5-0920-4000-8000-000000000001"
  const second = "83e75ae5-0920-4000-8000-000000000002"
  const repo = "codeplanesmithers/smithers-demo"
  const provision = (call: RelayCall): Response => {
    const workspaceId = (call.body as { workspace_id?: string } | undefined)?.workspace_id
    return json(200, {
      base_url: `https://api.smithers-cloud.test/api/gateways/${workspaceId ?? "legacy"}`,
      token: GATEWAY_TOKEN,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      gateway_id: workspaceId ?? "legacy",
      ...(workspaceId === undefined ? {} : { workspace_id: workspaceId })
    })
  }

  test("partitions legacy and two owning workspaces", async () => {
    const { calls, fetch } = relay({ provision })
    const layer = seam(fetch)
    for (const workspaceId of [undefined, first, second, first, undefined]) {
      const outcome = await run(ensureGateway("codeplanesmithers", repo, false, workspaceId).pipe(Effect.provide(layer)))
      expect(outcome.status).toBe("ready")
      if (outcome.status !== "ready") return
      expect(outcome.record.workspaceId).toBe(workspaceId)
      expect(outcome.record.gatewayId).toBe(workspaceId ?? "legacy")
    }
    const provisions = calls.filter((call) => call.url.endsWith("/gateway"))
    expect(provisions.map((call) => call.body)).toEqual([undefined, { workspace_id: first }, { workspace_id: second }])
    const call = await run(
      callGateway("codeplanesmithers", repo, "/rpc", { method: "POST", text: "{}", workspaceId: first }).pipe(Effect.provide(layer))
    )
    expect(call.status).toBe("ok")
    expect(calls.at(-1)?.url).toContain(`/api/gateways/${first}/`)
  })

  test("refuses a legacy or mismatched provision response instead of falling back to a different checkout", async () => {
    for (const returned of [undefined, second]) {
      const { fetch } = relay({
        provision: (call) => provision({ ...call, body: returned === undefined ? undefined : { workspace_id: returned } })
      })
      const result = await run(ensureGateway("codeplanesmithers", repo, false, first).pipe(Effect.provide(seam(fetch))))
      expect(result).toEqual({ status: "unavailable", detail: "Provisioning answered in a shape the gateway seam did not understand." })
    }
  })

  test("does not retry an unconfigured coding host as a normal startup delay", async () => {
    const { calls, fetch } = relay({
      provision: () => json(409, { code: "coding_host_unavailable", message: "Stage the registered coding host." })
    })
    const result = await run(ensureGateway("codeplanesmithers", repo, false, first).pipe(Effect.provide(seam(fetch))))
    expect(result).toEqual({ status: "unavailable", detail: "Stage the registered coding host." })
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(1)
  })

  test("rejects malformed bindings before provisioning and keeps read-only requests read-only", async () => {
    const { calls, fetch } = relay()
    const layer = seam(fetch)
    for (const workspaceId of ["../other", first.toUpperCase(), "00000000-0000-0000-0000-000000000000"]) {
      const result = await run(ensureGateway("codeplanesmithers", repo, false, workspaceId).pipe(Effect.provide(layer)))
      expect(result.status).toBe("unavailable")
    }
    const result = await run(
      callGateway("codeplanesmithers", repo, "/rpc", { method: "POST", text: "{}", provision: false, workspaceId: first }).pipe(
        Effect.provide(layer)
      )
    )
    expect(result.status).toBe("unavailable")
    expect(calls).toHaveLength(0)
  })
})

describe("the GatewaySessionRegistry Durable Object", () => {
  const namespaceOf = (registry: { readonly fetch: (request: Request) => Promise<Response> }): NativeNamespace => ({
    idFromName: (login) => login,
    get: () => registry
  })

  test("keeps owning workspace records separate across worker restarts, under gateway:* keys", async () => {
    const storage = memoryStorage()
    const workspaceId = "83e75ae5-0920-4000-8000-000000000003"
    const { calls, fetch } = relay({
      provision: (call) =>
        json(200, {
          base_url: "https://api.smithers-cloud.test/api/gateways/bound",
          token: GATEWAY_TOKEN,
          gateway_id: "bound",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          ...(call.body as { workspace_id?: string } | undefined)
        })
    })
    const layer = seam(fetch, { namespace: namespaceOf(registryOver(storage, fetch)) })
    expect((await run(ensureGateway("codeplanesmithers", "o/r", false, workspaceId).pipe(Effect.provide(layer)))).status).toBe("ready")
    expect((await run(ensureGateway("codeplanesmithers", "o/r").pipe(Effect.provide(layer)))).status).toBe("ready")
    // A new isolate: the object is gone, the storage behind it is not.
    const restarted = seam(fetch, { namespace: namespaceOf(registryOver(storage, fetch)) })
    const restored = await run(ensureGateway("codeplanesmithers", "o/r", false, workspaceId).pipe(Effect.provide(restarted)))
    expect(restored.status).toBe("ready")
    if (restored.status === "ready") expect(restored.record.workspaceId).toBe(workspaceId)
    expect(storage.data.size).toBe(2)
    // The persisted identities: the key format never changes.
    expect([...storage.data.keys()].sort()).toEqual(["gateway:o/r", `gateway:o/r\u0000${workspaceId}`])
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(2)
  })

  test("answers its own routes: a missing record is null, a bad write is 400, anything else 404", async () => {
    const registry = new GatewaySessionRegistry({ storage: memoryStorage() })
    const missing = await registry.fetch(new Request("https://gateway-sessions.internal/record?repo=o%2Fr"))
    expect(await missing.json()).toEqual({ record: null })
    const bad = await registry.fetch(
      new Request("https://gateway-sessions.internal/record", { method: "PUT", body: JSON.stringify({ repo: "", record: {} }) })
    )
    expect(bad.status).toBe(400)
    const unreadable = await registry.fetch(
      new Request("https://gateway-sessions.internal/record", { method: "PUT", body: "not json" })
    )
    expect(unreadable.status).toBe(400)
    const unnamed = await registry.fetch(
      new Request("https://gateway-sessions.internal/resolve", { method: "POST", body: JSON.stringify({ repo: "o/r" }) })
    )
    expect(unnamed.status).toBe(400)
    expect((await registry.fetch(new Request("https://gateway-sessions.internal/other"))).status).toBe(404)
  })

  test("a storage failure answers 500 with its message; through the seam a failed read is cold and a failed write is stated", async () => {
    const sealed: NativeStorage = {
      get: async () => {
        throw new Error("storage is sealed")
      },
      put: async () => {
        throw new Error("storage is sealed")
      }
    }
    const response = await new GatewaySessionRegistry({ storage: sealed }).fetch(
      new Request("https://gateway-sessions.internal/record?repo=o%2Fr")
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toBe("storage is sealed")
    const { calls, fetch } = relay()
    const outcome = await run(
      ensureGateway("will", "will/mvp").pipe(Effect.provide(seam(fetch, { namespace: namespaceOf(registryOver(sealed, fetch)) })))
    )
    expect(outcome).toEqual({ status: "unavailable", detail: "The gateway session store is unavailable: storage is sealed" })
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(1)
  })
})

/*
 * The credential store as deployed: one registry per login over its own
 * storage. Every case below runs the real registry Effect, recreates it over
 * retained storage (a Worker restart), and reads exact credentials back.
 */
describe("the gateway session registry", () => {
  /** A per-login storage map that survives registry instances. */
  const retainedNamespace = (fetch: FetchImplementation) => {
    const stores = new Map<string, Map<string, unknown>>()
    const failures = { get: false, put: false }
    const storageFor = (login: string): NativeStorage => {
      let data = stores.get(login)
      if (data === undefined) {
        data = new Map()
        stores.set(login, data)
      }
      const rows = data
      return {
        get: async <T>(key: string): Promise<T | undefined> => {
          if (failures.get) throw new Error("read failed")
          return rows.get(key) as T | undefined
        },
        put: async (key: string, value: unknown) => {
          if (failures.put) throw new Error("write failed")
          rows.set(key, value)
        }
      }
    }
    const instances = new Map<string, ReturnType<typeof registryOver>>()
    const namespace: NativeNamespace = {
      idFromName: (login) => login,
      get: (id) => {
        const login = String(id)
        let registry = instances.get(login)
        if (registry === undefined) {
          registry = registryOver(storageFor(login), fetch)
          instances.set(login, registry)
        }
        return registry
      }
    }
    return { namespace, stores, failures, restart: () => instances.clear() }
  }

  const provisionEach = (call: RelayCall, attempt: number): Response => {
    const [, owner, repo] = /\/api\/repos\/([^/]+)\/([^/]+)\/gateway$/.exec(new URL(call.url).pathname) ?? []
    const login = call.authorization?.replace("Bearer cloud-", "") ?? "?"
    return json(200, {
      base_url: `https://api.smithers-cloud.test/api/gateways/${login}-${owner}-${repo}-${attempt}`,
      token: `${GATEWAY_TOKEN}-${login}-${owner}-${repo}-${attempt}`,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      gateway_id: `${login}-${owner}-${repo}-${attempt}`
    })
  }
  const tokenEach = (call: RelayCall): Response =>
    json(200, { found: true, token: `cloud-${(call.body as { login: string }).login}` })

  const ready = async (layer: Layer.Layer<any>, login: string, repo: string, force = false): Promise<GatewayRecord> => {
    const outcome = await run(ensureGateway(login, repo, force).pipe(Effect.provide(layer)))
    expect(outcome.status).toBe("ready")
    if (outcome.status !== "ready") throw new Error(outcome.status)
    return outcome.record
  }

  const age = (namespace: NativeNamespace, login: string, repo: string, record: GatewayRecord): Promise<Response> =>
    namespace.get(namespace.idFromName(login)).fetch(
      new Request("https://gateway-sessions.internal/record", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, record: { ...record, renewAfter: Date.now() - 1 } })
      })
    )

  test("round-trips exact credentials per login and repository across restarts, provision and renewal", async () => {
    const { calls, fetch } = relay({ cloudToken: tokenEach, provision: provisionEach })
    const retained = retainedNamespace(fetch)
    const layer = seam(fetch, { namespace: retained.namespace })
    const minted = new Map<string, GatewayRecord>()
    for (const login of ["alice", "bob"]) {
      for (const repo of ["org/one", "org/two"]) minted.set(`${login} ${repo}`, await ready(layer, login, repo))
    }
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(4)
    expect(retained.stores.get("alice")?.size).toBe(2)
    expect(retained.stores.get("bob")?.size).toBe(2)

    // Each record names its own login and repository, nothing else's.
    retained.restart()
    for (const [key, record] of minted) {
      const [login, repo] = key.split(" ") as [string, string]
      const [owner, name] = repo.split("/")
      const restored = await ready(layer, login, repo)
      expect(restored).toEqual(record)
      expect(restored.gatewayId).toMatch(new RegExp(`^${login}-${owner}-${name}-\\d+$`))
      expect(restored.baseUrl).toBe(`https://api.smithers-cloud.test/api/gateways/${restored.gatewayId}`)
      expect(restored.token).toBe(`${GATEWAY_TOKEN}-${restored.gatewayId}`)
    }
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(4)

    // Renewal replaces exactly the expired record and adopts what came back.
    const aged = minted.get("alice org/one")!
    await age(retained.namespace, "alice", "org/one", aged)
    const renewed = await ready(layer, "alice", "org/one")
    expect(renewed.gatewayId).not.toBe(aged.gatewayId)
    expect(renewed.gatewayId).toMatch(/^alice-org-one-\d+$/)
    expect(renewed.token).toBe(`${GATEWAY_TOKEN}-${renewed.gatewayId}`)
    retained.restart()
    expect(await ready(layer, "alice", "org/one")).toEqual(renewed)
    expect(await ready(layer, "alice", "org/two")).toEqual(minted.get("alice org/two")!)
    expect(await ready(layer, "bob", "org/one")).toEqual(minted.get("bob org/one")!)
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(5)

    // A forced refresh re-provisions even a fresh record.
    const forced = await ready(layer, "bob", "org/two", true)
    expect(forced.gatewayId).not.toBe(minted.get("bob org/two")!.gatewayId)
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(6)
  })

  test("serves a legacy record without provisionedAt and treats storage failures as cold or unavailable", async () => {
    const { calls, fetch } = relay({ cloudToken: tokenEach, provision: provisionEach })
    const retained = retainedNamespace(fetch)
    const layer = seam(fetch, { namespace: retained.namespace })
    const now = Date.now()
    const legacy = {
      gatewayId: "legacy", baseUrl: "https://api.smithers-cloud.test/api/gateways/legacy",
      token: `${GATEWAY_TOKEN}-legacy`, vmId: null, expiresAt: now + 3_600_000, renewAfter: now + 1_800_000
    }
    await retained.namespace.get("alice").fetch(new Request("https://gateway-sessions.internal/record", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/legacy", record: legacy })
    }))
    expect(await ready(layer, "alice", "org/legacy")).toEqual({ ...legacy, provisionedAt: 0 })
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(0)

    retained.failures.put = true
    const unwritable = await run(ensureGateway("alice", "org/fresh").pipe(Effect.provide(layer)))
    expect(unwritable).toEqual({ status: "unavailable", detail: "The gateway session store is unavailable: write failed" })
    retained.failures.put = false

    retained.failures.get = true
    const reprovisioned = await ready(layer, "alice", "org/legacy")
    expect(reprovisioned.gatewayId).not.toBe("legacy")
    retained.failures.get = false
    expect(await ready(layer, "alice", "org/legacy")).toEqual(reprovisioned)
  })

  for (const state of ["cold", "expired"] as const) {
    test(`${state} concurrent misses for one login and repository share a single provisioning`, async () => {
      const { calls, fetch } = relay({ cloudToken: tokenEach, provision: provisionEach })
      const retained = retainedNamespace(fetch)
      const layer = seam(fetch, { namespace: retained.namespace })
      if (state === "expired") {
        const stale = await ready(layer, "alice", "org/one")
        await age(retained.namespace, "alice", "org/one", stale)
        calls.length = 0
      }
      const records = await Promise.all(Array.from({ length: 8 }, () => ready(layer, "alice", "org/one")))
      const others = await Promise.all([ready(layer, "alice", "org/two"), ready(layer, "bob", "org/one")])
      expect(calls.filter((call) => call.url.endsWith("/api/identity/cloud-token"))).toHaveLength(3)
      expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(3)
      for (const record of records) expect(record).toEqual(records[0])
      expect(records[0]!.gatewayId).toMatch(/^alice-org-one-\d+$/)
      expect(new Set([records[0]!.gatewayId, ...others.map((record) => record.gatewayId)]).size).toBe(3)
      retained.restart()
      expect(await ready(layer, "alice", "org/one")).toEqual(records[0]!)
    })
  }

  test("a joiner adopts the outcome of a failed provisioning instead of retrying it", async () => {
    const { calls, fetch } = relay({ cloudToken: tokenEach, provision: () => json(500, { error: "no_capacity" }) })
    const retained = retainedNamespace(fetch)
    const layer = seam(fetch, { namespace: retained.namespace })
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => run(ensureGateway("alice", "org/one").pipe(Effect.provide(layer))))
    )
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0])
    expect(outcomes[0]?.status).toBe("no_capacity")
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(1)
    expect(retained.stores.get("alice")?.size ?? 0).toBe(0)
  })
})
