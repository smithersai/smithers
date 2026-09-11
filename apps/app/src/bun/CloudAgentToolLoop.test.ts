import { describe, expect, test } from "bun:test"
import type { AgentToolSpec, AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { createCloudAgent } from "./CloudAgent"

/*
 * The native/dev boundary must speak the SAME tool-loop contract as the product
 * Worker (apps/server/src/index.ts). It previously forwarded neither the tool specs
 * nor the tool_call / done.reason frames, so the whole Wave-3b loop was dead on
 * the native app and on `bun dev` while passing on the deployed Worker.
 */

const toolSpec: AgentToolSpec = {
  type: "function",
  name: "commands",
  description: "Run an app command.",
  parameters: { type: "object", properties: {}, additionalProperties: false }
}

const ndjsonResponse = (lines: ReadonlyArray<unknown>): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        controller.close()
      }
    }),
    { status: 200 }
  )

const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("createCloudAgent tool loop", () => {
  test("forwards the turn's tool specs upstream untouched", async () => {
    let upstreamBody: Record<string, unknown> | undefined
    const agent = createCloudAgent(() => {}, {
      chatUrl: "https://example.test/chat",
      fetchImpl: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return ndjsonResponse([{ type: "done" }])
      }
    })

    agent.start({
      runId: "run-tools",
      messages: [{ role: "user", content: "make me a note" }],
      instructions: "Be brief.",
      tools: [toolSpec]
    })
    await flush()

    expect(upstreamBody?.tools).toEqual([toolSpec])
  })

  test("omits `tools` entirely when the turn offers none", async () => {
    let upstreamBody: Record<string, unknown> | undefined
    const agent = createCloudAgent(() => {}, {
      chatUrl: "https://example.test/chat",
      fetchImpl: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return ndjsonResponse([{ type: "done" }])
      }
    })

    agent.start({
      runId: "run-no-tools",
      messages: [{ role: "user", content: "hi" }],
      instructions: "Be brief."
    })
    await flush()

    expect(upstreamBody && "tools" in upstreamBody).toBe(false)
  })

  test("publishes the upstream tool_call frame instead of dropping it", async () => {
    const frames: AgentTurnFrame[] = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      chatUrl: "https://example.test/chat",
      fetchImpl: async () =>
        ndjsonResponse([
          {
            type: "tool_call",
            call_id: "call-1",
            name: "commands",
            arguments: "{\"command\":\"world.new-note\"}"
          },
          { type: "done", reason: "tool_call" }
        ])
    })

    agent.start({
      runId: "run-call",
      messages: [{ role: "user", content: "make me a note" }],
      instructions: "Be brief.",
      tools: [toolSpec]
    })
    await flush()

    expect(frames).toEqual([
      {
        runId: "run-call",
        type: "tool_call",
        call_id: "call-1",
        name: "commands",
        arguments: "{\"command\":\"world.new-note\"}"
      },
      { runId: "run-call", type: "done", reason: "tool_call" }
    ])
  })

  test("carries done.reason so an upstream tool_limit stays honest", async () => {
    const frames: AgentTurnFrame[] = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      chatUrl: "https://example.test/chat",
      fetchImpl: async () => ndjsonResponse([{ type: "done", reason: "tool_limit" }])
    })

    agent.start({
      runId: "run-limit",
      messages: [{ role: "user", content: "loop forever" }],
      instructions: "Be brief.",
      tools: [toolSpec]
    })
    await flush()

    expect(frames).toEqual([{ runId: "run-limit", type: "done", reason: "tool_limit" }])
  })

  test("a foreign done.reason is rejected as a malformed frame, never invented", async () => {
    const frames: AgentTurnFrame[] = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      chatUrl: "https://example.test/chat",
      fetchImpl: async () => ndjsonResponse([{ type: "done", reason: "made-up" }])
    })

    agent.start({
      runId: "run-bogus",
      messages: [{ role: "user", content: "hi" }],
      instructions: "Be brief."
    })
    await flush()

    // The bad frame is dropped; the stream still settles honestly at EOF.
    expect(frames).toEqual([{ runId: "run-bogus", type: "done" }])
  })
})
