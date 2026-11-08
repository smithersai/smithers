import { describe, it } from "../src/Vitest.ts"
import { Data, Effect, Schema } from "effect"

// A tiny container format: three magic bytes, a length byte, `length` bytes of payload, then a 16-bit checksum.
class NotAContainer extends Data.TaggedError("NotAContainer")<{ readonly index: number }> {}
class TooShort extends Data.TaggedError("TooShort")<{ readonly length: number }> {}

const expectByte = (name: string, index: number, expected: number) =>
  Effect.fn(name)(function*(bytes: ReadonlyArray<number>) {
    if (bytes[index] !== expected) return yield* new NotAContainer({ index })
  })

const magic0 = expectByte("Container.magic0", 0, 0x7f)
const magic1 = expectByte("Container.magic1", 1, 0x45)
const magic2 = expectByte("Container.magic2", 2, 0x46)

const checksum = Effect.fn("Container.checksum")(function*(bytes: ReadonlyArray<number>) {
  if (bytes.length < 4) return yield* new TooShort({ length: bytes.length })
  const view = new DataView(Uint8Array.from(bytes).buffer)
  const length = view.getUint8(3)
  // Fuzzing found that a length byte larger than the payload read past the end of the buffer. The saved failure in
  // __fuzz__ replays on every run.
  if (bytes.length < 6 + length) return yield* new TooShort({ length: bytes.length })
  return view.getUint16(4 + length)
})

const parse = Effect.fn("Container.parse")(function*(bytes: ReadonlyArray<number>) {
  yield* magic0(bytes)
  yield* magic1(bytes)
  yield* magic2(bytes)
  return yield* checksum(bytes)
})

const Byte = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))

describe("Container", () => {
  // Rejecting malformed input with a typed error is fine; dying is the bug fuzzing looks for.
  it.effect.fuzz("parse never dies", [Schema.Array(Byte)], ([bytes]) =>
    parse(bytes).pipe(
      Effect.catchTag(["NotAContainer", "TooShort"], () => Effect.succeed(0)),
      Effect.as(true)
    ))
})
