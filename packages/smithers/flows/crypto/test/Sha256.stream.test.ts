import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { digestStream, Sha256Error } from "../src/Sha256.ts"

const expected = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

describe("digestStream", () => {
  it("equals SHA-256 of the concatenated chunks across every block boundary", () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, index) => (index * 31) & 0xff)
    for (let length = 0; length <= bytes.length; length += 7) {
      const input = bytes.subarray(0, length)
      for (const size of [1, 13, 64, 65, 300]) {
        const chunks: Array<Uint8Array> = []
        for (let offset = 0; offset < input.length; offset += size) chunks.push(input.slice(offset, offset + size))
        expect(Effect.runSync(digestStream(Stream.fromIterable(chunks)))).toBe(expected(input))
      }
    }
  })

  it("restarts from an empty state each time the Effect runs", () => {
    const hash = digestStream(Stream.make(new Uint8Array([1, 2, 3])))
    expect(Effect.runSync(hash)).toBe(Effect.runSync(hash))
  })

  it("passes stream failures through unchanged", () => {
    const failure = Effect.runSync(Effect.flip(digestStream(Stream.fail("unreadable" as const))))
    expect(failure).toBe("unreadable")
  })

  it("refuses a chunk that is not a Uint8Array as invalid_input", () => {
    const chunks = Stream.make("text" as unknown as Uint8Array)
    const failure = Effect.runSync(Effect.flip(digestStream(chunks)))
    expect(failure).toBeInstanceOf(Sha256Error)
    expect(failure).toMatchObject({ code: "invalid_input" })
  })
})
