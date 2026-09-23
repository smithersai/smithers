import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Request from "../src/ModelRequest.ts"

describe("ModelRequest", () => {
  it("round-trips every request part without changing order", () => {
    const request = Request.ModelRequest.make({
      modelId: "provider/model",
      system: [Request.SystemPart.make({ text: "system" })],
      messages: [
        Request.Message.user([Request.TextPart.make({ text: "question" })]),
        Request.Message.assistant([
          Request.TextPart.make({ text: "answer" }),
          Request.ThinkingPart.make({ text: "reasoning", signature: "signature" }),
          Request.ToolCallPart.make({ id: "call-1", name: "read", arguments: "{\"path\":\"a\"}" })
        ], { responseId: "response-1", itemIds: ["item-1"], stopReason: "tool-calls" }),
        Request.Message.tool(Request.ToolResultPart.make({
          toolCallId: "call-1",
          content: "contents",
          addedToolNames: ["search", "read"]
        }))
      ],
      tools: [
        Request.ToolDefinition.make({
          name: "search",
          description: "Search",
          parameters: { type: "object" },
          deferred: true
        }),
        Request.ToolDefinition.make({ name: "read", description: "Read", parameters: { type: "object" }, loader: true })
      ],
      params: Request.GenerationParams.make({
        maxTokens: 100,
        temperature: 0.1,
        topP: 0.9,
        topK: 10,
        stopSequences: ["END"],
        thinkingBudget: 20,
        reasoningEffort: "high"
      })
    })
    const encoded = Schema.encodeSync(Request.ModelRequest)(request)
    const decoded = Schema.decodeUnknownSync(Request.ModelRequest)(encoded)

    expect(decoded).toEqual(request)
    expect(decoded.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    expect(decoded.tools.map((tool) => tool.name)).toEqual(["search", "read"])
  })

  it("rejects non-text user content instead of silently dropping it", () => {
    expect(() =>
      Schema.decodeUnknownSync(Request.ModelRequest)({
        modelId: "provider/model",
        system: [],
        messages: [{
          role: "user",
          content: [{ type: "thinking", text: "not user content" }]
        }],
        tools: [],
        params: {}
      })
    ).toThrow()
  })

  it("accepts a string, a single part, or a list for every message constructor", () => {
    const text = Request.TextPart.make({ text: "one" })
    expect(Request.Message.user("one").content).toEqual([text])
    expect(Request.Message.user(text).content).toEqual([text])
    expect(Request.Message.user([text, Request.TextPart.make({ text: "two" })]).content).toHaveLength(2)
    expect(Request.Message.user([]).content).toEqual([])

    expect(Request.Message.assistant("one").content).toEqual([text])
    expect(Request.Message.assistant(text).content).toEqual([text])
    expect(Request.Message.assistant([]).content).toEqual([])
    // An unspecified stop reason is `unknown`, never a fabricated `stop`.
    expect(Request.Message.assistant("one")).toMatchObject({ stopReason: "unknown" })

    const result = Request.ToolResultPart.make({ toolCallId: "call", content: "out" })
    expect(result.addedToolNames).toEqual([])
    expect(Request.Message.tool(result).content).toEqual([result])
    expect(Request.Message.tool([result, result]).content).toHaveLength(2)
    expect(Request.Message.tool([]).content).toEqual([])
  })

  it("passes an already constructed value through every make", () => {
    const message = Request.Message.user("passthrough")
    expect(Request.Message.make(message)).toBe(message)

    const tool = Request.ToolDefinition.make({ name: "read", description: "Read", parameters: {} })
    expect(Request.ToolDefinition.make(tool)).toBe(tool)

    const params = Request.GenerationParams.make({ maxTokens: 1 })
    expect(Request.GenerationParams.make(params)).toBe(params)
    expect(Request.GenerationParams.make()).toEqual(Request.GenerationParams.make({}))

    const request = Request.ModelRequest.make({
      modelId: "model",
      system: [],
      messages: [],
      tools: [],
      params: Request.GenerationParams.make()
    })
    expect(Request.ModelRequest.make(request)).toBe(request)
  })

  it("carries every reasoning effort, an unset effort, and mixed sampling knobs", () => {
    const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
    for (const reasoningEffort of efforts) {
      const params = Request.GenerationParams.make({ reasoningEffort, maxTokens: 8, temperature: 0 })
      const decoded = Schema.decodeUnknownSync(Request.GenerationParams)(
        Schema.encodeSync(Request.GenerationParams)(params)
      )
      expect(decoded).toMatchObject({ reasoningEffort, maxTokens: 8, temperature: 0 })
    }

    expect(Request.GenerationParams.make({ maxTokens: 8 }).reasoningEffort).toBeUndefined()
    expect(() => Schema.decodeUnknownSync(Request.GenerationParams)({ reasoningEffort: "extreme" })).toThrow()

    // Zero and empty are declared values, not absent ones.
    const boundary = Request.GenerationParams.make({
      maxTokens: 0,
      temperature: 0,
      topP: 0,
      topK: 0,
      stopSequences: [],
      thinkingBudget: 0
    })
    expect(Schema.decodeUnknownSync(Request.GenerationParams)(Schema.encodeSync(Request.GenerationParams)(boundary)))
      .toEqual(boundary)
    expect(() => Schema.decodeUnknownSync(Request.GenerationParams)({ maxTokens: Number.NaN })).toThrow()
  })

  it("keeps toolChoice optional and rejects any value other than none", () => {
    const base = {
      modelId: "model",
      system: [],
      messages: [],
      tools: [],
      params: {}
    }
    expect(Schema.decodeUnknownSync(Request.ModelRequest)(base).toolChoice).toBeUndefined()
    expect(Schema.decodeUnknownSync(Request.ModelRequest)({ ...base, toolChoice: "none" }).toolChoice).toBe("none")
    expect(() => Schema.decodeUnknownSync(Request.ModelRequest)({ ...base, toolChoice: "auto" })).toThrow()
  })

  it("rejects non-JSON values anywhere in tool parameter schemas", () => {
    const make = (parameters: unknown) => ({
      modelId: "provider/model",
      system: [],
      messages: [],
      tools: [{ name: "invalid", description: "invalid", parameters }],
      params: {}
    })

    for (
      const parameters of [
        new Date(0),
        new Map([["key", "value"]]),
        { type: "number", multipleOf: Number.NaN },
        { type: "object", generatedAt: new Date(0) },
        { type: "object", metadata: new Map([["key", "value"]]) }
      ]
    ) {
      expect(() => Schema.decodeUnknownSync(Request.ModelRequest)(make(parameters))).toThrow()
    }
  })
})
