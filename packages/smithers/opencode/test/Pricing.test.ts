import { describe, expect, it } from "vitest"
import * as Pricing from "../src/Pricing.ts"
import * as Projection from "../src/Projection.ts"
import * as Protocol from "../src/Protocol.ts"

describe("Pricing", () => {
  it("prices the starter seats and nothing else", () => {
    expect(Pricing.pricingOf("cerebras:qwen-3.8-27b")).toEqual({ inputPerMillion: 0.99, outputPerMillion: 1.49 })
    // gpt-oss-120b is no longer the default seat, but Cerebras still serves it
    // and a person may pick it, so its price stays in the table.
    expect(Pricing.pricingOf("cerebras:gpt-oss-120b")).toEqual({ inputPerMillion: 0.25, outputPerMillion: 0.69 })
    expect(Pricing.pricingOf("anthropic:claude-sonnet-4-5")).toMatchObject({ inputPerMillion: 3, outputPerMillion: 15 })
    expect(Pricing.pricingOf("openrouter:anthropic/claude-sonnet-4.5")).toBe(
      Pricing.pricingOf("anthropic:claude-sonnet-4-5")
    )
    expect(Pricing.pricingOf("gemini:gemini-2.5-pro")).toEqual({ inputPerMillion: 1.25, outputPerMillion: 10 })
    expect(Pricing.pricingOf("scripted:demo")).toBeUndefined()
    expect(Pricing.pricingOf("openai:gpt-5.6-sol")).toBeUndefined()
    // Four hundred thousand input tokens on the Cerebras default seat are
    // 39.6 cents, not zero, and a cached one bills at the same input rate.
    const tokens: Protocol.Tokens = { ...Protocol.noTokens, input: 400_000 }
    expect(Projection.costOf(tokens, Pricing.pricingOf("cerebras:qwen-3.8-27b"))).toBeCloseTo(0.396)
    const cached: Protocol.Tokens = { ...Protocol.noTokens, cache: { read: 400_000, write: 0 } }
    expect(Projection.costOf(cached, Pricing.pricingOf("cerebras:qwen-3.8-27b"))).toBeCloseTo(0.396)
  })
})
