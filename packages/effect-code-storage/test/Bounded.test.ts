import { Effect, Exit, Stream } from "effect"
import { expect, test } from "vitest"
import { readAtMost, readPackets } from "../src/internal/bounded.vibe"

test.each([NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "invalid cap %s never pulls either reader",
  async (cap) => {
    let pulls = 0
    const stream = Stream.fromEffect(Effect.sync(() => {
      pulls++
      return new Uint8Array([0])
    }))
    for (const read of [Effect.asVoid(readAtMost(stream, cap)), Effect.asVoid(readPackets(stream, cap, () => true))]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(read))).toBe(true)
    }
    expect(pulls).toBe(0)
  }
)

test("zero and exact caps preserve bounded bytes", async () => {
  expect(await Effect.runPromise(readAtMost(Stream.make(new Uint8Array([1])), 0))).toEqual({
    bytes: new Uint8Array(),
    truncated: true
  })
  expect(await Effect.runPromise(readAtMost(Stream.make(new Uint8Array([1])), 1))).toEqual({
    bytes: new Uint8Array([1]),
    truncated: false
  })
})
