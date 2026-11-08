import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Events from "../src/ModelEvent.ts"

describe("ModelEvent", () => {
  it("round-trips every event", () => {
    const events: ReadonlyArray<Events.ModelEvent> = [
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", text: "hello" },
      { type: "text-end", id: "text" },
      { type: "thinking-start", id: "thinking", signature: "sig" },
      { type: "thinking-delta", id: "thinking", text: "consider" },
      { type: "thinking-end", id: "thinking" },
      { type: "tool-call-start", id: "call", name: "read" },
      { type: "tool-call-delta", id: "call", arguments: "{\"path\":" },
      { type: "tool-call-end", id: "call" },
      { type: "tool-result", id: "call", output: "file contents", isError: false },
      {
        type: "usage",
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 3,
        cachedInputTokens: 4,
        cacheWriteTokens: 5,
        totalTokens: 6
      },
      { type: "retry", attempt: 1, code: "transport", delayMillis: 1_137 },
      { type: "settle", stopReason: "stop" }
    ]
    for (const event of events) {
      expect(Schema.decodeUnknownSync(Events.ModelEvent)(Schema.encodeSync(Events.ModelEvent)(event))).toEqual(event)
    }
  })

  it("states the retry delay, and reads a record written before the field as an unmeasured zero", () => {
    // Every retry of one sealed step is journaled together when that step
    // settles, so the event timestamps are identical whether the backoff waited
    // half a minute or nothing at all. The delay has to be carried by the event
    // itself for a wave report to see the schedule.
    const scheduled = Schema.decodeUnknownSync(Events.ModelEvent)({
      type: "retry",
      attempt: 3,
      code: "transport",
      delayMillis: 4_311
    })
    expect(scheduled).toEqual({ type: "retry", attempt: 3, code: "transport", delayMillis: 4_311 })

    // A run parked before the field existed replays against this schema.
    expect(Schema.decodeUnknownSync(Events.ModelEvent)({ type: "retry", attempt: 1, code: "transport" })).toEqual({
      type: "retry",
      attempt: 1,
      code: "transport",
      delayMillis: 0
    })
    expect(Events.ModelEvent.Retry({ type: "retry", attempt: 1, code: "transport" }).delayMillis).toBe(0)
  })

  it("carries a call's wire timing and served tier on the settle event", () => {
    const timing = {
      startedAt: 1_760_000_000_000,
      attempts: 2,
      requestBytes: 48_211,
      preparedMs: 4,
      signedMs: 9,
      sentMs: 1_310,
      headersMs: 2_190,
      firstEventMs: 2_204,
      firstThinkingMs: 2_950,
      firstOutputMs: 7_480,
      lastOutputMs: 9_020,
      completedMs: 9_066,
      closedMs: 9_067,
      failedTries: [{ sentMs: 10, failedMs: 760, code: "provider_internal", httpStatus: 503 }]
    }
    const settle = { type: "settle", stopReason: "stop", responseId: "resp_1", servedTier: "priority", timing }
    expect(Schema.decodeUnknownSync(Events.ModelEvent)(Schema.encodeSync(Events.ModelEvent)(settle as Events.Settle)))
      .toEqual(settle)
    expect(Schema.decodeUnknownSync(Events.Timing)(timing)).toEqual(timing)
    // A stage the protocol could not know is absent, never a zero.
    expect(Schema.decodeUnknownSync(Events.Timing)({ attempts: 1, headersMs: 12 })).toEqual({
      attempts: 1,
      headersMs: 12
    })
    expect(Schema.decodeUnknownSync(Events.FailedTry)({ failedMs: 3, code: "transport" })).toEqual({
      failedMs: 3,
      code: "transport"
    })
  })

  it("reads a settle and a retry written before the timing fields existed", () => {
    // A journal sealed before this change replays against this schema.
    const old = { type: "settle", stopReason: "tool-calls", responseId: "resp_0", itemIds: ["rs_1"] }
    const decoded = Schema.decodeUnknownSync(Events.ModelEvent)(old)
    expect(decoded).toEqual(old)
    expect(decoded).not.toHaveProperty("timing")
    expect(decoded).not.toHaveProperty("servedTier")
    expect(Events.settledMessage([decoded]).message).toMatchObject({ stopReason: "tool-calls", responseId: "resp_0" })

    const retry = Schema.decodeUnknownSync(Events.ModelEvent)({
      type: "retry",
      attempt: 1,
      code: "transport",
      delayMillis: 500
    })
    expect(retry).toEqual({ type: "retry", attempt: 1, code: "transport", delayMillis: 500 })
  })

  it("states how long a retried attempt ran and the status that failed it", () => {
    const retry = {
      type: "retry",
      attempt: 2,
      code: "rate_limited",
      delayMillis: 2_000,
      elapsedMs: 412,
      httpStatus: 429
    }
    expect(Schema.decodeUnknownSync(Events.ModelEvent)(Schema.encodeSync(Events.ModelEvent)(retry as Events.Retry)))
      .toEqual(retry)
  })

  it("folds accumulated stream content on settlement", () => {
    const settled = Events.settledMessage([
      { type: "retry", attempt: 1, code: "provider_internal", delayMillis: 2_000 },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", text: "hello" },
      { type: "thinking-start", id: "thinking", signature: "sig" },
      { type: "thinking-delta", id: "thinking", text: "think" },
      { type: "tool-call-start", id: "call", name: "read" },
      { type: "tool-call-delta", id: "call", arguments: "{\"path\":\"a\"}" },
      { type: "usage", totalTokens: 9 },
      { type: "settle", stopReason: "tool-calls" }
    ])
    expect(settled.message).toMatchObject({
      role: "assistant",
      stopReason: "tool-calls",
      content: [
        { type: "text", text: "hello" },
        { type: "thinking", text: "think", signature: "sig" },
        { type: "tool-call", id: "call", name: "read", arguments: "{\"path\":\"a\"}" }
      ]
    })
    expect(settled.usage).toEqual({ totalTokens: 9 })
  })

  it("discards a failed attempt's partial text when the stream retries", () => {
    const settled = Events.settledMessage([
      { type: "text-delta", id: "first", text: "partial" },
      { type: "retry", attempt: 1, code: "transport", delayMillis: 0 },
      { type: "text-delta", id: "second", text: "complete" },
      { type: "settle", stopReason: "stop" }
    ])
    expect(settled.message.content).toEqual([{ type: "text", text: "complete" }])
  })

  it("settles usage from the successful attempt after a retry", () => {
    const settled = Events.settledMessage([
      { type: "usage", inputTokens: 100, outputTokens: 20, reasoningTokens: 10, totalTokens: 120 },
      { type: "retry", attempt: 1, code: "transport", delayMillis: 0 },
      { type: "usage", inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      { type: "settle", stopReason: "stop" }
    ])
    expect(settled.usage).toEqual({ inputTokens: 8, outputTokens: 4, totalTokens: 12 })
  })

  it("keeps two concurrently open text blocks separate and in order", () => {
    const settled = Events.settledMessage([
      { type: "text-start", id: "first" },
      { type: "text-delta", id: "first", text: "opening " },
      { type: "text-start", id: "second" },
      { type: "text-delta", id: "second", text: "aside " },
      { type: "text-delta", id: "first", text: "line" },
      { type: "text-delta", id: "second", text: "block" },
      { type: "text-end", id: "first" },
      { type: "text-end", id: "second" },
      { type: "settle", stopReason: "stop" }
    ])

    // Each id keeps its own part, ordered by the block that opened first, so an
    // interleaved stream never merges two blocks into one.
    expect(settled.message.content).toEqual([
      { type: "text", text: "opening line" },
      { type: "text", text: "aside block" }
    ])
  })

  it("encodes a missing settle as aborted", () => {
    expect(Events.settledMessage([{ type: "text-delta", id: "text", text: "partial" }]).message).toMatchObject({
      stopReason: "aborted",
      content: [{ type: "text", text: "partial" }]
    })
  })

  it("folds an empty stream into an aborted, empty message", () => {
    const settled = Events.settledMessage([])

    expect(settled.message).toMatchObject({ role: "assistant", stopReason: "aborted", content: [] })
    expect(settled.message.responseId).toBeUndefined()
    expect(settled.message.itemIds).toBeUndefined()
    expect(settled.usage).toEqual({})
  })

  it("constructs usage and every event through the attached constructors", () => {
    expect(Events.Usage.make({ inputTokens: 1 })).toEqual({ inputTokens: 1 })
    expect(Events.ModelEvent.Usage({ inputTokens: 1, totalTokens: 2 })).toEqual({
      type: "usage",
      inputTokens: 1,
      totalTokens: 2
    })
    expect(Events.ModelEvent.TextStart({ type: "text-start", id: "a" })).toEqual({ type: "text-start", id: "a" })
    expect(Events.ModelEvent.Retry({ type: "retry", attempt: 2, code: "transport", delayMillis: 2_400 })).toEqual({
      type: "retry",
      attempt: 2,
      code: "transport",
      delayMillis: 2_400
    })
    expect(Events.ModelEvent.ToolResult({ type: "tool-result", id: "a", output: "out" })).toMatchObject({
      type: "tool-result",
      output: "out"
    })
    expect(Events.ModelEvent.settledMessage([]).message.stopReason).toBe("aborted")
  })

  it("keeps the first settle and ignores a duplicate one", () => {
    const settled = Events.settledMessage([
      { type: "settle", stopReason: "stop", responseId: "first", itemIds: ["one"] },
      { type: "settle", stopReason: "length", responseId: "second", itemIds: ["two"] }
    ])

    expect(settled.message).toMatchObject({ stopReason: "stop", responseId: "first", itemIds: ["one"] })
  })

  it("keeps a later usage report's fields without erasing earlier ones", () => {
    const settled = Events.settledMessage([
      { type: "usage", inputTokens: 5, cacheWriteTokens: 1 },
      { type: "usage", inputTokens: 7, outputTokens: 2 },
      { type: "settle", stopReason: "stop" }
    ])

    expect(settled.usage).toEqual({ inputTokens: 7, outputTokens: 2, cacheWriteTokens: 1 })
  })

  it("ignores deltas addressed to a part of a different kind", () => {
    const settled = Events.settledMessage([
      { type: "tool-call-start", id: "shared", name: "read" },
      { type: "text-delta", id: "shared", text: "not text" },
      { type: "thinking-delta", id: "shared", text: "not thinking" },
      { type: "text-start", id: "text" },
      { type: "tool-call-delta", id: "text", arguments: "{}" },
      { type: "settle", stopReason: "stop" }
    ])

    expect(settled.message.content).toEqual([
      { type: "tool-call", id: "shared", name: "read", arguments: "" },
      { type: "text", text: "" }
    ])
  })

  it("ignores a tool-call-end for an unknown or mistyped part", () => {
    const settled = Events.settledMessage([
      { type: "text-start", id: "text" },
      { type: "tool-call-end", id: "text", arguments: "{\"a\":1}" },
      { type: "tool-call-end", id: "never-opened", arguments: "{\"a\":1}" },
      { type: "settle", stopReason: "stop" }
    ])

    expect(settled.message.content).toEqual([{ type: "text", text: "" }])
  })

  // The projection preserves what an interrupted provider sent, while
  // `ToolStream.end` refuses the same malformed text on a live completion.
  it("preserves unparseable end arguments and keeps accumulated ones when none are repeated", () => {
    const partial = Events.settledMessage([
      { type: "tool-call-start", id: "call", name: "write" },
      { type: "tool-call-delta", id: "call", arguments: "{\"path\":\"a\"}" },
      { type: "tool-call-end", id: "call", arguments: "{\"path\":" },
      { type: "settle", stopReason: "tool-calls" }
    ])
    expect(partial.message.content).toEqual([
      { type: "tool-call", id: "call", name: "write", arguments: "{\"path\":" }
    ])

    const accumulated = Events.settledMessage([
      { type: "tool-call-start", id: "call", name: "write" },
      { type: "tool-call-delta", id: "call", arguments: "{\"path\":\"a\"}" },
      { type: "tool-call-end", id: "call" },
      { type: "settle", stopReason: "tool-calls" }
    ])
    expect(accumulated.message.content).toEqual([
      { type: "tool-call", id: "call", name: "write", arguments: "{\"path\":\"a\"}" }
    ])
  })

  it("opens a part from a delta whose start never arrived", () => {
    const settled = Events.settledMessage([
      { type: "thinking-delta", id: "thinking", text: "unopened" },
      { type: "tool-call-delta", id: "call", arguments: "{}" },
      { type: "tool-result", id: "call", output: "ignored by the assistant message" },
      { type: "settle", stopReason: "stop" }
    ])

    expect(settled.message.content).toEqual([
      { type: "thinking", text: "unopened" },
      { type: "tool-call", id: "call", name: "unknown", arguments: "{}" }
    ])
  })

  it("repairs interrupted tool JSON and preserves settlement metadata", () => {
    const settled = Events.settledMessage([
      { type: "tool-call-start", id: "call", name: "write" },
      { type: "tool-call-delta", id: "call", arguments: "{\"path\":" },
      { type: "tool-call-end", id: "call", arguments: "{}" },
      { type: "usage", inputTokens: 2 },
      { type: "usage", outputTokens: 3, totalTokens: 5 },
      {
        type: "settle",
        stopReason: "tool-calls",
        responseId: "response",
        itemIds: ["item"]
      }
    ])

    expect(settled.message).toMatchObject({
      stopReason: "tool-calls",
      responseId: "response",
      itemIds: ["item"],
      content: [{ type: "tool-call", id: "call", name: "write", arguments: "{}" }]
    })
    expect(settled.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 })
  })
})
