// Each role's tier and effort (worker/ModelTiers.ts, decision 0107): which turns are heavy, and which effort wins.
// The endpoint's use of them, on real routes, is in worker/personal/PersonalModels.test.ts and worker/ModelEndpoint.test.ts.
import { ModelRequest } from "@smthrs/model"
import { describe, expect, test } from "vitest"
import { effortOf, heavy, ROLE_TIERS } from "./ModelTiers.ts"

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

describe("effortOf", () => {
  test("a record's effort wins, then the role's heavy effort on a heavy turn, then the role's, then the request's", () => {
    const working = request([user, called, result], "medium")
    const chatting = request([user], "medium")
    expect(effortOf(ROLE_TIERS.agent, working, "minimal")).toBe("minimal")
    expect(effortOf(ROLE_TIERS.agent, working)).toBe("high")
    expect(effortOf(ROLE_TIERS.agent, chatting)).toBe("medium")
    expect(effortOf(ROLE_TIERS.judge, working)).toBe("low")
    expect(effortOf(ROLE_TIERS.coding, request([user]))).toBeUndefined()
  })
})
