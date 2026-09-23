import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import { Effect, Stream } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, test } from "vitest"
import { createModelTurnHandler, MODEL_HOST_PROTOCOL, MODEL_HOST_STREAM_PATH } from "../src/HostServer.ts"

const cursor = { version: 1 as const, runId: "run", legId: "leg", batch: 0, position: 0, hash: "a".repeat(64) }
const grant = {
  turnId: "turn",
  ownerId: 1,
  runId: "run",
  legId: "leg",
  generation: 1,
  token: "producer_capability_producer_capability_1234",
  cursor,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  request: { runId: "run", instructions: "answer", messages: [{ role: "user", content: "hi" }] },
  producerBaseUrl: "http://callback.test/"
}

const committed = (body: Record<string, any>) => {
  const expected = body.expected
  const frame = body.frames[0]
  const unsigned = {
    version: 1,
    runId: "run",
    legId: "leg",
    batch: expected.batch + 1,
    from: expected.position + 1,
    previousHash: expected.hash,
    frames: [frame]
  }
  const batch = {
    ...unsigned,
    hash: createHash("sha256").update(agentTurnJournalDigestInput("batch", unsigned)).digest("hex")
  }
  return {
    status: "committed",
    batch,
    cursor: { version: 1, runId: "run", legId: "leg", batch: batch.batch, position: batch.from, hash: batch.hash }
  }
}

describe("model host HTTP binding", () => {
  test("authenticates a secret-free grant and waits for durable callbacks", async () => {
    const calls: string[] = []
    const events: ReadonlyArray<ModelEvent.ModelEvent> = [{ type: "text-delta", id: "t", text: "hello" }, {
      type: "settle",
      stopReason: "stop"
    }]
    const handler = createModelTurnHandler({
      authorization: "host-token",
      callbackBaseUrl: "http://callback.test",
      resolve: () =>
        Effect.succeed({
          model: Model.make({ stream: () => Stream.fromIterable(events) }),
          options: { modelId: "fixture" }
        }),
      fetchImpl: async (input, init) => {
        calls.push(new URL(String(input)).pathname)
        if (String(input).includes("provider-started")) return new Response(null, { status: 204 })
        return Response.json(committed(JSON.parse(typeof init?.body === "string" ? init.body : "{}")))
      }
    })
    const refused = await handler(
      new Request("http://host.test/v1/chat/turn", { method: "POST", body: JSON.stringify(grant) })
    )
    expect(refused.status).toBe(401)
    const response = await handler(
      new Request("http://host.test/v1/chat/turn", {
        method: "POST",
        headers: { authorization: "Bearer host-token", "content-type": "application/json" },
        body: JSON.stringify(grant)
      })
    )
    expect(response.status).toBe(204)
    expect(calls).toEqual(["/internal/chat/provider-started", "/internal/chat/commit", "/internal/chat/commit"])
    const health = await handler(new Request("http://host.test/health"))
    expect(await health.json()).toEqual({ protocol: MODEL_HOST_PROTOCOL })
  })
})

test("the authenticated model stream emits provider frames through the configured owner model", async () => {
  let resolvedOwner = 0
  const handler = createModelTurnHandler({
    authorization: "host-token",
    callbackBaseUrl: "http://callback.test",
    resolve: (accepted) => {
      resolvedOwner = accepted.ownerId
      return Effect.succeed({
        model: Model.make({
          stream: () =>
            Stream.fromIterable([
              { type: "text-delta", id: "t", text: "provider token" } as const,
              { type: "settle", stopReason: "stop" } as const
            ])
        }),
        options: { modelId: "fixture" }
      })
    }
  })
  const body = JSON.stringify({
    runId: "run-stream",
    ownerId: 42,
    instructions: "summarize",
    messages: [{ role: "user", content: "hi" }]
  })
  const refused = await handler(new Request(`http://host.test${MODEL_HOST_STREAM_PATH}`, { method: "POST", body }))
  expect(refused.status).toBe(401)
  const response = await handler(
    new Request(`http://host.test${MODEL_HOST_STREAM_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer host-token", "content-type": "application/json" },
      body
    })
  )
  expect(response.status).toBe(200)
  expect(resolvedOwner).toBe(42)
  const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
  expect(frames).toEqual([
    { runId: "run-stream", type: "delta", kind: "text", text: "provider token" },
    { runId: "run-stream", type: "done", reason: "stop" }
  ])
})

const options = {
  authorization: "host-token",
  callbackBaseUrl: "http://callback.test",
  resolve: () => Effect.fail(new Error("private provider diagnostic"))
}
const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://host.test/v1/chat/turn", {
    method: "POST",
    headers: { authorization: "Bearer host-token", ...headers },
    body
  })

test.each([
  "ftp://callback.test",
  "http://user@callback.test",
  "http://:pass@callback.test",
  "http://callback.test/?q=1",
  "http://callback.test/#fragment"
])(
  "refuses unsafe configured and wire callback URL %s",
  async (url) => {
    expect(() => createModelTurnHandler({ ...options, callbackBaseUrl: url })).toThrow(
      "invalid model host callback URL"
    )
    const response = await createModelTurnHandler(options)(post(JSON.stringify({ ...grant, producerBaseUrl: url })))
    expect(response.status).toBe(400)
  }
)

test("requires authorization configuration and rejects unknown routes and methods", async () => {
  expect(() => createModelTurnHandler({ ...options, authorization: " " })).toThrow("authorization is required")
  const handler = createModelTurnHandler(options)
  expect((await handler(new Request("http://host.test/unknown"))).status).toBe(404)
  expect((await handler(new Request("http://host.test/health", { method: "POST" }))).status).toBe(404)
  expect((await handler(new Request("http://host.test/v1/chat/turn"))).status).toBe(405)
})

test.each([
  null,
  {},
  { ...grant, request: null },
  { ...grant, request: "invalid" },
  { ...grant, request: { ...grant.request, runId: 2 } },
  { ...grant, request: { ...grant.request, instructions: 2 } },
  { ...grant, request: { ...grant.request, messages: {} } },
  { ...grant, request: { ...grant.request, tools: {} } },
  { ...grant, request: { ...grant.request, runId: "other" } },
  { ...grant, cursor: { ...cursor, runId: "other" } },
  { ...grant, cursor: { ...cursor, legId: "other" } },
  { ...grant, producerBaseUrl: "http://other.test" },
  { ...grant, expiresAt: "not a date" },
  { ...grant, expiresAt: "2000-01-01" }
])("rejects malformed or mismatched grants before resolving a model %#", async (value) => {
  let resolved = false
  const handler = createModelTurnHandler({
    ...options,
    resolve: () => {
      resolved = true
      return options.resolve()
    }
  })
  const response = await handler(post(JSON.stringify(value)))
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ status: "error", code: "request_invalid" })
  expect(resolved).toBe(false)
})

test.each(["NaN", "-1", String(2 * 1024 * 1024 + 1)])("bounds declared body length %s", async (length) => {
  const response = await createModelTurnHandler(options)(post(JSON.stringify(grant), { "content-length": length }))
  expect(response.status).toBe(400)
})

test.each([null, " ".repeat(2 * 1024 * 1024 + 1), "{", new Uint8Array([0xff])])(
  "rejects empty, oversized, malformed JSON, and invalid UTF-8 bodies %#",
  async (body) => {
    expect((await createModelTurnHandler(options)(post(body))).status).toBe(400)
  }
)

test("refuses an unreadable request body", async () => {
  const request = post(JSON.stringify(grant))
  await request.arrayBuffer()
  expect((await createModelTurnHandler(options)(request)).status).toBe(400)
})

test("preserves the repository grant and hides provider failures", async () => {
  const handler = createModelTurnHandler({
    ...options,
    callbackBaseUrl: "https://callback.test/nested",
    resolve: (accepted) => {
      expect(accepted.repositoryId).toBe(17)
      expect(accepted.producerBaseUrl).toBe("https://callback.test/")
      expect(accepted.request.tools).toEqual([])
      return options.resolve()
    }
  })
  const response = await handler(post(JSON.stringify({
    ...grant,
    repositoryId: 17,
    request: { ...grant.request, tools: [] },
    producerBaseUrl: "https://callback.test/other"
  })))
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ status: "error", code: "turn_failed" })
})
