import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { describe, test } from "vitest"
import * as CanonicalJson from "../src/CanonicalJson.ts"
import * as Framing from "../src/Framing.ts"
import * as ModelEvent from "../src/ModelEvent.ts"
import * as Pricing from "../src/Pricing.ts"

const canonicalPayload = {
  model: "claude-sonnet-4-6",
  max_tokens: 4096,
  temperature: 0,
  messages: Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `Turn ${i}: inspect packages/smithers/agent/model/src/index.ts` }]
  })),
  tools: Array.from({ length: 10 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Execute action ${i}`,
    input_schema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, dryRun: { type: "boolean" } }
    }
  }))
}

const encoder = new TextEncoder()
const sseChunks: ReadonlyArray<Uint8Array> = Array.from({ length: 100 }, (_, i) =>
  encoder.encode(
    `event: content_block_delta\ndata: ${
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `token-${i} ` } })
    }\n\n`
  ))

const sampleUsage = ModelEvent.Usage.make({
  inputTokens: 12_500,
  outputTokens: 1_850,
  cachedInputTokens: 8_000,
  cacheWriteTokens: 2_000,
  totalTokens: 14_350
})

describe("model hot paths", () => {
  test("CanonicalJson.stringify and shortHash", async ({ bench }) => {
    await bench("canonicalize + hash 20-turn request payload", () => {
      const encoded = CanonicalJson.stringify(canonicalPayload)
      CanonicalJson.shortHash(encoded)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Framing.sse.frame", async ({ bench }) => {
    const program = Framing.sse.frame(Stream.fromIterable(sseChunks)).pipe(Stream.runCollect)
    await bench("frame 100 SSE byte chunks", async () => {
      const events = await Effect.runPromise(program)
      if (events.length === 0) throw new Error("expected events")
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Pricing.cost", async ({ bench }) => {
    await bench("lookup pricing and compute USD cost", () => {
      Pricing.cost(sampleUsage, "claude-sonnet-4-6")
      Pricing.cost(sampleUsage, "gpt-5.4")
      Pricing.cost(sampleUsage, "gemini-2.5-pro")
    }).run({ time: 120, warmupTime: 30 })
  })
})
