import { afterEach, describe, expect, test } from "bun:test"
import { MODEL_STREAM_PATH, TURN_PATH } from "@smthrs/rpc/AgentApiRoutes"
import worker from "./index"
import type { WorkerEnv } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

/*
 * The relay boundary, driven through the Worker's real fetch handler with the
 * upstream fetch patched — no network. The contract under test: the relay
 * forwards to the SAME managed-inference upstream the turn path uses (which is
 * what makes it metered), it mints the run id itself, it refuses anonymous and
 * non-allowlisted callers BEFORE any upstream call, and the sealed-step law
 * rejects tool-bearing bodies.
 */

const env = (overrides: Partial<WorkerEnv> = {}): WorkerEnv =>
  ({
    ...memoryDurableObjects(),
    ASSETS: { fetch: async () => new Response("not-found", { status: 404 }) },
    SMITHERS_CHAT_URL: "https://upstream.test/chat",
    ...overrides
  }) as WorkerEnv

/** The deployed shape: an identity seam is set, so the route is gated. */
const gatedEnv = (overrides: Partial<WorkerEnv> = {}): WorkerEnv =>
  env({ IDENTITY_UPSTREAM_URL: "https://identity.test", ...overrides })

const relayBody = { instructions: "You are Smithers.", messages: [{ role: "user", content: "hi" }] }

const relayRequest = (body: unknown = relayBody, headers: Record<string, string> = {}): Request =>
  new Request(`https://app.test${MODEL_STREAM_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  })

const ndjson = (frames: ReadonlyArray<Record<string, unknown>>): Response =>
  new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" }
  })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Patches fetch, routing identity validation separately from the model upstream. */
const withFetch = (
  handler: (request: Request) => Response | Promise<Response>
): Array<Request> => {
  const captured: Array<Request> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as Request | string, init)
    captured.push(request)
    return handler(request)
  }) as typeof fetch
  return captured
}

const identityAnswer = (login: string, allowlisted: boolean): Response =>
  new Response(JSON.stringify({ login, allowlisted }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })

describe("the model relay route", () => {
  test("forwards the sealed call to the managed-inference upstream and streams its frames back", async () => {
    const captured = withFetch(() => ndjson([{ type: "delta", kind: "text", text: "ok" }, { type: "done" }]))

    const response = await worker.fetch(relayRequest(), env())
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    expect(await response.text()).toContain("\"type\":\"done\"")

    expect(captured).toHaveLength(1)
    const sent = captured[0]!
    // The SAME upstream /api/agent/turn calls: the one that owns the provider
    // key, authorizes the balance, and meters the usage durably.
    expect(sent.url).toBe("https://upstream.test/chat")
    expect(await sent.json()).toEqual(relayBody)
  })

  test("mints its own run id — a caller can never choose the charge's idempotency key", async () => {
    const captured = withFetch(() => ndjson([{ type: "done" }]))
    await worker.fetch(relayRequest(relayBody, { "x-smithers-run-id": "attacker-chosen" }), env())
    const runId = captured[0]!.headers.get("x-smithers-run-id")
    expect(runId).not.toBe("attacker-chosen")
    expect(runId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("legacy turns keep client frame ids separate from unique charge ids on repeated requests", async () => {
    const captured = withFetch((request) => new URL(request.url).hostname === "identity.test"
      ? identityAnswer("will", true)
      : ndjson([
        { type: "card", card: { kind: "approval", payload: { runId: request.headers.get("x-smithers-run-id") } } },
        { type: "card", card: { kind: "approval", payload: { runId: "independent-workflow" } } },
        { type: "done" }
      ]))
    for (const content of ["first", "different prompt"]) {
      const response = await worker.fetch(new Request(`https://app.test${TURN_PATH}`, {
        method: "POST", headers: { "content-type": "application/json", cookie: "session=test" },
        body: JSON.stringify({ runId: "repeated-client-id", instructions: "", messages: [{ role: "user", content }] })
      }), gatedEnv())
      expect(response.status).toBe(200)
      const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
      expect(frames.every((frame) => frame.runId === "repeated-client-id")).toBe(true)
      expect(frames[0].card.payload.runId).toBe("repeated-client-id")
      expect(frames[1].card.payload.runId).toBe("independent-workflow")
    }
    const chargeIds = captured.filter((request) => new URL(request.url).hostname === "upstream.test")
      .map((request) => request.headers.get("x-smithers-run-id"))
    expect(chargeIds).toHaveLength(2)
    expect(new Set(chargeIds).size).toBe(2)
    for (const id of chargeIds) expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("vouches a validated login so the charge lands on the user's own account", async () => {
    const captured = withFetch((request) =>
      new URL(request.url).hostname === "identity.test"
        ? identityAnswer("will", true)
        : ndjson([{ type: "done" }])
    )
    const response = await worker.fetch(
      relayRequest(relayBody, { cookie: "smithers_session=abc" }),
      gatedEnv({ CHAT_PRODUCT_SERVICE_TOKEN: "product-token", SMITHERS_CHAT_AUTH_TOKEN: "bearer-token" })
    )
    expect(response.status).toBe(200)
    const upstream = captured.find((request) => new URL(request.url).hostname === "upstream.test")!
    expect(upstream.headers.get("x-smithers-service-token")).toBe("product-token")
    expect(upstream.headers.get("x-user-login")).toBe("will")
    expect(upstream.headers.get("authorization")).toBe("Bearer bearer-token")
  })

  test("refuses an anonymous call with 401 before any credential is spent", async () => {
    let upstreamCalls = 0
    withFetch((request) => {
      if (new URL(request.url).hostname === "identity.test") return new Response("{}", { status: 401 })
      upstreamCalls += 1
      return ndjson([{ type: "done" }])
    })
    const response = await worker.fetch(relayRequest(), gatedEnv())
    expect(response.status).toBe(401)
    expect(upstreamCalls).toBe(0)
  })

  test("refuses a signed-in but non-allowlisted account with 403 before any credential is spent", async () => {
    let upstreamCalls = 0
    withFetch((request) => {
      if (new URL(request.url).hostname === "identity.test") return identityAnswer("stranger", false)
      upstreamCalls += 1
      return ndjson([{ type: "done" }])
    })
    const response = await worker.fetch(relayRequest(relayBody, { cookie: "smithers_session=abc" }), gatedEnv())
    expect(response.status).toBe(403)
    expect(upstreamCalls).toBe(0)
  })

  test("rejects a tool-bearing body — the relay serves sealed author calls only", async () => {
    let upstreamCalls = 0
    withFetch(() => {
      upstreamCalls += 1
      return ndjson([{ type: "done" }])
    })
    const response = await worker.fetch(
      relayRequest({ ...relayBody, tools: [{ type: "function", name: "bash" }] }),
      env()
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("sealed author calls only")
    expect(upstreamCalls).toBe(0)
  })

  test("rejects a body with no messages", async () => {
    const response = await worker.fetch(relayRequest({ messages: [] }), env())
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("messages")
  })

  test("surfaces an upstream failure with its status and detail", async () => {
    withFetch(() => new Response(JSON.stringify({ error: "overloaded" }), { status: 529 }))
    const response = await worker.fetch(relayRequest(), env())
    expect(response.status).toBe(529)
  })

  test("only POST is allowed", async () => {
    const response = await worker.fetch(
      new Request(`https://app.test${MODEL_STREAM_PATH}`, { method: "GET" }),
      env()
    )
    expect(response.status).toBe(405)
  })
})
