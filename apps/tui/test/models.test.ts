import { describe, expect, test } from "bun:test"
import * as Models from "../src/models.ts"

describe("seatOf", () => {
  const available: ReadonlyArray<Models.Model> = [{ seat: "test:worker", label: "Test", provider: "Test" }]
  test.each([
    ["sol", "openai:gpt-6-sol"],
    ["astra", "openai:gpt-6-astra"],
    ["luna", Models.delegateModels.luna],
    ["opus", "anthropic:claude-opus-5-5"],
    ["fable", "anthropic:claude-fable-5-1"],
    ["qwen", Models.delegateModels.cerebras],
    [" Sol ", "openai:gpt-6-sol"],
    ["openai:gpt-6-sol", "openai:gpt-6-sol"],
    ["anthropic:claude-opus-5-5", "anthropic:claude-opus-5-5"],
    ["cerebras:gpt-oss-120b", "cerebras:gpt-oss-120b"],
    ["test:other", "test:other"],
    ["gpt-9", undefined],
    ["nowhere:model", undefined],
    ["openai:", undefined],
    ["", undefined]
  ] as const)("%p resolves to %p", (declared, seat) => {
    expect(Models.seatOf(declared, available)).toBe(seat)
  })
})
