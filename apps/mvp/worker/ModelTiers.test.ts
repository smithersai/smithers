// Each role's tier and effort (worker/ModelTiers.ts, decision 0107): which turns are heavy, and which effort wins.
// The endpoint's use of them, on real routes, is in worker/personal/PersonalModels.test.ts and worker/ModelEndpoint.test.ts.
import { ModelRequest } from "@smthrs/model"
import { describe, expect, test } from "vitest"
import { acceptsEffort, effortOf, heavy, ROLE_TIERS } from "./ModelTiers.ts"

const request = (messages: ReadonlyArray<ModelRequest.Message>, reasoningEffort?: ModelRequest.ReasoningEffort) =>
  ModelRequest.ModelRequest.make({
    modelId: "m",
    system: [],
    messages: [...messages],
    tools: [],
    params: ModelRequest.GenerationParams.make({ maxTokens: 64, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }),
  })

const user = ModelRequest.Message.user("sort these")
const called = ModelRequest.Message.assistant(ModelRequest.ToolCallPart.make({ id: "c1", name: "app/jev/classify", arguments: "{}" }))
const result = ModelRequest.Message.tool(ModelRequest.ToolResultPart.make({ toolCallId: "c1", content: "{}" }))
const answer = ModelRequest.Message.assistant("done")

describe("heavy", () => {
  test("a turn is heavy once the agent used a tool since the person's last message", () => {
    expect(heavy(request([user]))).toBe(false)
    expect(heavy(request([user, called, result]))).toBe(true)
    expect(heavy(request([user, called, result, answer]))).toBe(true)
    // A new message from the person starts a light turn again.
    expect(heavy(request([user, called, result, answer, user]))).toBe(false)
    // With no message from the person, a tool result still makes it heavy; nothing else does.
    expect(heavy(request([called, result]))).toBe(true)
    expect(heavy(request([answer]))).toBe(false)
  })
})

describe("acceptsEffort", () => {
  test("Claude and reasoning models take an effort, after any gateway prefix; other models don't", () => {
    for (const id of ["claude-haiku-4-5", "o3", "o4-mini", "gpt-5", "gpt-6.1-sol", "gpt-oss-120b", "openai/gpt-5", "anthropic/claude-opus-5-5"]) {
      expect(acceptsEffort(id), id).toBe(true)
    }
    for (const id of ["gpt-4.1-mini", "gpt-4o", "qwen-3.8-27b", "llama-4", "ollama", "openai/gpt-4.1-mini"]) {
      expect(acceptsEffort(id), id).toBe(false)
    }
  })
})

describe("effortOf", () => {
  test("a record's effort wins, then the role's hint where the model takes one (heavy first), then the request's", () => {
    const working = request([user, called, result], "medium")
    const chatting = request([user], "medium")
    expect(effortOf(ROLE_TIERS.agent, working, "gpt-6-luna", "minimal")).toBe("minimal")
    expect(effortOf(ROLE_TIERS.agent, working, "gpt-6-luna")).toBe("high")
    expect(effortOf(ROLE_TIERS.agent, chatting, "gpt-6-luna")).toBe("medium")
    expect(effortOf(ROLE_TIERS.judge, working, "gpt-6-luna")).toBe("low")
    expect(effortOf(ROLE_TIERS.coding, request([user]), "gpt-6-luna")).toBeUndefined()
    // A model that refuses an effort gets no hint: the request's own, or none.
    expect(effortOf(ROLE_TIERS.judge, working, "gpt-4.1-mini")).toBe("medium")
    expect(effortOf(ROLE_TIERS.judge, request([user]), "gpt-4.1-mini")).toBeUndefined()
    // A record's effort is its author's choice for that model: it stands.
    expect(effortOf(ROLE_TIERS.judge, request([user]), "gpt-4.1-mini", "none")).toBe("none")
  })
})
