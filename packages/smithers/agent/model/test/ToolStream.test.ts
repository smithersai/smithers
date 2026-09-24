import { Chunk } from "effect"
import { describe, expect, it } from "vitest"
import { ModelError } from "../src/ModelError.ts"
import * as ToolStream from "../src/ToolStream.ts"

describe("ToolStream", () => {
  // A quadratic accumulator (copying every fragment on each delta) takes
  // minutes on 200,000 fragments; a linear one takes milliseconds. The bound
  // sits orders of magnitude from both, so load cannot flip it, unlike a
  // wall-clock ratio between two sizes.
  it("accumulates 200,000 fragments without quadratic copying", () => {
    const count = 200_000
    let state = ToolStream.start(ToolStream.initial(), { callId: "call", name: "write" })
    state = ToolStream.delta(state, "call", "{\"text\":\"")
    const started = performance.now()
    for (let index = 0; index < count; index++) {
      state = ToolStream.delta(state, "call", index % 2 === 0 ? "a" : "b")
    }
    const elapsed = performance.now() - started
    state = ToolStream.delta(state, "call", "\"}")
    const result = ToolStream.end(state, "call")
    if (result instanceof ModelError) throw result
    expect(result.completed.arguments).toBe("{\"text\":\"" + "ab".repeat(count / 2) + "\"}")
    expect(elapsed).toBeLessThan(10_000)
  })

  it("preserves earlier states when tool arguments branch", () => {
    const opened = ToolStream.start(ToolStream.initial(), { callId: "call", name: "write" })
    const prefix = ToolStream.delta(opened, "call", "{\"value\":")
    const left = ToolStream.delta(prefix, "call", "1}")
    const right = ToolStream.delta(prefix, "call", "2}")

    expect(ToolStream.flushAborted(opened).completed[0]?.arguments).toBe("")
    expect(ToolStream.flushAborted(prefix).completed[0]?.arguments).toBe("{\"value\":")
    expect(ToolStream.end(left, "call")).toMatchObject({ completed: { arguments: "{\"value\":1}" } })
    expect(ToolStream.end(right, "call")).toMatchObject({ completed: { arguments: "{\"value\":2}" } })
  })

  it("reassembles JSON fragments", () => {
    let state = ToolStream.initial()
    state = ToolStream.start(state, { callId: "call_1", name: "lookup" })
    state = ToolStream.delta(state, "call_1", "{\"query\":")
    state = ToolStream.delta(state, "call_1", "\"flows\"")
    state = ToolStream.delta(state, "call_1", "}")

    const result = ToolStream.end(state, "call_1")
    if (result instanceof Error) throw result
    expect(result.completed).toEqual({ callId: "call_1", name: "lookup", arguments: "{\"query\":\"flows\"}" })
    expect(result.state).toEqual({ open: [] })
  })

  it("rejects malformed provider argument JSON", () => {
    let state = ToolStream.start(ToolStream.initial(), { callId: "call_1", name: "lookup" })
    state = ToolStream.delta(state, "call_1", "{")

    const result = ToolStream.end(state, "call_1")
    expect(result).toMatchObject({ code: "invalid_provider_output" })
  })

  it("appends a fragment only to the addressed call", () => {
    let state = ToolStream.start(ToolStream.initial(), { callId: "first", name: "one" })
    state = ToolStream.start(state, { callId: "second", name: "two" })
    state = ToolStream.delta(state, "second", "{\"b\":2}")
    state = ToolStream.delta(state, "missing", "ignored")

    expect(state.open).toEqual([
      { callId: "first", name: "one", fragments: Chunk.empty() },
      { callId: "second", name: "two", fragments: Chunk.of("{\"b\":2}") }
    ])
  })

  it("reports a completion for a call it never opened", () => {
    const result = ToolStream.end(ToolStream.initial(), "call_unknown")

    expect(result).toBeInstanceOf(ModelError)
    expect(result).toMatchObject({
      code: "invalid_provider_output",
      message: "Received completion for unknown tool call call_unknown"
    })
  })

  it("completes a call with no fragments as an empty object", () => {
    const state = ToolStream.start(ToolStream.initial(), { callId: "call_1", name: "lookup" })

    const result = ToolStream.end(state, "call_1")
    if (result instanceof ModelError) throw result
    expect(result.completed).toEqual({ callId: "call_1", name: "lookup", arguments: "{}" })
    expect(result.state.open).toEqual([])
  })

  it("replaces a duplicate call id rather than accumulating two entries", () => {
    let state = ToolStream.start(ToolStream.initial(), { callId: "call_1", name: "first" })
    state = ToolStream.delta(state, "call_1", "{\"stale\":true}")
    state = ToolStream.start(state, { callId: "call_1", name: "second" })

    expect(state.open).toEqual([{ callId: "call_1", name: "second", fragments: Chunk.empty() }])
    const result = ToolStream.end(state, "call_1")
    if (result instanceof ModelError) throw result
    expect(result.completed).toEqual({ callId: "call_1", name: "second", arguments: "{}" })
  })

  it("refuses malformed live arguments and preserves aborted history verbatim", () => {
    // The same partial argument text: `end` refuses it because a live stream
    // must not hand a guess to a tool, while `flushAborted` records what the
    // provider actually sent. The aborted turn is never lowered back onto the
    // wire by a built-in protocol.
    let state = ToolStream.start(ToolStream.initial(), { callId: "call_1", name: "write" })
    state = ToolStream.delta(state, "call_1", "{\"path\":")

    expect(ToolStream.end(state, "call_1")).toMatchObject({ code: "invalid_provider_output" })
    expect(ToolStream.flushAborted(state).completed).toEqual([
      { callId: "call_1", name: "write", arguments: "{\"path\":" }
    ])
  })

  it("flushes an accumulator that never opened a call", () => {
    expect(ToolStream.flushAborted(ToolStream.initial())).toEqual({ state: { open: [] }, completed: [] })
  })

  it("settles open calls with their exact partial and empty arguments after an abort", () => {
    let state = ToolStream.start(ToolStream.initial(), { callId: "partial", name: "one" })
    state = ToolStream.delta(state, "partial", "{\"not\":\"complete\"")
    state = ToolStream.start(state, { callId: "empty", name: "two" })

    expect(ToolStream.flushAborted(state)).toEqual({
      state: { open: [] },
      completed: [
        { callId: "partial", name: "one", arguments: "{\"not\":\"complete\"" },
        { callId: "empty", name: "two", arguments: "" }
      ]
    })
  })
})
