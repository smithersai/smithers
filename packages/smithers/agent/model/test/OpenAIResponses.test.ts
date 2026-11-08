import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as CanonicalJson from "../src/CanonicalJson.ts"
import * as Events from "../src/ModelEvent.ts"
import * as Request from "../src/ModelRequest.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"

const fixture = (name: string): ReadonlyArray<{ readonly event?: string; readonly data: string }> => {
  const source = readFileSync(new URL(`./fixtures/openai/${name}`, import.meta.url), "utf8")
  // Deliberately split this read at irregular boundaries before rebuilding SSE frames.
  const chunks = [source.slice(0, 17), source.slice(17, 61), source.slice(61)]
  const frames: Array<{ readonly event?: string; readonly data: string }> = []
  for (const block of chunks.join("").trim().split("\n\n")) {
    const event = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7)
    const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    if (data !== undefined) frames.push(event !== undefined ? { event, data } : { data })
  }
  return frames
}

const streamRequest = Request.ModelRequest.make({
  modelId: "gpt-5.4",
  system: [],
  messages: [],
  tools: [],
  params: Request.GenerationParams.make()
})

const step = (
  state: ReturnType<typeof OpenAIResponses.protocol.stream.initial>,
  data: string
) => {
  const event = Schema.decodeUnknownSync(OpenAIResponses.protocol.stream.event)(data)
  return Effect.runSync(OpenAIResponses.protocol.stream.step(state, event))
}

const body = (modelRequest: Request.ModelRequest, native = true): OpenAIResponses.Body =>
  Effect.runSync(OpenAIResponses.protocol.body.from(modelRequest, { native }))

const replay = (name: string) => {
  let state = OpenAIResponses.protocol.stream.initial(streamRequest)
  const events: Array<Events.ModelEvent> = []
  for (const frame of fixture(name)) {
    const [next, emitted] = step(state, frame.data)
    state = next
    events.push(...emitted)
  }
  events.push(...(OpenAIResponses.protocol.stream.onHalt?.(state) ?? []))
  return events
}

const replayData = (data: ReadonlyArray<string>, finalize = false): ReadonlyArray<Events.ModelEvent> => {
  let state = OpenAIResponses.protocol.stream.initial(streamRequest)
  const events: Array<Events.ModelEvent> = []
  for (const datum of data) {
    const [next, emitted] = step(state, datum)
    state = next
    events.push(...emitted)
  }
  if (finalize) events.push(...(OpenAIResponses.protocol.stream.onHalt?.(state) ?? []))
  return events
}

const replayDataError = (data: ReadonlyArray<string>) => {
  let state = OpenAIResponses.protocol.stream.initial(streamRequest)
  for (const datum of data.slice(0, -1)) {
    const [next] = step(state, datum)
    state = next
  }
  const last = data[data.length - 1] ?? ""
  const event = Schema.decodeUnknownSync(OpenAIResponses.protocol.stream.event)(last)
  return Effect.runSync(OpenAIResponses.protocol.stream.step(state, event).pipe(Effect.flip))
}

const request = (modelId = "gpt-5.4"): Request.ModelRequest =>
  Request.ModelRequest.make({
    modelId,
    system: [Request.SystemPart.make({ text: "Be exact." })],
    messages: [
      Request.Message.user("Find it"),
      Request.Message.assistant(Request.ToolCallPart.make({ id: "call_loader", name: "search", arguments: "{}" }), {
        stopReason: "tool-calls"
      }),
      Request.Message.tool(
        Request.ToolResultPart.make({ toolCallId: "call_loader", content: "loaded", addedToolNames: ["read_file"] })
      )
    ],
    tools: [
      Request.ToolDefinition.make({ name: "search", description: "search tools", parameters: {}, loader: true }),
      Request.ToolDefinition.make({ name: "read_file", description: "read a file", parameters: {}, deferred: true })
    ],
    params: Request.GenerationParams.make({ maxTokens: 16, temperature: 0, topP: 1 })
  })

describe("OpenAIResponses", () => {
  it("classifies a streamed ChatGPT usage limit with its reset", () => {
    const error = replayDataError([
      "{\"type\":\"response.failed\",\"response\":{\"error\":{\"type\":\"usage_limit_reached\",\"message\":\"The usage limit has been reached\",\"resets_at\":1790300000}}}"
    ])
    expect(error).toMatchObject({
      code: "rate_limited",
      resetAtEpochMillis: 1_790_300_000_000,
      resetSource: "stream.error.resets_at"
    })
    expect(replayDataError([
      "{\"type\":\"error\",\"error\":{\"type\":\"usage_limit_reached\",\"message\":\"usage limit\",\"resets_at\":1790300000000}}"
    ])).toMatchObject({ code: "rate_limited", resetAtEpochMillis: 1_790_300_000_000 })
    const before = Date.now()
    const relative = replayDataError([
      "{\"type\":\"error\",\"error\":{\"type\":\"usage_limit_reached\",\"message\":\"usage limit\",\"resets_in_seconds\":12}}"
    ])
    expect(relative.resetAtEpochMillis).toBeGreaterThanOrEqual(before + 12_000)
    expect(relative.resetAtEpochMillis).toBeLessThanOrEqual(Date.now() + 12_000)
    expect(relative).toMatchObject({ resetSource: "stream.error.resets_in_seconds", retryAfterMillis: 12_000 })
    expect(
      replayDataError([
        "{\"type\":\"error\",\"error\":{\"type\":\"usage_limit_reached\",\"message\":\"usage limit\",\"resets_in_seconds\":-1}}"
      ]).resetAtEpochMillis
    ).toBeUndefined()
  })
  it("sends a request's cache key as prompt_cache_key and omits the field without one", () => {
    const keyed = Request.ModelRequest.make({ ...request(), cacheKey: "run-7" })
    expect(body(keyed)).toMatchObject({ prompt_cache_key: "run-7" })
    expect(body(request())).not.toHaveProperty("prompt_cache_key")
  })

  it("replays text and settles exactly once", () => {
    expect(replay("text.sse")).toEqual([
      { type: "text-start", id: "msg_1" },
      { type: "text-delta", id: "msg_1", text: "Hello" },
      { type: "text-delta", id: "msg_1", text: " world" },
      { type: "text-end", id: "msg_1" },
      { type: "settle", stopReason: "stop", responseId: "resp_text" }
    ])
  })

  it("replays fragmented function arguments", () => {
    expect(replay("tool-call.sse")).toEqual([
      { type: "tool-call-start", id: "call_lookup", name: "lookup" },
      { type: "tool-call-delta", id: "call_lookup", arguments: "{\"query\":" },
      { type: "tool-call-delta", id: "call_lookup", arguments: "\"flows\"}" },
      { type: "tool-call-end", id: "call_lookup", arguments: "{\"query\":\"flows\"}" },
      { type: "settle", stopReason: "tool-calls", responseId: "resp_tools" }
    ])
  })

  it("maps reasoning and completed usage", () => {
    expect(replay("usage.sse")).toEqual([
      { type: "thinking-start", id: "rs_1", signature: "rs_1" },
      { type: "thinking-delta", id: "rs_1", text: "I should count." },
      { type: "thinking-end", id: "rs_1" },
      { type: "usage", inputTokens: 12, outputTokens: 8, cachedInputTokens: 4, reasoningTokens: 3, totalTokens: 20 },
      { type: "settle", stopReason: "stop", responseId: "resp_usage", itemIds: ["rs_1"] }
    ])
  })

  it("replays a reasoning item reference before a combined function-call continuation", () => {
    const events = replay("reasoning-tool-call.sse")
    expect(events).toEqual([
      { type: "tool-call-start", id: "call_combined", name: "read_file" },
      { type: "tool-call-delta", id: "call_combined", arguments: "{\"path\":\"README.md\"}" },
      { type: "tool-call-end", id: "call_combined", arguments: "{\"path\":\"README.md\"}" },
      {
        type: "settle",
        stopReason: "tool-calls",
        responseId: "resp_combined",
        itemIds: ["rs_combined"]
      }
    ])

    const settled = Events.ModelEvent.settledMessage(events).message
    const continuation = Request.ModelRequest.make({
      ...request(),
      messages: [
        settled,
        Request.Message.tool(
          Request.ToolResultPart.make({
            toolCallId: "call_combined",
            content: "contents"
          })
        )
      ]
    })

    expect(body(continuation).input).toEqual([
      { type: "item_reference", id: "rs_combined" },
      {
        type: "function_call",
        call_id: "call_combined",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}"
      },
      {
        type: "function_call_output",
        call_id: "call_combined",
        output: "contents"
      }
    ])
  })

  it("flushes an interrupted tool call without a settle", () => {
    const events = replay("abort-mid-stream.sse")
    expect(events).toEqual([
      { type: "tool-call-start", id: "call_abort", name: "write" },
      { type: "tool-call-delta", id: "call_abort", arguments: "{\"path\":" },
      { type: "tool-call-end", id: "call_abort", arguments: "{\"path\":" }
    ])
    expect(Events.ModelEvent.settledMessage(events).message).toMatchObject({
      stopReason: "aborted",
      content: [{ type: "tool-call", id: "call_abort", name: "write", arguments: "{\"path\":" }]
    })

    const followUp = Request.ModelRequest.make({
      ...request(),
      messages: [Events.ModelEvent.settledMessage(events).message, Request.Message.user("continue")]
    })
    const requestBody = body(followUp)
    expect(CanonicalJson.stringify(requestBody)).not.toContain("call_abort")
    expect(CanonicalJson.stringify(requestBody)).not.toContain("{\\\"path\\\":")
  })

  it("ends a function call once when Responses emits both done events", () => {
    const data = [
      {
        event: "response.output_item.added",
        data:
          "{\"type\":\"response.output_item.added\",\"item_id\":\"fc\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call\",\"name\":\"read\",\"arguments\":\"\"}}"
      },
      {
        event: "response.function_call_arguments.delta",
        data: "{\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc\",\"delta\":\"{}\"}"
      },
      {
        event: "response.function_call_arguments.done",
        data: "{\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc\",\"arguments\":\"{}\"}"
      },
      {
        event: "response.output_item.done",
        data:
          "{\"type\":\"response.output_item.done\",\"item_id\":\"fc\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call\",\"name\":\"read\",\"arguments\":\"{}\"}}"
      }
    ]
    let state = OpenAIResponses.protocol.stream.initial(streamRequest)
    const events: Array<Events.ModelEvent> = []
    for (const frame of data) {
      const [next, emitted] = step(state, frame.data)
      state = next
      events.push(...emitted)
    }
    expect(events.filter((event) => event.type === "tool-call-end")).toEqual([
      { type: "tool-call-end", id: "call", arguments: "{}" }
    ])
  })

  it("ignores frames that address nothing it has opened", () => {
    expect(replayData([
      "{\"type\":\"response.created\",\"response\":{}}",
      "{\"type\":\"response.output_text.done\",\"item_id\":\"never\"}",
      "{\"type\":\"response.reasoning_text.done\",\"item_id\":\"never\"}",
      "{\"type\":\"response.output_item.added\",\"item_id\":\"m\",\"item\":{\"type\":\"message\",\"id\":\"m\"}}",
      "{\"type\":\"response.output_item.done\",\"item_id\":\"m\",\"item\":{\"type\":\"message\",\"id\":\"m\"}}",
      "{\"type\":\"response.output_item.done\",\"item_id\":\"orphan\",\"item\":{\"type\":\"function_call\"}}",
      "{\"type\":\"response.output_item.done\",\"item_id\":\"ghost\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_ghost\",\"name\":\"read\",\"arguments\":\"{}\"}}",
      "{\"type\":\"response.in_progress\"}"
    ])).toEqual([])
  })

  it("completes a call named only by its item id and one whose arguments arrive whole", () => {
    expect(replayData([
      "{\"type\":\"response.output_item.added\",\"item_id\":\"fc\",\"item\":{\"type\":\"function_call\",\"id\":\"call_by_item\",\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\\\"a\\\"}\"}}",
      "{\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc\",\"arguments\":\"{\\\"path\\\":\\\"a\\\"}\"}"
    ])).toEqual([
      { type: "tool-call-start", id: "call_by_item", name: "read" },
      { type: "tool-call-delta", id: "call_by_item", arguments: "{\"path\":\"a\"}" },
      { type: "tool-call-end", id: "call_by_item", arguments: "{\"path\":\"a\"}" }
    ])

    // No deltas at all: the terminal `arguments` field is the whole payload.
    expect(replayData([
      "{\"type\":\"response.output_item.added\",\"item_id\":\"fc\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_whole\",\"name\":\"read\"}}",
      "{\"type\":\"response.output_item.done\",\"item_id\":\"fc\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_whole\",\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\\\"b\\\"}\"}}"
    ])).toEqual([
      { type: "tool-call-start", id: "call_whole", name: "read" },
      { type: "tool-call-end", id: "call_whole", arguments: "{\"path\":\"b\"}" }
    ])
  })

  it("rejects a function call with no identity, orphan arguments, and unparseable arguments", () => {
    expect(
      replayDataError([
        "{\"type\":\"response.output_item.added\",\"item_id\":\"fc\",\"item\":{\"type\":\"function_call\",\"name\":\"read\"}}"
      ])
    ).toMatchObject({
      code: "invalid_provider_output",
      message: "OpenAI Responses emitted a function call without an id or name"
    })

    expect(
      replayDataError([
        "{\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"ghost\",\"delta\":\"{}\"}"
      ])
    ).toMatchObject({
      code: "invalid_provider_output",
      message: "OpenAI Responses emitted arguments for an unknown function call"
    })

    expect(
      replayDataError([
        "{\"type\":\"response.output_item.added\",\"item_id\":\"fc\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_bad\",\"name\":\"read\"}}",
        "{\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc\",\"delta\":\"{oops\"}",
        "{\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc\",\"arguments\":\"{oops\"}"
      ])
    ).toMatchObject({
      code: "invalid_provider_output",
      message: "Invalid JSON input for streamed tool call read"
    })
  })

  it("opens one reasoning part per id no matter how many deltas arrive", () => {
    expect(replayData([
      "{\"type\":\"response.reasoning_summary.delta\",\"item_id\":\"rs_1\",\"delta\":\"one\"}",
      "{\"type\":\"response.reasoning_summary_text.delta\",\"item_id\":\"rs_1\",\"delta\":\" two\"}",
      "{\"type\":\"response.reasoning_summary_text.done\",\"item_id\":\"rs_1\"}",
      "{\"type\":\"response.reasoning_summary.done\",\"item_id\":\"rs_1\"}"
    ])).toEqual([
      { type: "thinking-start", id: "rs_1", signature: "rs_1" },
      { type: "thinking-delta", id: "rs_1", text: "one" },
      { type: "thinking-delta", id: "rs_1", text: " two" },
      { type: "thinking-end", id: "rs_1" },
      { type: "thinking-end", id: "rs_1" }
    ])
  })

  it("settles an incomplete response as a length stop and ignores everything after it", () => {
    expect(replayData([
      "{\"type\":\"response.output_text.delta\",\"item_id\":\"msg\",\"delta\":\"trunc\"}",
      "{\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_cut\"}}",
      "{\"type\":\"response.output_text.delta\",\"item_id\":\"msg\",\"delta\":\"after\"}",
      "{\"type\":\"response.completed\",\"response\":{\"id\":\"resp_cut\"}}"
    ])).toEqual([
      { type: "text-start", id: "msg" },
      { type: "text-delta", id: "msg", text: "trunc" },
      { type: "settle", stopReason: "length", responseId: "resp_cut" }
    ])
  })

  it("short-circuits settlement when the state becomes settled during a step", () => {
    let reads = 0
    const state = Object.defineProperty(
      { ...OpenAIResponses.protocol.stream.initial(streamRequest) },
      "settled",
      { get: () => reads++ > 0 }
    )

    const [settled, events] = step(state, "{\"type\":\"response.incomplete\",\"response\":{}}")
    expect(settled.settled).toBe(true)
    expect(events).toEqual([])
  })

  it("reads incomplete_details.reason instead of always reporting a token limit", () => {
    // `response.incomplete` carries WHY. A safety refusal is not a token budget,
    // and `StopReason` already distinguishes the two.
    const stopReasonFor = (response: string): string | undefined => {
      const events = replayData([`{"type":"response.incomplete","response":${response}}`])
      const settle = events.find((event): event is Events.Settle => event.type === "settle")
      return settle?.stopReason
    }

    expect(stopReasonFor("{\"id\":\"r\",\"incomplete_details\":{\"reason\":\"content_filter\"}}")).toBe(
      "content-filter"
    )
    expect(stopReasonFor("{\"id\":\"r\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}")).toBe("length")
    expect(stopReasonFor("{\"id\":\"r\"}")).toBe("length")
  })

  it("carries usage and the response id on response.incomplete exactly like response.completed", () => {
    // A max_output_tokens or content_filter stop still bills every token, and
    // the terminal event is the only place a stream may name them.
    expect(replayData([
      "{\"type\":\"response.output_text.delta\",\"item_id\":\"msg\",\"delta\":\"trunc\"}",
      "{\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_cut\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":100,\"output_tokens\":25,\"total_tokens\":125,\"input_tokens_details\":{\"cached_tokens\":40},\"output_tokens_details\":{\"reasoning_tokens\":5}}}}"
    ])).toEqual([
      { type: "text-start", id: "msg" },
      { type: "text-delta", id: "msg", text: "trunc" },
      {
        type: "usage",
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 40,
        reasoningTokens: 5,
        totalTokens: 125
      },
      { type: "settle", stopReason: "length", responseId: "resp_cut" }
    ])
    expect(
      Events.ModelEvent.settledMessage(replayData([
        "{\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_cut\",\"incomplete_details\":{\"reason\":\"content_filter\"},\"usage\":{\"input_tokens\":100,\"output_tokens\":25,\"total_tokens\":125}}}"
      ])).usage
    ).toEqual({ inputTokens: 100, outputTokens: 25, totalTokens: 125 })
  })

  it("closes a function call left open at response.completed from the fragments it already validated", () => {
    // A stream that omits both `function_call_arguments.done` and
    // `output_item.done` must not settle a successful tool turn on faith: the
    // call closes through the same strict validator as a done event.
    expect(replayData([
      "{\"type\":\"response.output_item.added\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"write\"}}",
      "{\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"path\\\":\\\"a\\\"}\"}",
      "{\"type\":\"response.completed\",\"response\":{\"id\":\"r\"}}"
    ], true)).toEqual([
      { type: "tool-call-start", id: "call_1", name: "write" },
      { type: "tool-call-delta", id: "call_1", arguments: "{\"path\":\"a\"}" },
      { type: "tool-call-end", id: "call_1", arguments: "{\"path\":\"a\"}" },
      { type: "settle", stopReason: "tool-calls", responseId: "r" }
    ])
  })

  it("closes a function call left open at response.completed from the final response output", () => {
    expect(replayData([
      "{\"type\":\"response.output_item.added\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"write\"}}",
      "{\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"output\":[{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"write\",\"arguments\":\"{\\\"path\\\":\\\"b\\\"}\"}]}}"
    ], true)).toEqual([
      { type: "tool-call-start", id: "call_1", name: "write" },
      { type: "tool-call-end", id: "call_1", arguments: "{\"path\":\"b\"}" },
      { type: "settle", stopReason: "tool-calls", responseId: "r" }
    ])
  })

  it("matches final tool output by item id and skips unrelated output entries", () => {
    const events = replayData([
      JSON.stringify({
        type: "response.output_item.added",
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "write" }
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "r",
          output: [
            null,
            { type: "message" },
            { type: "function_call", arguments: "{}" },
            { type: "function_call", id: "fc_1", arguments: "{}" }
          ]
        }
      })
    ], true)
    expect(events).toContainEqual({ type: "tool-call-end", id: "call_1", arguments: "{}" })
    expect(events.at(-1)).toMatchObject({ type: "settle", stopReason: "tool-calls" })
  })

  it("refuses a completed response that leaves multiple function calls unfinished", () => {
    const opened = [1, 2].map((id) =>
      JSON.stringify({
        type: "response.output_item.added",
        item: { id: `fc_${id}`, type: "function_call", call_id: `call_${id}`, name: "write" }
      })
    )
    expect(replayDataError([...opened, JSON.stringify({ type: "response.completed" })])).toMatchObject({
      code: "invalid_provider_output",
      message: "OpenAI Responses completed with 2 unfinished function calls"
    })
  })

  it("fails response.completed while a function call's arguments are still partial", () => {
    // Before this check the route settled `tool-calls` and the halt hook then
    // emitted `{"path":` verbatim into a message that was never aborted.
    const partial = [
      "{\"type\":\"response.output_item.added\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"write\"}}",
      "{\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"path\\\":\"}"
    ]
    expect(replayDataError([...partial, "{\"type\":\"response.completed\",\"response\":{\"id\":\"r\"}}"]))
      .toMatchObject({
        code: "invalid_provider_output"
      })
    expect(replayDataError([
      "{\"type\":\"response.output_item.added\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"write\"}}",
      "{\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"output\":[]}}"
    ])).toMatchObject({
      code: "invalid_provider_output",
      message: "OpenAI Responses completed with 1 unfinished function call"
    })
  })

  it("declares response.completed and response.incomplete as the terminal events", () => {
    const decode = Schema.decodeUnknownSync(OpenAIResponses.protocol.stream.event)
    for (const protocol of [OpenAIResponses.protocol, OpenAIResponses.chatgptProtocol]) {
      const terminal = protocol.stream.terminal
      expect(terminal).toBeDefined()
      expect(terminal?.(decode("{\"type\":\"response.completed\",\"response\":{}}"))).toBe(true)
      expect(terminal?.(decode("{\"type\":\"response.incomplete\",\"response\":{}}"))).toBe(true)
      expect(terminal?.(decode("{\"type\":\"response.output_text.delta\",\"delta\":\"x\"}"))).toBe(false)
      expect(terminal?.(decode("{\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}"))).toBe(false)
    }
  })

  it("omits declared tools when the request forbids tool use", () => {
    const withTools = (toolChoice?: "none"): Request.ModelRequest =>
      Request.ModelRequest.make({
        modelId: "gpt-5.4",
        system: [],
        messages: [Request.Message.user("hi")],
        tools: [Request.ToolDefinition.make({ name: "search", description: "web search", parameters: {} })],
        params: Request.GenerationParams.make(),
        ...(toolChoice === undefined ? {} : { toolChoice })
      })

    expect(body(withTools("none")).tools).toBeUndefined()
    expect(body(withTools()).tools).toHaveLength(1)
  })

  it("declares provider-run web search even when the request forbids tool use", () => {
    const searching = (toolChoice?: "none"): Request.ModelRequest =>
      Request.ModelRequest.make({
        modelId: "gpt-6-luna",
        system: [],
        messages: [Request.Message.user("hi")],
        tools: [Request.ToolDefinition.make({ name: "search", description: "local", parameters: {} })],
        params: Request.GenerationParams.make(),
        ...(toolChoice === undefined ? {} : { toolChoice }),
        serverTools: [{ type: "web_search" }, { type: "web_search" }]
      })

    expect(body(searching("none")).tools).toEqual([{ type: "web_search" }])
    const filtered = Request.ModelRequest.make({
      ...searching("none"),
      serverTools: [{ type: "web_search", allowedDomains: ["nodejs.org"] }]
    })
    expect(body(filtered).tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["nodejs.org"] } }])
    expect(body(searching()).tools?.map((tool) => tool.type)).toEqual(["function", "web_search"])
    const chatgpt = Effect.runSync(OpenAIResponses.chatgptProtocol.body.from(searching("none"), { native: true }))
    expect(chatgpt.tools).toEqual([{ type: "web_search" }])
    expect(Schema.decodeUnknownSync(OpenAIResponses.ChatGPTBody)(chatgpt).tools).toEqual([{ type: "web_search" }])
    const { serverTools: _serverTools, ...rest } = searching("none")
    const plain = Request.ModelRequest.make(rest)
    expect(body(plain).tools).toBeUndefined()
    // Absent, the field changes nothing a sealed step key hashes.
    expect(Object.keys(Schema.encodeSync(Request.ModelRequest)(plain))).not.toContain("serverTools")
  })

  it("settles a searched answer as a stop with its cited text", () => {
    // The event shapes the ChatGPT backend streamed for gpt-6-luna on 2026-09-25.
    const events = replayData([
      "{\"type\":\"response.output_item.added\",\"item\":{\"id\":\"ws_1\",\"type\":\"web_search_call\",\"status\":\"in_progress\"}}",
      "{\"type\":\"response.web_search_call.searching\",\"item_id\":\"ws_1\"}",
      "{\"type\":\"response.output_item.done\",\"item\":{\"id\":\"ws_1\",\"type\":\"web_search_call\",\"status\":\"completed\",\"action\":{\"type\":\"search\",\"query\":\"node lts\"}}}",
      "{\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"v24 (https://nodejs.org/en/download)\"}",
      "{\"type\":\"response.output_text.annotation.added\",\"item_id\":\"msg_1\",\"annotation\":{\"type\":\"url_citation\",\"url\":\"https://nodejs.org/en/download\"}}",
      "{\"type\":\"response.output_text.done\",\"item_id\":\"msg_1\"}",
      "{\"type\":\"response.completed\",\"response\":{\"id\":\"r\"}}"
    ])
    expect(events).toEqual([
      { type: "text-start", id: "msg_1" },
      { type: "text-delta", id: "msg_1", text: "v24 (https://nodejs.org/en/download)" },
      { type: "text-end", id: "msg_1" },
      { type: "settle", stopReason: "stop", responseId: "r" }
    ])
  })

  it("settles a completed response with neither an id nor usage", () => {
    expect(replayData(["{\"type\":\"response.completed\",\"response\":{}}"])).toEqual([
      { type: "settle", stopReason: "stop", responseId: undefined }
    ])

    expect(replayData(["{\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"usage\":{}}}"])).toEqual([
      { type: "usage" },
      { type: "settle", stopReason: "stop", responseId: "r" }
    ])
  })

  it("falls back to a synthetic id when the provider names no item", () => {
    expect(replayData([
      "{\"type\":\"response.output_text.delta\",\"delta\":\"anonymous\"}",
      "{\"type\":\"response.output_text.done\"}"
    ])).toEqual([
      { type: "text-start", id: "output-0" },
      { type: "text-delta", id: "output-0", text: "anonymous" },
      { type: "text-end", id: "output-0" }
    ])
  })

  it("rejects malformed stream frames as typed provider output errors", () => {
    expect(() => Schema.decodeUnknownSync(OpenAIResponses.protocol.stream.event)("not-json"))
      .toThrow()
  })

  it("classifies top-level streamed quota and authentication errors", () => {
    for (
      const [data, expected] of [
        [
          "{\"type\":\"error\",\"code\":\"insufficient_quota\",\"message\":\"credits exhausted\"}",
          { code: "quota_exceeded", providerCode: "insufficient_quota" }
        ],
        [
          "{\"type\":\"error\",\"code\":\"invalid_api_key\",\"message\":\"Incorrect API key\"}",
          { code: "authentication", providerCode: "invalid_api_key" }
        ]
      ] as const
    ) {
      const event = Schema.decodeUnknownSync(OpenAIResponses.protocol.stream.event)(data)
      const error = Effect.runSync(
        OpenAIResponses.protocol.stream.step(OpenAIResponses.protocol.stream.initial(streamRequest), event).pipe(
          Effect.flip
        )
      )
      expect(error).toMatchObject(expected)
    }
  })

  it("classifies streamed failures from the event, the response, or neither", () => {
    expect(
      replayDataError(["{\"type\":\"error\",\"error\":{\"code\":\"rate_limit_exceeded\",\"message\":\"slow down\"}}"])
    )
      .toMatchObject({ code: "rate_limited", providerCode: "rate_limit_exceeded", message: "slow down" })

    expect(replayDataError(["{\"type\":\"error\",\"error\":{\"type\":\"server_error\"}}"])).toMatchObject({
      code: "provider_internal",
      providerCode: "server_error",
      message: "OpenAI Responses stream failed"
    })

    expect(
      replayDataError([
        "{\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"c\",\"message\":\"failed\"}}}"
      ])
    ).toMatchObject({ code: "unknown", providerCode: "c", message: "failed" })

    expect(replayDataError(["{\"type\":\"error\"}"])).toMatchObject({
      code: "unknown",
      message: "OpenAI Responses stream failed",
      providerCode: undefined
    })
  })

  it("classifies every HTTP failure shape, including bodies it cannot parse", () => {
    const classify = OpenAIResponses.protocol.classifyError

    expect(classify(402, "{\"error\":{\"code\":\"insufficient_quota\"}}")).toMatchObject({ code: "quota_exceeded" })
    expect(classify(400, "{\"error\":{\"message\":\"Your credit balance is too low\"}}")).toMatchObject({
      code: "quota_exceeded"
    })
    expect(classify(403, "{\"error\":{\"code\":\"permission_denied\"}}")).toMatchObject({ code: "authentication" })
    expect(classify(429, "{\"error\":{\"code\":\"rate_limit_exceeded\",\"message\":\"slow\"}}")).toMatchObject({
      code: "rate_limited",
      providerCode: "rate_limit_exceeded",
      httpStatus: 429
    })
    expect(classify(400, "{\"error\":{\"message\":\"content_policy violation\"}}")).toMatchObject({
      code: "content_policy"
    })
    expect(classify(400, "{\"error\":{\"code\":\"context_length_exceeded\",\"message\":\"maximum context length\"}}"))
      .toMatchObject({ code: "context_overflow" })
    for (const status of [404, 409, 413, 422]) {
      expect(classify(status, "{}")).toMatchObject({
        code: "invalid_request",
        message: `OpenAI Responses request failed with HTTP ${status}`
      })
    }
    expect(classify(418, "{\"error\":{\"type\":\"invalid_request_error\"}}")).toMatchObject({ code: "invalid_request" })
    expect(classify(500, "{}")).toMatchObject({ code: "provider_internal" })
    expect(classify(503, "<html>gateway</html>")).toMatchObject({
      code: "provider_internal",
      message: "OpenAI Responses request failed with HTTP 503"
    })
    expect(classify(418, "{\"code\":\"server_error\",\"message\":\"boom\"}")).toMatchObject({
      code: "provider_internal",
      providerCode: "server_error",
      message: "boom"
    })
    expect(classify(418, "{}")).toMatchObject({
      code: "unknown",
      providerCode: undefined,
      message: "OpenAI Responses request failed with HTTP 418"
    })
  })

  it("replays reasoning signatures as stored items and opaque ones as references", () => {
    const withId = JSON.stringify({ type: "reasoning", id: "rs_keep", encrypted_content: "cipher" })
    const withoutId = JSON.stringify({ type: "reasoning", summary: [] })
    const opaque = "sig_opaque"
    const assistant = Request.Message.assistant([
      Request.TextPart.make({ text: "part one" }),
      Request.TextPart.make({ text: " part two" }),
      Request.ThinkingPart.make({ text: "a", signature: withId }),
      Request.ThinkingPart.make({ text: "b", signature: withoutId }),
      Request.ThinkingPart.make({ text: "c", signature: opaque }),
      Request.ThinkingPart.make({ text: "d", signature: opaque }),
      Request.ThinkingPart.make({ text: "e" }),
      Request.ToolCallPart.make({ id: "call_1", name: "read", arguments: "{}" })
    ], { stopReason: "tool-calls", itemIds: ["rs_keep", "item_a", "item_a", "item_b"] })

    const input = body(
      Request.ModelRequest.make({
        modelId: "gpt-5.4",
        system: [],
        messages: [assistant],
        tools: [],
        params: Request.GenerationParams.make()
      })
    ).input

    expect(input).toEqual([
      // `rs_keep` is already replayed as a stored reasoning item, so it is not
      // also referenced, and a repeated id is referenced once.
      { type: "item_reference", id: "item_a" },
      { type: "item_reference", id: "item_b" },
      { role: "assistant", content: [{ type: "output_text", text: "part one part two" }] },
      { type: "reasoning", id: "rs_keep", encrypted_content: "cipher" },
      { type: "reasoning", summary: [] },
      { type: "item_reference", id: "sig_opaque" },
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" }
    ])
  })

  it("lowers a deterministic native deferred tool-search load point", () => {
    const first = body(request())
    const reordered = request()
    expect(CanonicalJson.stringify(first)).toBe(
      CanonicalJson.stringify(body(reordered))
    )
    const wireBody = first as { readonly input: ReadonlyArray<unknown>; readonly tools: ReadonlyArray<unknown> }
    expect(first.stream).toBe(true)
    expect(wireBody.tools).toEqual([{ type: "function", name: "search", description: "search tools", parameters: {} }])
    expect(wireBody.input.slice(-3)).toEqual([
      { type: "function_call_output", call_id: "call_loader", output: "loaded" },
      {
        type: "tool_search_call",
        call_id: "pi_tool_load_dm2dwtfpjn6h",
        execution: "client",
        status: "completed",
        arguments: { query: "read_file", limit: 1 }
      },
      {
        type: "tool_search_output",
        call_id: "pi_tool_load_dm2dwtfpjn6h",
        execution: "client",
        status: "completed",
        tools: [{
          type: "function",
          name: "read_file",
          description: "read a file",
          parameters: {},
          defer_loading: true
        }]
      }
    ])
  })

  it("keeps an unactivated declared tool out of the initial native request", () => {
    const initial = Request.ModelRequest.make({
      ...request(),
      messages: [Request.Message.user("Find it")]
    })
    const wireBody = body(initial) as {
      readonly input: ReadonlyArray<unknown>
      readonly tools: ReadonlyArray<unknown>
    }

    expect(wireBody.tools).toEqual([
      { type: "function", name: "search", description: "search tools", parameters: {} }
    ])
    expect(CanonicalJson.stringify(wireBody.input)).not.toContain("read_file")
  })

  it("emits one tool-search pair for repeated activation markers", () => {
    const modelRequest = request()
    const repeated = Request.ModelRequest.make({
      ...modelRequest,
      messages: [
        ...modelRequest.messages,
        Request.Message.tool(Request.ToolResultPart.make({
          toolCallId: "call_loader_again",
          content: "already loaded",
          addedToolNames: ["READ_FILE", "read_file"]
        }))
      ]
    })
    const input = body(repeated).input as ReadonlyArray<{ readonly type?: string }>
    expect(input.filter((item) => item.type === "tool_search_call")).toHaveLength(1)
    expect(input.filter((item) => item.type === "tool_search_output")).toHaveLength(1)
  })

  it("uses the Responses reasoning-effort wire enum and always requests streaming", () => {
    const requestBody = body(
      Request.ModelRequest.make({
        ...request(),
        params: Request.GenerationParams.make({
          thinkingBudget: 1_024,
          reasoningEffort: "high"
        })
      })
    )
    expect(requestBody).toMatchObject({ reasoning: { effort: "high" }, stream: true })
    expect(CanonicalJson.stringify(requestBody)).not.toContain("1024")
  })

  it("falls back to the complete active list and omits incomplete history", () => {
    const legacy = body(request("gpt-4o")) as {
      readonly tools: ReadonlyArray<unknown>
      readonly input: ReadonlyArray<unknown>
    }
    expect(legacy.tools).toHaveLength(2)
    expect(legacy.input.some((item) => (item as { readonly type?: string }).type === "tool_search_call")).toBe(false)
    const aborted = Request.ModelRequest.make({
      ...request(),
      messages: [Request.Message.assistant("partial", { stopReason: "aborted" }), Request.Message.user("continue")]
    })
    expect(CanonicalJson.stringify(body(aborted, false))).not.toContain(
      "partial"
    )
  })

  it("keeps inactive lazy tools out of an unsupported model's initial active list", () => {
    const initial = Request.ModelRequest.make({
      ...request("gpt-4o"),
      messages: [Request.Message.user("Find it")]
    })
    const legacy = body(initial) as { readonly tools: ReadonlyArray<{ readonly name: string }> }

    expect(legacy.tools.map((entry) => entry.name)).toEqual(["search"])
    expect(CanonicalJson.stringify(legacy)).not.toContain("defer_loading")
  })
})
