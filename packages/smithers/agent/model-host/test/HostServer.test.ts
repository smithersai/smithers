import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { createHash } from "node:crypto"
import { createModelTurnHandler, MODEL_HOST_PROTOCOL } from "../src/HostServer.ts"

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
