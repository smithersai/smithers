import { WebCrypto } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Model } from "@smthrs/model"
import { Node } from "@smthrs/plan"
import { AgentTurnJournal, type NativeAgent } from "@smthrs/rpc"
import { Effect, Exit, Layer, Option, Schedule, Schema, Stream } from "effect"
import { HttpEffect } from "effect/http"
import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "vitest"
import { runDurableChatTurn as durableTurn } from "../src/DurableChatProducer.vibe"
import { environmentModelResolver } from "../src/EnvironmentResolver.vibe"
import { runContextPreflight } from "./fixtures/durable.ts"
import { DurableChatProducer, runDurableChatTurn } from "./fixtures/durable.ts"
import { createModelTurnHandler, MODEL_HOST_STREAM_PATH } from "./fixtures/durable.ts"
import { runModelTurn } from "./fixtures/durable.ts"

const cursor = { version: 1 as const, runId: "run", legId: "leg", batch: 0, position: 0, hash: "a".repeat(64) }
const grant = {
  turnId: "turn",
  ownerId: 1,
  runId: "run",
  legId: "leg",
  generation: 1,
  token: "capability_capability_capability_1234",
  cursor,
  expiresAt: "2100-01-01",
  request: { runId: "run", instructions: "answer", messages: [{ role: "user" as const, content: "hi" }] },
  producerBaseUrl: "http://localhost"
}
const frame: NativeAgent.AgentTurnFrame = { runId: "run", type: "delta", kind: "text", text: "a" }
const listen = async (handle: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
const read = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString())
}
const receipt = (expected: typeof cursor, frames: NativeAgent.AgentTurnFrame[]) => {
  const unsigned = {
    version: 1,
    runId: expected.runId,
    legId: expected.legId,
    batch: expected.batch + 1,
    from: expected.position + 1,
    previousHash: expected.hash,
    frames
  }
  const hash = createHash("sha256").update(AgentTurnJournal.agentTurnJournalDigestInput("batch", unsigned)).digest(
    "hex"
  )
  return {
    status: "committed",
    batch: { ...unsigned, hash },
    cursor: {
      ...expected,
      batch: unsigned.batch,
      position: unsigned.from + frames.length - 1,
      hash
    }
  }
}

test("constructing writes before running them extends the latest committed cursor", async () => {
  let committed = cursor
  const positions: number[] = []
  const journal = await listen((request, response) => {
    void read(request).then((body) => {
      positions.push(body.expected.position)
      if (JSON.stringify(body.expected) !== JSON.stringify(committed)) {
        response.writeHead(409).end()
        return
      }
      const reply = receipt(committed, body.frames)
      committed = reply.cursor
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply))
    })
  })
  try {
    const producer = new DurableChatProducer(journal.origin, grant)
    const writes = [producer.write(frame), producer.write({ ...frame, text: "b" })]
    await Effect.runPromise(Effect.all(writes, { concurrency: 1 }))
    expect(positions).toEqual([0, 1])
    expect(committed.position).toBe(2)
  } finally {
    await journal.close()
  }
})

test.each(["refused", "malformed", "invalid-json"])("does not retry a %s commit response", async (mode) => {
  let calls = 0
  const journal = await listen((_request, response) => {
    calls++
    response.writeHead(mode === "refused" ? 409 : 200, { "content-type": "application/json" })
      .end(mode === "invalid-json" ? "{" : "{}")
  })
  try {
    const producer = new DurableChatProducer(journal.origin, grant)
    const error = await Effect.runPromise(Effect.flip(producer.write(frame)))
    expect(error._tag).toBe(mode === "refused" ? "CommitRefused" : "ReceiptMismatch")
    expect(calls).toBe(1)
  } finally {
    await journal.close()
  }
})

const completion = (text: string) =>
  [text.slice(0, 6), text.slice(6)].map((content) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
  ).join("") +
  "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
const selection = {
  prompt: "Select context",
  author: "owner",
  branch: "main",
  state: "ready",
  recent: [],
  candidates: [],
  tokenBudget: 24000,
  wikiOnly: false
}
const provider = async (text: string) => {
  const notifications: Array<string | undefined> = []
  const server = await listen((request, response) => {
    if (request.url === "/fast/selected") {
      notifications.push(request.headers.authorization)
      response.writeHead(204).end()
    } else if (request.url?.startsWith("/fast")) {
      response.writeHead(429, { "content-type": "application/json" }).end("{\"error\":{\"message\":\"capacity\"}}")
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" }).end(completion(text))
    }
  })
  const binding = { protocol: "openai-chat", baseUrl: server.origin, modelId: "answer", credential: "ANSWER" }
  const fast = { ...binding, baseUrl: `${server.origin}/fast`, credential: "SMITHERS_FAST_PROXY" }
  const fallback = { ...binding, modelId: "fallback", credential: "FALLBACK" }
  const env = {
    SMITHERS_MODEL_KEY_ANSWER: "answer-credential",
    SMITHERS_MODEL_KEY_ANSWER_ORIGIN: server.origin,
    SMITHERS_MODEL_KEY_SMITHERS_FAST_PROXY: "proxy-credential",
    SMITHERS_MODEL_KEY_SMITHERS_FAST_PROXY_ORIGIN: server.origin,
    SMITHERS_MODEL_KEY_FALLBACK: "fallback-credential",
    SMITHERS_MODEL_KEY_FALLBACK_ORIGIN: server.origin,
    SMITHERS_FAST_FALLBACK_MODELS: JSON.stringify([fallback])
  }
  return { ...server, binding, fast, env, notifications }
}

test("preflight fallback notification authenticates with the preflight credential", async () => {
  const upstream = await provider("[]")
  // A separately pinned answer origin makes cross-origin credential leakage observable.
  const answer = await listen((_request, response) => {
    response.writeHead(500).end()
  })
  try {
    const resolved = await Effect.runPromise(
      environmentModelResolver({
        binding: { ...upstream.binding, baseUrl: answer.origin },
        preflightBinding: upstream.fast,
        env: { ...upstream.env, SMITHERS_MODEL_KEY_ANSWER_ORIGIN: answer.origin }
      })(grant, selection)
    )
    await Effect.runPromise(
      runModelTurn(resolved.preflight!.model, grant.request, resolved.preflight!.options, () => Effect.void)
    )
    expect(upstream.notifications).toEqual(["Bearer proxy-credential"])
  } finally {
    await upstream.close()
    await answer.close()
  }
})

test("a fallback credential echoed across output chunks is removed", async () => {
  const upstream = await provider("fallback-credential")
  try {
    const resolved = await Effect.runPromise(
      environmentModelResolver({ binding: upstream.fast, env: upstream.env })(grant)
    )
    const frames: NativeAgent.AgentTurnFrame[] = []
    await Effect.runPromise(runModelTurn(resolved.model, grant.request, resolved.options, (frame) =>
      Effect.sync(() => {
        frames.push(frame)
      })))
    expect(frames.filter((frame) => frame.type === "delta").map((frame) => frame.text).join("")).not.toContain(
      "fallback-credential"
    )
    expect(frames.at(-1)).toMatchObject({ type: "done" })
  } finally {
    await upstream.close()
  }
})

test.each([
  { messages: [null] },
  { messages: [{ role: "system", content: "untrusted" }] },
  { messages: [{ type: "function_call", call_id: "id", arguments: "{}" }] },
  { tools: [null] },
  { tools: [{ type: "function", name: "inspect", description: "inspect", parameters: [] }] }
])("malformed stream items are refused before resolving or calling the model (%j)", async (invalid) => {
  let resolutions = 0
  const handler = HttpEffect.toWebHandler(createModelTurnHandler({
    authorization: "host-token",
    callbackBaseUrl: "http://localhost",
    resolve: () => {
      resolutions++
      return Effect.succeed({ model: Model.make({ stream: () => Stream.empty }), options: { modelId: "fixture" } })
    }
  }))
  for (const path of [MODEL_HOST_STREAM_PATH, "/v1/chat/turn"]) {
    const request = { ...grant.request, ...invalid }
    const response = await handler(
      new Request(`http://host.test${path}`, {
        method: "POST",
        headers: { authorization: "Bearer host-token", "content-type": "application/json" },
        body: JSON.stringify(path === MODEL_HOST_STREAM_PATH ? request : { ...grant, request })
      })
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ status: "error", code: "request_invalid" })
  }
  expect(resolutions).toBe(0)
})

test("a completed selection replays after the answer fails", async () => {
  let committed = cursor
  let selections = 0
  const frames: NativeAgent.AgentTurnFrame[] = []
  const server = await listen((request, response) => {
    if (request.url?.startsWith("/internal/chat/provider-started")) {
      response.writeHead(204).end()
      return
    }
    if (request.method !== "POST") {
      response.writeHead(404).end()
      return
    }
    void read(request).then((body) => {
      if (request.url === "/internal/chat/commit") {
        const reply = receipt(committed, body.frames)
        committed = reply.cursor
        frames.push(...body.frames)
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply))
      } else if (body.model === "selector") {
        selections++
        response.writeHead(200, { "content-type": "text/event-stream" }).end(completion("[]"))
      } else {
        response.writeHead(400, { "content-type": "application/json" }).end(
          "{\"error\":{\"message\":\"invalid request\"}}"
        )
      }
    })
  })
  try {
    const binding = { protocol: "openai-chat", baseUrl: server.origin, modelId: "answer", credential: "PROVIDER" }
    const resolver = environmentModelResolver({
      binding,
      preflightBinding: { ...binding, modelId: "selector" },
      env: { SMITHERS_MODEL_KEY_PROVIDER: "provider-key", SMITHERS_MODEL_KEY_PROVIDER_ORIGIN: server.origin }
    })
    const flow = Flow.make("model-host/selection-recovery", {
      payload: {},
      success: Schema.Void,
      error: Schema.Unknown,
      body: () => Node.succeed(undefined)
    })
    let passes = 0
    await Effect.runPromise(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(flow, () =>
          Effect.gen(function*() {
            passes++
            const resumed = { ...grant, cursor: committed, producerBaseUrl: server.origin }
            const resolved = yield* resolver(resumed, selection)
            const exit = yield* Effect.exit(durableTurn(
              resolved.model,
              resumed,
              resolved.options,
              server.origin,
              undefined,
              resolved.preflight
            ))
            expect(exit._tag).toBe("Failure")
            if (passes === 1) return yield* Flow.suspend(yield* FlowRuntime.FlowInstance)
          }))
        yield* engine.execute(flow, { executionId: "selection-recovery", payload: {}, discard: true })
        const parked = yield* engine.poll(flow, "selection-recovery").pipe(Effect.repeat({
          schedule: Schedule.spaced("1 milli"),
          until: Option.isSome
        }))
        expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
        yield* engine.resume(flow, "selection-recovery")
        const result = yield* engine.poll(flow, "selection-recovery").pipe(Effect.repeat({
          schedule: Schedule.spaced("1 milli"),
          until: (value) => Option.isSome(value) && value.value._tag === "Complete"
        }))
        expect(Option.isSome(result) && result.value._tag === "Complete" && result.value.exit).toEqual(
          Exit.succeed(undefined)
        )
      }).pipe(Effect.provide(Layer.merge(FlowEngine.layerMemory, WebCrypto.layer)), Effect.scoped)
    )
    expect(passes).toBe(2)
    expect(frames.some((frame) => frame.type === "context.preflight" && frame.phase === "completed")).toBe(true)
    expect(selections).toBe(1)
  } finally {
    await server.close()
  }
})

test("a lost receipt body retries the identical committed batch", async () => {
  let partial: ServerResponse | undefined
  const bodies: unknown[] = []
  const journal = await listen((request, response) => {
    void read(request).then((body) => {
      bodies.push(body)
      response.writeHead(200, { "content-type": "application/json" })
      if (bodies.length === 1) {
        partial = response
        response.write("{\"status\":")
      } else response.end(JSON.stringify({ ...receipt(cursor, body.frames), status: "duplicate" }))
    })
  })
  try {
    const producer = new DurableChatProducer(journal.origin, grant, async (input, init) => {
      const response = await fetch(input, init)
      // Cut the socket only after fetch received the headers, during receipt reading.
      partial?.destroy()
      partial = undefined
      return response
    })
    await Effect.runPromise(producer.write(frame))
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toEqual(bodies[1])
  } finally {
    await journal.close()
  }
})

test("preflight reasons remove the credential of the selected fallback", async () => {
  const upstream = await provider("[{\"index\":0,\"reason\":\"relevant fallback-credential\"}]")
  try {
    const input = {
      ...selection,
      candidates: [{ item: { kind: "page" as const, label: "Policy", ref: "policy", revision: "1" }, text: "Policy" }]
    }
    const resolved = await Effect.runPromise(
      environmentModelResolver({ binding: upstream.fast, env: upstream.env })(grant, input)
    )
    const preflight = resolved.preflight!
    const answer = await Effect.runPromise(runContextPreflight(input, preflight.model, preflight.options))
    expect(answer.result.context[0]?.reason).toBe("relevant ")
    expect(JSON.stringify(answer)).not.toContain("fallback-credential")
  } finally {
    await upstream.close()
  }
})
