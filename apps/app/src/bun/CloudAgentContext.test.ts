import { describe, expect, test } from "bun:test"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import { createCloudAgent } from "./CloudAgent"

const context: AgentRuntimeContext = {
  version: 1,
  product: "smithers",
  capturedAt: 1786223000000,
  revision: 3,
  surface: "world",
  theme: "light",
  selectedWorldDocument: "Notes.md",
  connectors: [],
  github: { connected: false, login: null, repositories: null },
  worldState: {
    documentCount: 1,
    documents: [{ path: "Notes.md", title: "Notes", confidence: 1 }]
  },
  capabilities: ["Hold a streaming conversation in this chat and read its visible transcript."],
  limitations: ["Cannot see or control the host environment beyond what this context block states."]
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("createCloudAgent runtime context", () => {
  test("renders the turn context into the upstream instructions, server-side only", async () => {
    let upstreamBody: Record<string, unknown> | undefined
    const agent = createCloudAgent(() => {}, {
      chatUrl: "https://example.test/chat",
      fetchImpl: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{\"type\":\"done\"}\n"))
              controller.close()
            }
          }),
          { status: 200 }
        )
      }
    })

    agent.start({
      runId: "run-context",
      messages: [{ role: "user", content: "hey smithers what app am I in" }],
      instructions: "Be brief.",
      context
    })
    await flush()

    const instructions = String(upstreamBody?.instructions)
    expect(instructions.startsWith("Be brief.")).toBe(true)
    expect(instructions).toContain("running INSIDE the Smithers product")
    expect(instructions).toContain("Current surface: world")
    expect(instructions).toContain("wiki note open: \"Notes.md\"")
    expect(upstreamBody?.messages).toEqual([{ role: "user", content: "hey smithers what app am I in" }])
    expect(upstreamBody && "context" in upstreamBody).toBe(false)
  })

  test("a turn without context sends the instructions untouched", async () => {
    let upstreamBody: Record<string, unknown> | undefined
    const agent = createCloudAgent(() => {}, {
      chatUrl: "https://example.test/chat",
      fetchImpl: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{\"type\":\"done\"}\n"))
              controller.close()
            }
          }),
          { status: 200 }
        )
      }
    })

    agent.start({
      runId: "run-plain",
      messages: [{ role: "user", content: "hi" }],
      instructions: "Be brief."
    })
    await flush()

    expect(upstreamBody?.instructions).toBe("Be brief.")
  })
})
