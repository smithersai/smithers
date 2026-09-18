import { describe, expect, it } from "vitest"
import * as Pricing from "../src/Pricing.ts"
import * as Projection from "../src/Projection.ts"
import * as Protocol from "../src/Protocol.ts"

describe("Pricing", () => {
  it("prices the starter seats and nothing else", () => {
    expect(Pricing.pricingOf("cerebras:gpt-oss-120b")).toEqual({ inputPerMillion: 0.25, outputPerMillion: 0.69 })
    expect(Pricing.pricingOf("anthropic:claude-sonnet-4-5")).toMatchObject({ inputPerMillion: 3, outputPerMillion: 15 })
    expect(Pricing.pricingOf("openrouter:anthropic/claude-sonnet-4.5")).toBe(
      Pricing.pricingOf("anthropic:claude-sonnet-4-5")
    )
    expect(Pricing.pricingOf("gemini:gemini-2.5-pro")).toEqual({ inputPerMillion: 1.25, outputPerMillion: 10 })
    expect(Pricing.pricingOf("scripted:demo")).toBeUndefined()
    expect(Pricing.pricingOf("openai:gpt-5.6-sol")).toBeUndefined()
    // Four hundred thousand input tokens on Cerebras are ten cents, not zero.
    const tokens: Protocol.Tokens = { ...Protocol.noTokens, input: 400_000 }
    expect(Projection.costOf(tokens, Pricing.pricingOf("cerebras:gpt-oss-120b"))).toBeCloseTo(0.1)
  })
})
