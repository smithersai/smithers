import { afterEach, describe, expect, test } from "bun:test"
import { WORKFLOW_TRIGGERS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import worker from "./index"
import type { WorkerEnv } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"
import { noLiveTriggers, workflowTriggersFromFrame } from "./workflowTriggers"
import type { WorkflowTriggersBody } from "./workflowTriggers"

/*
 * The live-dispatchers route: what the triggers.list card reads beside the
 * declared rules it gets from the public mirror. The contract is two-valued
 * and honest: `live: true` with the box's rows when a signed-in session's
 * existing box answered `List { _tag: "triggers" }`; otherwise a 200 with
 * `live: false` and empty lists, whether the caller is signed out, the
 * deployment has no identity seam, the login holds no box, or the box refuses
 * the listing. No reason is stated as a row, and a read never provisions:
 * whatever the box or its record looks like, no provision POST and no Cloud
 * token mint leaves the Worker on this route.
 */

const SETTINGS = {
  ASSETS: { fetch: async () => new Response("app") },
  IDENTITY_UPSTREAM_URL: "https://identity.test",
  IDENTITY_SERVICE_TOKEN: "svc",
  SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
}
const durable = memoryDurableObjects(SETTINGS)
const env: WorkerEnv = { ...SETTINGS, GATEWAY_SESSIONS: durable.GATEWAY_SESSIONS, TURN_CANCELS: durable.TURN_CANCELS }

const REPO = "smithersai/smithers"
const GATEWAY = "https://cloud.test/api/gateways/gw-0"

const request = (query: string, init: RequestInit = {}): Request =>
  new Request(`https://mvp.test${WORKFLOW_TRIGGERS_PATH}${query}`, {
    ...init,
    headers: { cookie: "smithers_session=sealed", ...(init.headers ?? {}) }
  })

/** Every outbound fetch the Worker makes: identity as configured, the gateway relay as configured, nothing else answers. */
const withUpstreams = async (
  identity: () => Response,
  run: (seen: ReadonlyArray<string>) => Promise<void>,
  gateway: (request: Request) => Response | Promise<Response> = () => new Response("404 page not found\n", { status: 404 })
): Promise<void> => {
  const seen: Array<string> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    seen.push(url)
    if (url.includes("/api/identity/validate")) return identity()
    if (url.startsWith(GATEWAY)) return gateway(new Request(url, init))
    return new Response("404 page not found\n", { status: 404 })
  }) as unknown as typeof fetch
  try {
    await run(seen)
  } finally {
    globalThis.fetch = original
  }
}

const validated = () =>
  new Response(JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })

const seedBox = (renewAfter = Date.now() + 20 * 60 * 1000): Promise<void> =>
  durable.seedGatewayRecord("will", REPO, {
    gatewayId: "gw-0",
    baseUrl: GATEWAY,
    token: "gateway-token",
    vmId: "msb_0",
    expiresAt: Date.now() + 30 * 60 * 1000,
    renewAfter,
    provisionedAt: Date.now() - 60 * 1000
  })

/**
 * The two calls that provision or resume a box: the Cloud token mint at the
 * identity door and the provision POST at Smithers Cloud. A read must make
 * neither, whatever it saw.
 */
const provisioning = (seen: ReadonlyArray<string>): ReadonlyArray<string> =>
  seen.filter((url) => url.includes("/cloud-token") || /\/api\/repos\/[^/]+\/[^/]+\/gateway$/.test(url))

const frame = (exit: unknown): Response =>
  new Response(`${JSON.stringify({ _tag: "Exit", requestId: 1, exit })}\n`, {
    status: 200,
    headers: { "content-type": "application/json" }
  })

const TRIGGER_PAGE = {
  _tag: "triggers",
  items: [
    {
      triggerId: "nightly",
      flowId: "review",
      input: {},
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      overlap: "skip",
      catchUp: "none",
      enabled: true,
      revision: 3,
      lastFiredAtMs: 1_700_000_000_000,
      activeRunId: "run-8f21",
      nextOccurrencesMs: [1_700_086_400_000, 1_700_172_800_000]
    },
    { triggerId: "sweep", flowId: "issue", input: {}, cron: "*/15 * * * *", overlap: "skip", catchUp: "none", enabled: false, revision: 1, nextOccurrencesMs: [] },
    { notATrigger: true }
  ]
}

afterEach(() => durable.reset())

describe("GET /api/workflow/triggers", () => {
  test("an anonymous read answers live:false with empty lists as a 200, never a 401 and never a reason as a row", async () => {
    await withUpstreams(() => new Response("{}", { status: 401 }), async (seen) => {
      const response = await worker.fetch(request(`?repo=${REPO}`), env)
      expect(response.status).toBe(200)
      const body = (await response.json()) as WorkflowTriggersBody
      expect(body).toEqual({ status: "ok", repo: REPO, live: false, triggers: [], webhooks: [] })
      expect("reason" in body).toBe(false)
      expect(seen.every((url) => url.includes("identity.test"))).toBe(true)
    })
  })

  test("a signed-in login with no box answers live:false and provisions nothing", async () => {
    await withUpstreams(validated, async (seen) => {
      const response = await worker.fetch(request(`?repo=${REPO}`), env)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(noLiveTriggers(REPO))
      /* Only the identity check left the Worker: no Cloud token mint, no gateway POST. */
      expect(seen).toEqual(["https://identity.test/api/identity/validate"])
    })
  })

  test("a box whose record is past its half-life is not re-provisioned to answer a read: live:false, nothing left the Worker but the identity check", async () => {
    await seedBox(Date.now() - 1)
    await withUpstreams(
      validated,
      async (seen) => {
        const response = await worker.fetch(request(`?repo=${REPO}`), env)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(noLiveTriggers(REPO))
        expect(provisioning(seen)).toEqual([])
        expect(seen).toEqual(["https://identity.test/api/identity/validate"])
      },
      () => {
        throw new Error("a stale record must not be relayed to the box")
      }
    )
  })

  test("a box that answers 401 is not re-provisioned to answer a read: live:false, one relay call, no provision POST", async () => {
    await seedBox()
    let relayed = 0
    await withUpstreams(
      validated,
      async (seen) => {
        const response = await worker.fetch(request(`?repo=${REPO}`), env)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(noLiveTriggers(REPO))
        expect(relayed).toBe(1)
        expect(provisioning(seen)).toEqual([])
        expect(seen).toEqual(["https://identity.test/api/identity/validate", `${GATEWAY}/rpc`])
      },
      () => {
        relayed += 1
        return new Response(JSON.stringify({ message: "invalid gateway credentials" }), { status: 401 })
      }
    )
  })

  test("a relay tunnel failure (the VM idle-suspended) is not resumed by a read: live:false, no provision POST", async () => {
    await seedBox()
    await withUpstreams(
      validated,
      async (seen) => {
        const response = await worker.fetch(request(`?repo=${REPO}`), env)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(noLiveTriggers(REPO))
        expect(provisioning(seen)).toEqual([])
        expect(seen).toEqual(["https://identity.test/api/identity/validate", `${GATEWAY}/rpc`])
      },
      () => new Response("bad gateway", { status: 502 })
    )
  })

  test("a signed-in login whose box answers List { _tag: \"triggers\" } gets live:true and the box's rows", async () => {
    await seedBox()
    const relayed: Array<string> = []
    await withUpstreams(
      validated,
      async () => {
        const response = await worker.fetch(request(`?repo=${REPO}`), env)
        expect(response.status).toBe(200)
        const body = (await response.json()) as WorkflowTriggersBody
        expect(body.live).toBe(true)
        expect(body.webhooks).toEqual([])
        expect(body.triggers).toEqual([
          {
            id: "nightly",
            flowId: "review",
            cron: "0 9 * * 1-5",
            timezone: "UTC",
            enabled: true,
            lastFiredAt: 1_700_000_000_000,
            nextFireAt: 1_700_086_400_000,
            activeRunId: "run-8f21"
          },
          { id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false }
        ])
        /* The relay carried exactly the List frame for the triggers page to the box's /rpc mount. */
        expect(relayed).toHaveLength(1)
        const sent = JSON.parse(relayed[0]!.trim()) as { tag: string; payload: unknown }
        expect(sent.tag).toBe("List")
        expect(sent.payload).toEqual({ _tag: "triggers" })
      },
      async (gatewayRequest) => {
        expect(gatewayRequest.url).toBe(`${GATEWAY}/rpc`)
        expect(gatewayRequest.headers.get("authorization")).toBe("Bearer gateway-token")
        relayed.push(await gatewayRequest.text())
        return frame({ _tag: "Success", value: TRIGGER_PAGE })
      }
    )
  })

  test("a box whose host serves no trigger store answers live:false, not an empty live list", async () => {
    await seedBox()
    await withUpstreams(
      validated,
      async () => {
        const response = await worker.fetch(request(`?repo=${REPO}`), env)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(noLiveTriggers(REPO))
      },
      () => frame({ _tag: "Failure", cause: { _tag: "InvalidInput", message: "this host serves no trigger store" } })
    )
  })

  test("the repository is required and must be owner/repo, for every caller", async () => {
    await withUpstreams(validated, async () => {
      for (const query of ["", "?repo=", "?repo=smithers", "?repo=../etc/passwd", "?repo=a/b/c"]) {
        const response = await worker.fetch(request(query), env)
        expect(`${query} -> ${response.status}`).toBe(`${query} -> 400`)
        const body = (await response.json()) as { message: string }
        expect(body.message).toContain("owner/repo")
      }
    })
  })

  test("only GET is served", async () => {
    await withUpstreams(validated, async (seen) => {
      const response = await worker.fetch(request(`?repo=${REPO}`, { method: "POST" }), env)
      expect(response.status).toBe(405)
      expect(seen).toHaveLength(0)
    })
  })

  test("with no identity seam there is no signed-in session, so the answer is live:false", async () => {
    const response = await worker.fetch(request(`?repo=${REPO}`), { ASSETS: env.ASSETS, GATEWAY_SESSIONS: env.GATEWAY_SESSIONS, TURN_CANCELS: env.TURN_CANCELS })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(noLiveTriggers(REPO))
  })
})

describe("the box's page as rows", () => {
  test("a refusal, a page of another tag, or a shapeless answer is live:false; well-formed items become rows", () => {
    expect(workflowTriggersFromFrame(REPO, { ok: false, error: { message: "this host serves no trigger store" } })).toEqual(noLiveTriggers(REPO))
    expect(workflowTriggersFromFrame(REPO, { ok: true, payload: { _tag: "flows", items: [] } })).toEqual(noLiveTriggers(REPO))
    expect(workflowTriggersFromFrame(REPO, { ok: true, payload: "nonsense" })).toEqual(noLiveTriggers(REPO))
    const empty = workflowTriggersFromFrame(REPO, { ok: true, payload: { _tag: "triggers", items: [] } })
    expect(empty).toEqual({ status: "ok", repo: REPO, live: true, triggers: [], webhooks: [] })
  })
})
