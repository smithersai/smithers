import { Framing, ToolStream } from "@smthrs/model"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"

const SafeText = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_ :.,\-{}[\]"]{0,32}$/))

const splitBytes = (bytes: Uint8Array, sizes: ReadonlyArray<number>): ReadonlyArray<Uint8Array> => {
  const out: Array<Uint8Array> = []
  let off = 0
  let i = 0
  while (off < bytes.length) {
    const n = sizes[i % sizes.length]!
    out.push(bytes.subarray(off, Math.min(bytes.length, off + n)))
    off += n
    i++
  }
  return out.length === 0 ? [new Uint8Array()] : out
}

describe("@smthrs/model SSE/NDJSON framing & ToolStream fuzz", () => {
  it.effect.fuzz(
    "Framing.sse emits identical frames regardless of arbitrary chunk split boundaries",
    [
      Schema.Array(SafeText).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 13 }))).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
      Schema.Literals(["\n", "\r\n"])
    ],
    ([events, chunkSizes, eol]) =>
      Effect.gen(function*() {
        const wire = events.map((ev) => `data: ${ev}${eol}${eol}`).join("")
        const bytes = new TextEncoder().encode(wire)

        const single = yield* Stream.runCollect(Framing.sse.frame(Stream.succeed(bytes)))
        const chunked = yield* Stream.runCollect(Framing.sse.frame(Stream.fromIterable(splitBytes(bytes, chunkSizes))))
        expect([...chunked]).toEqual([...single])
        return true
      })
  )

  it.effect.fuzz(
    "Framing.ndjson emits identical lines regardless of arbitrary chunk split boundaries",
    [
      Schema.Array(SafeText).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 13 }))).check(Schema.isMinLength(1), Schema.isMaxLength(16))
    ],
    ([records, chunkSizes]) =>
      Effect.gen(function*() {
        const wire = records.map((r) => JSON.stringify({ msg: r })).join("\n") + "\n"
        const bytes = new TextEncoder().encode(wire)

        const single = yield* Stream.runCollect(Framing.ndjson.frame(Stream.succeed(bytes)))
        const chunked = yield* Stream.runCollect(Framing.ndjson.frame(Stream.fromIterable(splitBytes(bytes, chunkSizes))))
        expect([...chunked]).toEqual([...single])
        return true
      })
  )

  it.fuzz(
    "ToolStream start/delta/end/flushAborted handles arbitrary interleaved tool calls without crashing",
    [
      Schema.Array(
        Schema.Struct({
          op: Schema.Literals(["start", "delta", "end"]),
          callId: Schema.Literals(["c1", "c2", "c3"]),
          fragment: Schema.Literals(["{", "\"a\":1", "}", "invalid", ""])
        })
      ).check(Schema.isMaxLength(20))
    ],
    ([ops]) => {
      let state = ToolStream.initial()
      for (const op of ops) {
        if (op.op === "start") {
          state = ToolStream.start(state, { callId: op.callId, name: "tool" })
        } else if (op.op === "delta") {
          state = ToolStream.delta(state, op.callId, op.fragment)
        } else {
          const res = ToolStream.end(state, op.callId)
          if ("state" in res) state = res.state
        }
      }
      const flushed = ToolStream.flushAborted(state)
      expect(flushed.state.open.length).toBe(0)
      return true
    }
  )
})
