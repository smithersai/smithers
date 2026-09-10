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
 */
import { afterEach, describe, expect, test } from "bun:test"
import { callGateway, GatewaySessionRegistry, ensureGateway, fetchCloudToken } from "./gateway"
import type { GatewayRecord, GatewayRegistryEnv } from "./gateway"
import { ALLOWED_GATEWAY_PROCEDURES } from "./gatewayRpc"
import worker from "./index"
import type { WorkerEnv } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

const GATEWAY_TOKEN = "smithers_gateway_secret-operator-token"
const CLOUD_TOKEN = "smithers_pat_cloud-identity"

const BASE_ENV = {
  ASSETS: { fetch: async () => new Response("<html></html>", { status: 200 }) },
  IDENTITY_UPSTREAM_URL: "https://identity.test",
  IDENTITY_SERVICE_TOKEN: "service-token",
  SMITHERS_CLOUD_API_BASE_URL: "https://api.smithers-cloud.test"
}

/*
 * The Durable Object bindings are the REAL classes over in-memory storage,
 * one fixture per test: records persist across `env()` calls inside a test
 * (a deployment keeps them across Worker requests) and vanish between tests.
 * The registry runs the resolution itself, so the first `env()` of a test
 * fixes the settings it resolves with.
 */
let durable: ReturnType<typeof memoryDurableObjects> | undefined
const env = (extra: Partial<WorkerEnv> = {}): WorkerEnv => {
  const settings = { ...BASE_ENV, ...extra }
  durable ??= memoryDurableObjects(settings)
  return { GATEWAY_SESSIONS: durable.GATEWAY_SESSIONS, TURN_CANCELS: durable.TURN_CANCELS, ...settings }
}
const seedRecord = (login: string, repo: string, record: GatewayRecord): Promise<void> => {
  env()
  return durable!.seedGatewayRecord(login, repo, record)
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface RelayCall {
  readonly url: string
  readonly method: string
  readonly authorization: string | null
  readonly serviceToken: string | null
  readonly body: unknown
}

/**
 * The relay double: the identity cloud-token door plus the Cloud provision
 * route and a per-gateway RPC/REST surface, each answering the exact shapes
 * the receipts recorded. `script` lets a test bend one leg at a time.
 */
const withRelay = async (
  script: {
    readonly cloudToken?: (call: RelayCall, attempt: number) => Response | undefined
    readonly provision?: (call: RelayCall, attempt: number) => Response | undefined
    readonly gateway?: (call: RelayCall, attempt: number, signal: AbortSignal) => Response | undefined | Promise<Response>
  },
  run: (calls: RelayCall[]) => Promise<void>
): Promise<void> => {
  const calls: RelayCall[] = []
  const attempts = { cloudToken: 0, provision: 0, gateway: 0 }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = typeof input === "string"
      ? new Request(input, init)
      : input instanceof URL
      ? new Request(input.toString(), init)
      : (input as Request)
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
        script.provision?.(call, attempts.provision) ??
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
      return script.gateway?.(call, attempts.gateway, request.signal) ?? json(200, { ok: true, apiVersion: "v1", payload: [] })
    }
    if (url.hostname === "identity.test") {
      // The session probe every workflow route gates on.
      return json(200, { login: "codeplanesmithers", allowlisted: true, admin: false })
    }
    return originalFetch(request)
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

const signedIn = (path: string, init?: RequestInit): Request =>
  new Request(`https://mvp.test${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie: "smithers_session=abc", ...(init?.headers ?? {}) }
  })

afterEach(() => {
  durable = undefined
})

describe("wave 11 — provision-or-resume (§5)", () => {
  test("provisions with the user's Cloud token, adopts what comes back, and caches to the half-life", async () => {
    await withRelay({}, async (calls) => {
      const first = await ensureGateway(env(), "codeplanesmithers", "codeplanesmithers/smithers-demo")
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
      const second = await ensureGateway(env(), "codeplanesmithers", "codeplanesmithers/smithers-demo")
      expect(second.status).toBe("ready")
      expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
    })
  })

  test("a resolved Durable Object write failure cannot report the gateway ready", async () => {
    await withRelay({}, async (calls) => {
      const registry = new GatewaySessionRegistry({ storage: {
        get: async () => undefined,
        put: async () => { throw new Error("storage unavailable") }
      } }, BASE_ENV)
      const outcome = await ensureGateway(
        env({ GATEWAY_SESSIONS: { idFromName: (name) => name, get: () => registry } }),
        "will",
        "will/mvp"
      )
      expect(outcome.status).toBe("unavailable")
      expect(outcome.status === "unavailable" && outcome.detail).toContain("storage unavailable")
      // The relay was asked, the record was minted, and it is not reported.
      expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(1)
    })
  })

  test("a session store that cannot be reached cannot report the gateway ready", async () => {
    await withRelay({}, async (calls) => {
      const outcome = await ensureGateway(
        env({ GATEWAY_SESSIONS: { idFromName: (name) => name, get: () => ({ fetch: async () => { throw new Error("DO unreachable") } }) } }),
        "will",
        "will/mvp"
      )
      expect(outcome.status).toBe("unavailable")
      expect(outcome.status === "unavailable" && outcome.detail).toContain("DO unreachable")
      expect(calls).toHaveLength(0)
      const refused = await ensureGateway(
        env({ GATEWAY_SESSIONS: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response("overloaded", { status: 503 }) }) } }),
        "will",
        "will/mvp"
      )
      expect(refused.status).toBe("unavailable")
      expect(refused.status === "unavailable" && refused.detail).toContain("HTTP 503")
    })
  })

  test("a renew adopts a DIFFERENT gateway id, token and base url — nothing is assumed unchanged", async () => {
    // §5 item 3: the reprovision path legitimately hands back a different
    // gateway; every cached URL must be rebuilt from what came back.
    await withRelay(
      {
        provision: (_call, attempt) =>
          json(200, {
            base_url: `https://api.smithers-cloud.test/api/gateways/gw-${attempt}`,
            token: `${GATEWAY_TOKEN}-${attempt}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            gateway_id: `gw-${attempt}`,
            vm_id: `msb_${attempt}`
          })
      },
      async () => {
        const first = await ensureGateway(env(), "will", "will/mvp")
        expect(first.status === "ready" && first.record.gatewayId).toBe("gw-1")
        // The renew path (what a relay 401 and a past-half-life record both take).
        const second = await ensureGateway(env(), "will", "will/mvp", true)
        expect(second.status === "ready" && second.record.gatewayId).toBe("gw-2")
        expect(second.status === "ready" && second.record.token).toBe(`${GATEWAY_TOKEN}-2`)
        expect(second.status === "ready" && second.record.baseUrl).toBe(
          "https://api.smithers-cloud.test/api/gateways/gw-2"
        )
        // And the renewed record is what a later resolve reads back.
        const third = await ensureGateway(env(), "will", "will/mvp")
        expect(third.status === "ready" && third.record.gatewayId).toBe("gw-2")
      }
    )
  })

  test("a bogus short expires_at cannot spin the provision loop — the renew floor holds", async () => {
    // The relay's `expires_at` is advisory (§5: always now + 1h, never
    // checked). A garbage timestamp must not turn the half-life cadence
    // into a per-call provision stampede, so the floor is a real minimum.
    await withRelay(
      {
        provision: () =>
          json(200, {
            base_url: "https://api.smithers-cloud.test/api/gateways/gw-1",
            token: GATEWAY_TOKEN,
            expires_at: new Date(Date.now() + 2).toISOString(),
            gateway_id: "gw-1"
          })
      },
      async (calls) => {
        const first = await ensureGateway(env(), "will", "will/mvp")
        expect(first.status === "ready" && first.record.renewAfter - Date.now()).toBeGreaterThan(30_000)
        await new Promise((resolve) => setTimeout(resolve, 5))
        await ensureGateway(env(), "will", "will/mvp")
        await ensureGateway(env(), "will", "will/mvp")
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
      }
    )
  })

  test("409 is 'still provisioning' — surfaced for the caller to poll, never stampeded", async () => {
    await withRelay(
      { provision: () => new Response("repo gateway provisioning is still in progress", { status: 409 }) },
      async (calls) => {
        const outcome = await ensureGateway(env(), "will", "will/mvp")
        expect(outcome.status).toBe("provisioning")
        // Exactly ONE provision attempt: this seam does not retry-loop.
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
      }
    )
  })

  /*
   * Repro apps/ui/canary-repros/honesty/22.6: Smithers Cloud accepted the
   * provision POST and never answered, so the route hung past 70s and the
   * product left "Preparing your <repo> workspace…" standing with no run
   * card, no timeout and no error. A deadline turns silence into one of the
   * seam's own honest states — the request always ANSWERS.
   */
  test("a provision upstream that never answers becomes an honest state, not a hang", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url)
      if (url.pathname === "/api/identity/cloud-token") {
        return json(200, { found: true, token: CLOUD_TOKEN })
      }
      // The exact canary shape: the connection is accepted and nothing
      // ever comes back. Only the seam's own deadline ends this.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")))
      })
    }) as typeof fetch
    try {
      const started = Date.now()
      const outcome = await ensureGateway(
        env({ UPSTREAM_TIMEOUT_MS: "150" }),
        "codeplanesmithers",
        "codeplanesmithers/canary-sandbox"
      )
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(outcome.status).toBe("provisioning")
      if (outcome.status === "provisioning") {
        expect(outcome.detail).toContain("codeplanesmithers/canary-sandbox")
        expect(outcome.detail).toContain("longer than")
        expect(outcome.detail).toContain("150ms")
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("the provision ROUTE answers a state a client can act on when Cloud stays silent", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url)
      if (url.pathname === "/api/identity/validate") {
        return json(200, { login: "codeplanesmithers", allowlisted: true, admin: false })
      }
      if (url.pathname === "/api/identity/cloud-token") {
        return json(200, { found: true, token: CLOUD_TOKEN })
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")))
      })
    }) as typeof fetch
    try {
      const response = await worker.fetch(
        signedIn("/api/workflow/provision", {
          method: "POST",
          body: JSON.stringify({ repo: "codeplanesmithers/canary-sandbox" })
        }),
        env({ UPSTREAM_TIMEOUT_MS: "150" })
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as { status: string; message: string }
      expect(body.status).toBe("provisioning")
      expect(body.message).toContain("codeplanesmithers/canary-sandbox")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("500 no_capacity is surfaced honestly and never retried", async () => {
    await withRelay(
      { provision: () => json(500, { error: "no_capacity", message: "no worker has capacity" }) },
      async (calls) => {
        const outcome = await ensureGateway(env(), "will", "will/mvp")
        expect(outcome.status).toBe("no_capacity")
        expect(outcome.status === "no_capacity" && outcome.detail).toContain("no free workspace capacity")
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
      }
    )
  })

  test("429 quota_exceeded is the same honest no-capacity truth, not a leaked status code", async () => {
    // Caught live on canary while verifying wave 12: the pool's other refusal
    // shape is `429 {"code":"quota_exceeded","message":"concurrent sandboxes
    // limit reached"}`, which used to surface as "answered HTTP 429: {…}".
    await withRelay(
      {
        provision: () => json(429, { code: "quota_exceeded", message: "concurrent sandboxes limit reached" })
      },
      async (calls) => {
        const outcome = await ensureGateway(env(), "will", "will/mvp")
        expect(outcome.status).toBe("no_capacity")
        expect(outcome.status === "no_capacity" && outcome.detail).toContain("no free workspace capacity")
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
      }
    )
  })

  test("a repo with no Smithers Cloud counterpart is its own state, not a raw HTTP failure", async () => {
    // Wave 12 §4: the watched set is a GITHUB set. A watched repo that has no
    // Cloud repository behind it answers 404 — a distinct, un-retryable state
    // the product states in its own words instead of leaking the status code.
    await withRelay(
      { provision: () => json(404, { error: "not_found", message: "repository not found" }) },
      async (calls) => {
        const outcome = await ensureGateway(env(), "will", "will/mvp")
        expect(outcome.status).toBe("no_cloud_repo")
        expect(outcome.status === "no_cloud_repo" && outcome.detail).toContain("isn't on Smithers Cloud yet")
        // Stated once; never retry-looped.
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
      }
    )
  })

  test("the browser sees no-cloud-repo as a 200 state, not a 502", async () => {
    await withRelay(
      { provision: () => json(404, { error: "not_found" }) },
      async () => {
        const response = await worker.fetch(
          signedIn("/api/workflow/provision", { method: "POST", body: JSON.stringify({ repo: "will/mvp" }) }),
          env()
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as { status?: string; message?: string }
        expect(body.status).toBe("no-cloud-repo")
        expect(body.message).toContain("isn't on Smithers Cloud yet")
      }
    )
  })

  test("401 re-mints the Cloud token through the door and retries exactly ONCE", async () => {
    await withRelay(
      { provision: (_call, attempt) => (attempt <= 2 ? new Response("unauthorized", { status: 401 }) : undefined) },
      async (calls) => {
        const outcome = await ensureGateway(env(), "will", "will/mvp")
        expect(outcome.status).toBe("unavailable")
        // One re-mint, two provision attempts — bounded, not a loop.
        expect(calls.filter((call) => call.url.endsWith("/api/identity/cloud-token")).length).toBe(2)
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(2)
      }
    )
  })

  test("no Cloud identity is stated as itself, not as a generic failure", async () => {
    await withRelay(
      {
        cloudToken: () => json(200, { valid: true, found: false, cloud: { status: "no_github_token", reason: null } })
      },
      async (calls) => {
        const outcome = await ensureGateway(env(), "will", "will/mvp")
        expect(outcome.status).toBe("no_cloud_token")
        expect(outcome.status === "no_cloud_token" && outcome.detail).toContain("no_github_token")
        // Nothing was provisioned on a missing identity.
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(0)
      }
    )
  })

  test("callGateway sets the bearer the browser cannot, and joins the relay's PATH base", async () => {
    await withRelay({}, async (calls) => {
      const call = await callGateway(env(), "will", "will/mvp", "/rpc", {
        method: "POST",
        body: {}
      })
      expect(call.status).toBe("ok")
      const rpc = calls.find((entry) => entry.url.endsWith("/rpc"))
      // base_url is a PATH base — URL-joining an absolute path would drop it.
      expect(rpc?.url).toBe("https://api.smithers-cloud.test/api/gateways/gw-1/rpc")
      expect(rpc?.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`)
    })
  })

  test("a cached record whose gateway is GONE re-provisions and retries once", async () => {
    /*
     * §5: a gateway VM can idle-suspend or be recycled, so a cached record
     * can point at a base_url that no longer answers at all. That is stale
     * state, not a dead end — the record is rebuilt and the call retried.
     * (Caught for real: a persisted record survived a restart and every
     * relay call failed "Network connection lost" forever.)
     */
    await withRelay(
      {
        provision: (_call, attempt) =>
          json(200, {
            base_url: `https://api.smithers-cloud.test/api/gateways/gw-${attempt}`,
            token: `${GATEWAY_TOKEN}-${attempt}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            gateway_id: `gw-${attempt}`
          }),
        gateway: (call) => {
          if (call.url.includes("/api/gateways/gw-1/")) throw new Error("Network connection lost.")
          return json(200, { ok: true, payload: [] })
        }
      },
      async (calls) => {
        const call = await callGateway(env(), "will", "will/mvp", "/rpc", {
          method: "POST",
          body: {}
        })
        expect(call.status).toBe("ok")
        const rpcCalls = calls.filter((entry) => entry.url.endsWith("/rpc"))
        expect(rpcCalls).toHaveLength(2)
        expect(rpcCalls[1]?.url).toContain("/api/gateways/gw-2/")
        // Bounded: exactly two provisions, never a loop.
        expect(calls.filter((entry) => entry.url.endsWith("/gateway")).length).toBe(2)
      }
    )
  })

  for (const failure of ["rejected fetch", "stalled headers"] as const) {
    for (const renewalFails of [false, true]) {
      test(`a non-replayable ${failure} is sent once even when renewal ${renewalFails ? "fails" : "succeeds"}`, async () => {
        await withRelay(
          {
            provision: (_call, attempt) => {
              if (attempt === 2 && renewalFails) return json(500, { error: "no_capacity" })
              return json(200, {
                base_url: `https://api.smithers-cloud.test/api/gateways/gw-${attempt}`,
                token: `${GATEWAY_TOKEN}-${attempt}`,
                expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                gateway_id: `gw-${attempt}`
              })
            },
            gateway: (_call, attempt, signal) => {
              if (attempt > 1) return json(200, { ok: true, payload: [] })
              if (failure === "rejected fetch") return Promise.reject(new Error("Network connection lost."))
              return new Promise<Response>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true })
              })
            }
          },
          async (calls) => {
            const call = await callGateway(env({ UPSTREAM_TIMEOUT_MS: "150" }), "will", "will/mvp", "/rpc", {
              method: "POST",
              body: { workflow: "create-workflow", input: { prompt: "x" } },
              replayable: false
            })
            expect(calls.filter((entry) => entry.url.endsWith("/rpc"))).toHaveLength(1)
            expect(call.status).toBe("unknown_outcome")
            expect("detail" in call && call.detail).toContain("may have been accepted")
            expect("detail" in call && call.detail).toContain(
              failure === "rejected fetch" ? "Network connection lost." : "did not answer within"
            )
            expect(calls.filter((entry) => entry.url.endsWith("/gateway"))).toHaveLength(2)
            if (!renewalFails) {
              const next = await callGateway(env(), "will", "will/mvp", "/rpc", { method: "POST", body: {} })
              expect(next.status).toBe("ok")
              const rpcCalls = calls.filter((entry) => entry.url.endsWith("/rpc"))
              expect(rpcCalls).toHaveLength(2)
              expect(rpcCalls[1]?.url).toContain("/api/gateways/gw-2/")
              expect(rpcCalls[1]?.authorization).toBe(`Bearer ${GATEWAY_TOKEN}-2`)
              expect(calls.filter((entry) => entry.url.endsWith("/gateway"))).toHaveLength(2)
            }
          }
        )
      })
    }
  }

  test("a gateway that stays unreachable states why, once, and stops", async () => {
    await withRelay(
      {
        gateway: () => {
          throw new Error("Network connection lost.")
        }
      },
      async (calls) => {
        const call = await callGateway(env(), "will", "will/mvp", "/rpc", {
          method: "POST",
          body: {}
        })
        expect(call.status).toBe("unavailable")
        // The reason is stated, never swallowed into a flat sentence.
        expect(call.status === "unavailable" && call.detail).toContain("Network connection lost.")
        expect(calls.filter((entry) => entry.url.endsWith("/rpc"))).toHaveLength(2)
      }
    )
  })

  test.each([true, false])("a 401 re-provisions and retries once with fresh credentials (replayable: %s)", async (replayable) => {
    await withRelay(
      {
        provision: (_call, attempt) =>
          json(200, {
            base_url: `https://api.smithers-cloud.test/api/gateways/gw-${attempt}`,
            token: `${GATEWAY_TOKEN}-${attempt}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            gateway_id: `gw-${attempt}`
          }),
        gateway: (_call, attempt) =>
          attempt === 1
            ? json(401, { message: "invalid gateway credentials" })
            : json(200, { ok: true, payload: [{ key: "create-workflow" }] })
      },
      async (calls) => {
        const call = await callGateway(env(), "will", "will/mvp", "/rpc", {
          method: "POST",
          body: {},
          replayable
        })
        expect(call.status).toBe("ok")
        if (call.status !== "ok") return
        expect(await call.response.json()).toEqual({ ok: true, payload: [{ key: "create-workflow" }] })
        const rpcCalls = calls.filter((entry) => entry.url.endsWith("/rpc"))
        expect(rpcCalls).toHaveLength(2)
        // The retry adopted the reprovisioned gateway, id and token both.
        expect(rpcCalls[1]?.url).toContain("/api/gateways/gw-2/")
        expect(rpcCalls[1]?.authorization).toBe(`Bearer ${GATEWAY_TOKEN}-2`)
      }
    )
  })
  /*
   * Caught live on canary: a gateway provisioned an hour earlier answered
   * every relay call with a Cloudflare 502 — its VM had idle-suspended (§5:
   * "VM stops; the row stays `running`, so the relay keeps 200-ing until the
   * tunnel fails. Re-POST resumes it"). Nothing re-POSTed, so the run card
   * sat in "reconnecting" for as long as the cached record lived.
   */
  test("a relay tunnel failure resumes the workspace and retries the call once", async () => {
    await withRelay(
      {
        provision: (_call, attempt) =>
          json(200, {
            base_url: `https://api.smithers-cloud.test/api/gateways/gw-${attempt}`,
            token: `${GATEWAY_TOKEN}-${attempt}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            gateway_id: `gw-${attempt}`
          }),
        gateway: (_call, attempt) =>
          attempt === 1
            ? new Response("error code: 502\n", { status: 502, headers: { "content-type": "text/plain" } })
            : json(200, { ok: true, payload: [{ key: "create-workflow" }] })
      },
      async (calls) => {
        // An hour-old record, exactly what a live DO holds when the VM
        // behind it has since idle-suspended.
        await seedRecord("will", "will/mvp", {
          gatewayId: "gw-0",
          baseUrl: "https://api.smithers-cloud.test/api/gateways/gw-0",
          token: `${GATEWAY_TOKEN}-0`,
          vmId: "msb_0",
          expiresAt: Date.now() + 30 * 60 * 1000,
          renewAfter: Date.now() + 20 * 60 * 1000,
          provisionedAt: Date.now() - 60 * 60 * 1000
        })

        const call = await callGateway(env(), "will", "will/mvp", "/rpc", {
          method: "POST",
          body: { runId: "run-1" },
          replayable: true
        })
        expect(call.status).toBe("ok")
        if (call.status !== "ok") return
        expect(call.response.status).toBe(200)
        const rpcCalls = calls.filter((entry) => entry.url.endsWith("/rpc"))
        expect(rpcCalls).toHaveLength(2)
        expect(rpcCalls[1]?.url).toContain("/api/gateways/gw-")
      }
    )
  })

  test("a tunnel failure never replays a call a repeat could duplicate", async () => {
    await withRelay(
      {
        gateway: () => new Response("error code: 502\n", { status: 502 })
      },
      async (calls) => {
        await seedRecord("will", "will/mvp", {
          gatewayId: "gw-0",
          baseUrl: "https://api.smithers-cloud.test/api/gateways/gw-0",
          token: `${GATEWAY_TOKEN}-0`,
          vmId: null,
          expiresAt: Date.now() + 30 * 60 * 1000,
          renewAfter: Date.now() + 20 * 60 * 1000,
          provisionedAt: Date.now() - 60 * 60 * 1000
        })
        const call = await callGateway(env(), "will", "will/mvp", "/rpc", {
          method: "POST",
          body: { workflow: "create-workflow", input: { prompt: "x" } },
          replayable: false
        })
        // The workspace was resumed for the next attempt; this one is
        // reported as what it was, and the run was never launched twice.
        expect(call.status).toBe("unavailable")
        expect(call.status === "unavailable" && call.detail).toContain("gone to sleep")
        expect(calls.filter((entry) => entry.url.includes("/rpc"))).toHaveLength(1)
      }
    )
  })

  test("a tunnel failure right after provisioning is stated, not stampeded", async () => {
    await withRelay(
      {
        gateway: () => new Response("error code: 502\n", { status: 502 })
      },
      async (calls) => {
        // A record minted moments ago: re-POSTing again cannot resume
        // anything, and an EventSource reconnect loop must not drive one
        // provision call per retry.
        for (let index = 0; index < 4; index += 1) {
          const call = await callGateway(env(), "will", "will/mvp", "/projections", {
            method: "GET"
          })
          expect(call.status).toBe("ok")
          if (call.status === "ok") expect(call.response.status).toBe(502)
        }
        expect(calls.filter((entry) => entry.url.endsWith("/gateway"))).toHaveLength(1)
      }
    )
  })
})

describe("wave 11 — the /api/workflow/* routes", () => {
  test("provision answers the gateway id and cadence — and NEVER the token", async () => {
    await withRelay({}, async () => {
      const response = await worker.fetch(
        signedIn("/api/workflow/provision", {
          method: "POST",
          body: JSON.stringify({ repo: "codeplanesmithers/smithers-demo" })
        }),
        env()
      )
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(JSON.parse(text)).toMatchObject({ status: "ready", gatewayId: "gw-1" })
      // The one invariant that matters most on this seam.
      expect(text).not.toContain(GATEWAY_TOKEN)
      expect(text).not.toContain(CLOUD_TOKEN)
      expect(text).not.toContain("smithers_gateway")
    })
  })

  test("a signed-out caller gets 401 and nothing is provisioned", async () => {
    const originalFetch = globalThis.fetch
    let provisions = 0
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const request = typeof input === "string" ? new Request(input, init) : (input as Request)
      if (new URL(request.url).pathname.endsWith("/gateway")) provisions += 1
      return json(401, { error: "unauthorized" })
    }) as typeof fetch
    try {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/workflow/provision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo: "will/mvp" })
        }),
        env()
      )
      expect(response.status).toBe(401)
      expect(provisions).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("the rpc relay refuses any procedure outside the allowlist before touching the gateway", async () => {
    await withRelay({}, async (calls) => {
      const refused = await worker.fetch(
        signedIn("/api/workflow/rpc", {
          method: "POST",
          body: JSON.stringify({ repo: "will/mvp", procedure: "RunShell", payload: { cmd: "rm -rf /" } })
        }),
        env()
      )
      expect(refused.status).toBe(400)
      expect(((await refused.json()) as { message: string }).message).toContain("does not relay RunShell")

      // A call that names no procedure at all is refused the same way.
      const unnamed = await worker.fetch(
        signedIn("/api/workflow/rpc", { method: "POST", body: JSON.stringify({ repo: "will/mvp" }) }),
        env()
      )
      expect(unnamed.status).toBe(400)
      expect(calls.filter((call) => call.url.includes("/api/gateways/"))).toHaveLength(0)
    })
    // The allowlist is exactly the product's floor. Nothing else crosses.
    expect([...ALLOWED_GATEWAY_PROCEDURES].sort()).toEqual([
      "Approval.Submit",
      "Cancel",
      "List",
      "Plan",
      "Projection.Snapshot",
      "Resume",
      "Run",
      "Signal",
      "Steer"
    ])
  })

  test("a malformed repo is refused before any upstream call", async () => {
    await withRelay({}, async (calls) => {
      for (const repo of ["not-a-repo", "../../etc/passwd", "owner/repo/extra", ""]) {
        const response = await worker.fetch(
          signedIn("/api/workflow/rpc", {
            method: "POST",
            body: JSON.stringify({ repo, procedure: "List", payload: { _tag: "runs" } })
          }),
          env()
        )
        expect(response.status).toBe(400)
      }
      expect(calls.filter((call) => call.url.includes("/api/gateways/"))).toHaveLength(0)
    })
  })

  /*
   * `..` matches every character a repository name may contain, and URL
   * parsing resolves it away — `POST /api/repos/../admin/gateway` becomes
   * `POST /api/admin/gateway`, carrying the user's server-held Cloud token
   * to a route this seam never allowlisted. Holding the token server-side is
   * pointless if the browser can still choose where it is spent.
   */
  test("a dot-segment repo cannot steer the Cloud token off the provision route", async () => {
    await withRelay({}, async (calls) => {
      for (const repo of ["../admin", "../..", "owner/..", "./config", "codeplanesmithers/."]) {
        const rpc = await worker.fetch(
          signedIn("/api/workflow/rpc", {
            method: "POST",
            body: JSON.stringify({ repo, procedure: "List", payload: { _tag: "runs" } })
          }),
          env()
        )
        expect(rpc.status).toBe(400)
        const provision = await worker.fetch(
          signedIn("/api/workflow/provision", { method: "POST", body: JSON.stringify({ repo }) }),
          env()
        )
        expect(provision.status).toBe(400)
      }
      // Not one call left the Worker: no Cloud token was minted, let alone spent.
      expect(calls.filter((call) => call.url.includes("/api/repos/"))).toHaveLength(0)
      expect(calls.filter((call) => call.url.endsWith("/api/identity/cloud-token"))).toHaveLength(0)
    })
    // The seam refuses it again on its own, whatever the caller did.
    const direct = await ensureGateway(env(), "codeplanesmithers", "../admin")
    expect(direct.status).toBe("unavailable")
  })

  test("a dot-PREFIXED repository name is real and stays legal", async () => {
    await withRelay({}, async () => {
      const outcome = await ensureGateway(env(), "codeplanesmithers", "codeplanesmithers/.github")
      expect(outcome.status).toBe("ready")
    })
  })

  test("two logins whose keys would concatenate identically keep separate records", async () => {
    await withRelay(
      {
        provision: (_call, attempt) =>
          json(200, {
            base_url: `https://api.smithers-cloud.test/api/gateways/gw-${attempt}`,
            token: `${GATEWAY_TOKEN}-${attempt}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            gateway_id: `gw-${attempt}`,
            vm_id: `msb_${attempt}`,
            status: "running"
          })
      },
      async () => {
        // ("ab", "c/d") and ("a", "bc/d") concatenate to the same string.
        const first = await ensureGateway(env(), "ab", "c/d")
        const second = await ensureGateway(env(), "a", "bc/d")
        expect(first.status).toBe("ready")
        expect(second.status).toBe("ready")
        if (first.status !== "ready" || second.status !== "ready") return
        expect(second.record.token).not.toBe(first.record.token)
      }
    )
  })

  test("a projection read reaches the gateway's projections mount under the seam's bearer", async () => {
    await withRelay(
      {
        gateway: () =>
          new Response(
            `${
              JSON.stringify({
                _tag: "Exit",
                requestId: 1,
                exit: { _tag: "Success", value: { cursor: { projection: "run-summary" }, rows: [{ runId: "run-9" }] } }
              })
            }\n`,
            { status: 200 }
          )
      },
      async (calls) => {
        const response = await worker.fetch(
          signedIn("/api/workflow/rpc", {
            method: "POST",
            body: JSON.stringify({
              repo: "will/mvp",
              procedure: "Projection.Snapshot",
              payload: { selector: { _tag: "run-summary", runId: "run-9" } }
            })
          }),
          env()
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          ok: true,
          payload: { cursor: { projection: "run-summary" }, rows: [{ runId: "run-9" }] }
        })
        const relayed = calls.find((call) => call.url.endsWith("/projections"))
        // The credential the browser can never hold is added on this side.
        expect(relayed?.url).toBe("https://api.smithers-cloud.test/api/gateways/gw-1/projections")
        expect(relayed?.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`)
        expect(relayed?.body).toMatchObject({ _tag: "Request", tag: "Projection.Snapshot" })
      }
    )
  })

  test("an approval decision is one relayed call that also resumes the run", async () => {
    await withRelay(
      {
        gateway: () =>
          new Response(
            `${
              JSON.stringify({
                _tag: "Exit",
                requestId: 1,
                exit: {
                  _tag: "Success",
                  value: { decision: { _tag: "Accepted" }, resume: { _tag: "Accepted" } }
                }
              })
            }\n`,
            { status: 200 }
          )
      },
      async (calls) => {
        const response = await worker.fetch(
          signedIn("/api/workflow/rpc", {
            method: "POST",
            body: JSON.stringify({
              repo: "will/mvp",
              procedure: "Approval.Submit",
              payload: { decision: "approve" }
            })
          }),
          env()
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as { ok: boolean; payload: { resume?: unknown } }
        expect(body.ok).toBe(true)
        // One relayed call records the decision AND resumes the run, because
        // the gateway binds the pair behind `Approval.Submit`. There is no
        // second round trip for a lost answer to strand.
        expect(body.payload.resume).toEqual({ _tag: "Accepted" })
        expect(calls.filter((call) => call.url.includes("/api/gateways/"))).toHaveLength(1)
      }
    )
  })

  test("the relay refuses a gateway path the product does not address", async () => {
    await withRelay({}, async (calls) => {
      const call = await callGateway(env(), "will", "will/mvp", "/admin/tokens", { method: "POST", text: "{}" })
      expect(call.status).toBe("unavailable")
      expect(call.status === "unavailable" && call.detail).toContain("not a gateway path")
      // Not one call left the Worker: no Cloud token was minted, let alone spent.
      expect(calls).toHaveLength(0)
    })
  })

  test("no_capacity reaches the browser as an honest state, not a 500 and not a retry loop", async () => {
    await withRelay(
      { provision: () => json(500, { error: "no_capacity" }) },
      async (calls) => {
        const response = await worker.fetch(
          signedIn("/api/workflow/provision", {
            method: "POST",
            body: JSON.stringify({ repo: "will/mvp" })
          }),
          env()
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as { status: string; message: string }
        expect(body.status).toBe("no-capacity")
        expect(body.message).toContain("nothing was queued")
        expect(calls.filter((call) => call.url.includes("/gateway"))).toHaveLength(1)
      }
    )
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

  test("partitions legacy and two owning workspaces without exposing their credentials", async () => {
    await withRelay({ provision }, async (calls) => {
      for (const workspaceId of [undefined, first, second, first, undefined]) {
        const response = await worker.fetch(signedIn("/api/workflow/provision", {
          method: "POST", body: JSON.stringify({ repo, workspaceId })
        }), env())
        expect(response.status).toBe(200)
        const result = await response.json() as Record<string, unknown>
        expect(result.status).toBe("ready")
        expect(result.workspaceId).toBe(workspaceId)
        expect(result.gatewayId).toBe(workspaceId ?? "legacy")
        expect(JSON.stringify(result)).not.toContain(GATEWAY_TOKEN)
      }
      const provisions = calls.filter((call) => call.url.endsWith("/gateway"))
      expect(provisions.map((call) => call.body)).toEqual([undefined, { workspace_id: first }, { workspace_id: second }])
      const response = await worker.fetch(signedIn("/api/workflow/rpc", {
        method: "POST", body: JSON.stringify({ repo, workspaceId: first, procedure: "List", payload: { _tag: "flows" } })
      }), env())
      expect(response.status).toBe(200)
      expect(calls.at(-1)?.url).toContain(`/api/gateways/${first}/`)
    })
  })

  test("refuses a legacy or mismatched provision response instead of falling back to a different checkout", async () => {
    for (const returned of [undefined, second]) {
      await withRelay({ provision: (call) => provision({ ...call, body: returned === undefined ? undefined : { workspace_id: returned } }) }, async () => {
        const result = await ensureGateway(env(), "codeplanesmithers", repo, false, first)
        expect(result.status).toBe("unavailable")
      })
    }
  })

  test("does not retry an unconfigured coding host as a normal startup delay", async () => {
    await withRelay({ provision: () => json(409, { code: "coding_host_unavailable", message: "Stage the registered coding host." }) }, async () => {
      const result = await ensureGateway(env(), "codeplanesmithers", repo, false, first)
      expect(result).toEqual({ status: "unavailable", detail: "Stage the registered coding host." })
    })
  })

  test("rejects malformed bindings before provisioning and keeps read-only requests read-only", async () => {
    await withRelay({}, async (calls) => {
      for (const workspaceId of ["../other", first.toUpperCase(), "00000000-0000-0000-0000-000000000000", null]) {
        const result = await worker.fetch(signedIn("/api/workflow/rpc", {
          method: "POST", body: JSON.stringify({ repo, workspaceId, procedure: "List", payload: { _tag: "flows" } })
        }), env())
        expect(result.status).toBe(400)
      }
      const result = await callGateway(env(), "codeplanesmithers", repo, "/rpc", {
        method: "POST", text: "{}", provision: false, workspaceId: first
      })
      expect(result.status).toBe("unavailable")
      expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(0)
    })
  })
})

test("durable gateway cache keeps owning workspace records separate across worker restarts", async () => {
  const stored = new Map<string, unknown>()
  const storage = {
    get: async <T>(key: string): Promise<T | undefined> => stored.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { stored.set(key, value) }
  }
  let registry = new GatewaySessionRegistry({ storage }, BASE_ENV)
  const environment = env({ GATEWAY_SESSIONS: { idFromName: (login) => login, get: () => registry } })
  const workspaceId = "83e75ae5-0920-4000-8000-000000000003"
  await withRelay({ provision: (call) => json(200, {
    base_url: "https://api.smithers-cloud.test/api/gateways/bound", token: GATEWAY_TOKEN,
    gateway_id: "bound", expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...(call.body as { workspace_id?: string } | undefined)
  }) }, async (calls) => {
    expect((await ensureGateway(environment, "codeplanesmithers", "o/r", false, workspaceId)).status).toBe("ready")
    expect((await ensureGateway(environment, "codeplanesmithers", "o/r")).status).toBe("ready")
    // A new isolate: the instance is gone, the storage behind it is not.
    registry = new GatewaySessionRegistry({ storage }, BASE_ENV)
    const restored = await ensureGateway(environment, "codeplanesmithers", "o/r", false, workspaceId)
    expect(restored.status).toBe("ready")
    if (restored.status === "ready") expect(restored.record.workspaceId).toBe(workspaceId)
    expect(stored.size).toBe(2)
    expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(2)
  })
})

/*
 * The credential store as deployed: one GatewaySessionRegistry per login over
 * its own storage. Every case below constructs the real class, recreates it
 * over retained storage (a Worker restart), and reads exact credentials back.
 */
describe("the gateway session registry", () => {
  /** A per-login storage map that survives registry instances. */
  const retainedNamespace = (registryEnv: GatewayRegistryEnv = BASE_ENV) => {
    const stores = new Map<string, Map<string, unknown>>()
    const failures = { get: false, put: false }
    const storageFor = (login: string) => {
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
    const instances = new Map<string, GatewaySessionRegistry>()
    const namespace = {
      idFromName: (login: string) => login,
      get: (id: unknown) => {
        const login = String(id)
        let registry = instances.get(login)
        if (registry === undefined) {
          registry = new GatewaySessionRegistry({ storage: storageFor(login) }, registryEnv)
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

  const ready = async (environment: WorkerEnv, login: string, repo: string, force = false): Promise<GatewayRecord> => {
    const outcome = await ensureGateway(environment, login, repo, force)
    expect(outcome.status).toBe("ready")
    if (outcome.status !== "ready") throw new Error(outcome.status)
    return outcome.record
  }

  test("round-trips exact credentials per login and repository across restarts, provision and renewal", async () => {
    const retained = retainedNamespace()
    const environment = env({ GATEWAY_SESSIONS: retained.namespace })
    await withRelay({ cloudToken: tokenEach, provision: provisionEach }, async (calls) => {
      const minted = new Map<string, GatewayRecord>()
      for (const login of ["alice", "bob"]) {
        for (const repo of ["org/one", "org/two"]) minted.set(`${login} ${repo}`, await ready(environment, login, repo))
      }
      expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(4)
      expect(retained.stores.get("alice")?.size).toBe(2)
      expect(retained.stores.get("bob")?.size).toBe(2)

      // Each record names its own login and repository, nothing else's.
      retained.restart()
      for (const [key, record] of minted) {
        const [login, repo] = key.split(" ") as [string, string]
        const [owner, name] = repo.split("/")
        const restored = await ready(environment, login, repo)
        expect(restored).toEqual(record)
        expect(restored.gatewayId).toMatch(new RegExp(`^${login}-${owner}-${name}-\\d+$`))
        expect(restored.baseUrl).toBe(`https://api.smithers-cloud.test/api/gateways/${restored.gatewayId}`)
        expect(restored.token).toBe(`${GATEWAY_TOKEN}-${restored.gatewayId}`)
      }
      expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(4)

      // Renewal replaces exactly the expired record and adopts what came back.
      const aged = minted.get("alice org/one")!
      await retained.namespace.get("alice").fetch(new Request("https://gateway-sessions.internal/record", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "org/one", record: { ...aged, renewAfter: Date.now() - 1 } })
      }))
      const renewed = await ready(environment, "alice", "org/one")
      expect(renewed.gatewayId).not.toBe(aged.gatewayId)
      expect(renewed.gatewayId).toMatch(/^alice-org-one-\d+$/)
      expect(renewed.token).toBe(`${GATEWAY_TOKEN}-${renewed.gatewayId}`)
      retained.restart()
      expect(await ready(environment, "alice", "org/one")).toEqual(renewed)
      expect(await ready(environment, "alice", "org/two")).toEqual(minted.get("alice org/two")!)
      expect(await ready(environment, "bob", "org/one")).toEqual(minted.get("bob org/one")!)
      expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(5)

      // A forced refresh re-provisions even a fresh record.
      const forced = await ready(environment, "bob", "org/two", true)
      expect(forced.gatewayId).not.toBe(minted.get("bob org/two")!.gatewayId)
      expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(6)
    })
  })

  test("serves a legacy record without provisionedAt and treats storage failures as cold or unavailable", async () => {
    const retained = retainedNamespace()
    const environment = env({ GATEWAY_SESSIONS: retained.namespace })
    await withRelay({ cloudToken: tokenEach, provision: provisionEach }, async (calls) => {
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
      expect(await ready(environment, "alice", "org/legacy")).toEqual({ ...legacy, provisionedAt: 0 })
      expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(0)

      retained.failures.put = true
      const unwritable = await ensureGateway(environment, "alice", "org/fresh")
      expect(unwritable.status).toBe("unavailable")
      expect(unwritable.status === "unavailable" && unwritable.detail).toContain("write failed")
      retained.failures.put = false

      retained.failures.get = true
      const reprovisioned = await ready(environment, "alice", "org/legacy")
      expect(reprovisioned.gatewayId).not.toBe("legacy")
      retained.failures.get = false
      expect(await ready(environment, "alice", "org/legacy")).toEqual(reprovisioned)
    })
  })

  for (const state of ["cold", "expired"] as const) {
    test(`${state} concurrent misses for one login and repository share a single provisioning`, async () => {
      const retained = retainedNamespace()
      const environment = env({ GATEWAY_SESSIONS: retained.namespace })
      await withRelay({ cloudToken: tokenEach, provision: provisionEach }, async (calls) => {
        if (state === "expired") {
          const stale = await ready(environment, "alice", "org/one")
          await retained.namespace.get("alice").fetch(new Request("https://gateway-sessions.internal/record", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ repo: "org/one", record: { ...stale, renewAfter: Date.now() - 1 } })
          }))
          calls.length = 0
        }
        const records = await Promise.all(
          Array.from({ length: 8 }, () => ready(environment, "alice", "org/one"))
        )
        const others = await Promise.all([ready(environment, "alice", "org/two"), ready(environment, "bob", "org/one")])
        expect(calls.filter((call) => call.url.endsWith("/api/identity/cloud-token"))).toHaveLength(3)
        expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(3)
        for (const record of records) expect(record).toEqual(records[0])
        expect(records[0]!.gatewayId).toMatch(/^alice-org-one-\d+$/)
        expect(new Set([records[0]!.gatewayId, ...others.map((record) => record.gatewayId)]).size).toBe(3)
        retained.restart()
        expect(await ready(environment, "alice", "org/one")).toEqual(records[0]!)
      })
    })
  }

  test("a joiner adopts the outcome of a failed provisioning instead of retrying it", async () => {
    const retained = retainedNamespace()
    const environment = env({ GATEWAY_SESSIONS: retained.namespace })
    await withRelay({ cloudToken: tokenEach, provision: () => json(500, { error: "no_capacity" }) }, async (calls) => {
      const outcomes = await Promise.all(Array.from({ length: 4 }, () => ensureGateway(environment, "alice", "org/one")))
      for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0])
      expect(outcomes[0]?.status).toBe("no_capacity")
      expect(calls.filter((call) => call.url.endsWith("/gateway"))).toHaveLength(1)
      expect(retained.stores.get("alice")?.size ?? 0).toBe(0)
    })
  })
})


describe("configured gateway headers deadlines", () => {
  test("the Cloud token deadline names the actual 20 ms duration", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })) as typeof fetch
    try {
      const outcome = await fetchCloudToken(env({ UPSTREAM_TIMEOUT_MS: "20" }), "deadline-user")
      expect(outcome.status).toBe("unavailable")
      if (outcome.status === "unavailable") expect(outcome.detail).toContain("20ms")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
