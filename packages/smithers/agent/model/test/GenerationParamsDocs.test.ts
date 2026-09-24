import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as AnthropicMessages from "../src/AnthropicMessages.ts"
import { GenerationParams, ModelRequest } from "../src/ModelRequest.ts"
import * as OpenAIChatCompletions from "../src/OpenAIChatCompletions.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

/** A request that states no generation knob at all: every field is omitted. */
const bare = ModelRequest.make({
  modelId: "claude-sonnet-4-5",
  system: [],
  messages: [],
  tools: [],
  params: GenerationParams.make()
})

// The budget the docs must quote is read out of the lowering rather than
// written here, so the documented contract cannot drift from the adapter.
const anthropicDefault = Effect.runSync(AnthropicMessages.protocol.body.from(bare, { native: true })).max_tokens

describe("generation parameter contract", () => {
  it("states the Anthropic budget the lowering inserts for an omitted maxTokens", () => {
    expect(anthropicDefault).toBe(4096)
  })

  it("omits the budget on the OpenAI protocols, which do leave the provider default", () => {
    const responses = Effect.runSync(OpenAIResponses.protocol.body.from(bare, { native: true }))
    const chat = Effect.runSync(OpenAIChatCompletions.protocol.body.from(bare, { native: false }))

    expect(responses).not.toHaveProperty("max_output_tokens")
    expect(chat).not.toHaveProperty("max_tokens")
  })

  it("drops a stated knob the protocol has no wire field for, which is not a provider default", () => {
    const stated = ModelRequest.make({
      modelId: "gpt-5",
      system: [],
      messages: [],
      tools: [],
      params: GenerationParams.make({ topK: 40, stopSequences: ["STOP"], thinkingBudget: 1024 })
    })
    const responses = Effect.runSync(OpenAIResponses.protocol.body.from(stated, { native: true }))
    const chat = Effect.runSync(OpenAIChatCompletions.protocol.body.from(stated, { native: false }))

    for (const body of [responses, chat] as ReadonlyArray<Record<string, unknown>>) {
      expect(body).not.toHaveProperty("top_k")
      expect(body).not.toHaveProperty("stop")
      expect(body).not.toHaveProperty("thinking")
    }
  })

  it.each([
    [
      "the conceptual guide",
      "../docs/concepts/schema-first.md",
      (text: string) => text.split("\n\n").find((block) => block.includes("`GenerationParams` follows the same"))
    ],
    [
      "the API reference table",
      "../docs/api.md",
      (text: string) => text.split("\n").find((line) => line.startsWith("| `GenerationParams`"))
    ],
    [
      "the GenerationParams JSDoc",
      "../src/ModelRequest.ts",
      (text: string) => text.split("export class GenerationParams")[0]?.split("/**").at(-1)
    ]
  ])("qualifies the omitted-field rule where %s states it", (_label, path, extract) => {
    const passage = extract(source(path))

    expect(passage, `the omitted-field passage in ${path}`).toBeDefined()
    expect(passage).toMatch(/omitted/)
    expect(passage, `${path} must qualify the omitted-field rule with the Anthropic budget`).toContain(
      String(anthropicDefault)
    )
    expect(passage).toMatch(/Anthropic/)
    expect(passage, `${path} must say where Anthropic's reasoningEffort goes`).toContain("output_config.effort")
    expect(passage).toContain("maxOutputTokensFor")
  })
})
