/**
 * The byte path three providers put every file transfer through.
 *
 * `KubernetesSandbox`, `CloudflareSandbox`, and `AwsSandbox` all carry file
 * contents across a text-only transport as base64, so "the session promises
 * bytes" is true only as far as this pair is. It is judged against
 * `effect/encoding/Base64`, the implementation the rest of the workspace uses for the
 * same job, rather than against a transcript of itself.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { Base64 } from "effect/encoding"
import { decodeBase64, decodeBase64Bytes, encodeBase64, encodeBase64Bytes } from "../src/internal/base64.vibe"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.vibe"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** A deterministic generator, so a failure is reproducible from its seed. */
const bytesOf = (seed: number, length: number): Uint8Array => {
  const out = new Uint8Array(length)
  let state = seed >>> 0
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    out[index] = state >>> 24
  }
  return out
}

describe("internal base64", () => {
  it("agrees with effect/encoding/Base64 on every generated payload", () => {
    const payloads: Array<Uint8Array> = [
      new Uint8Array(0),
      // Every byte value, so a signed-vs-unsigned slip cannot hide.
      Uint8Array.from({ length: 256 }, (_, index) => index)
    ]
    // Lengths 0 through 32 cover all three padding classes several times over.
    for (let length = 0; length <= 32; length++) payloads.push(bytesOf(0x5eed + length, length))
    for (const length of [1023, 1024, 1025, 65_536]) payloads.push(bytesOf(length, length))

    for (const payload of payloads) {
      const encoded = encodeBase64(payload)
      expect(encoded).toBe(Base64.encode(payload))
      const decoded = Base64.decode(encoded)
      expect(Result.isSuccess(decoded)).toBe(true)
      expect(Array.from(Result.getOrThrow(decoded))).toEqual(Array.from(payload))
      expect(decoder.decode(encodeBase64Bytes(payload))).toBe(encoded)
    }
  })

  it.effect("round-trips through the decoder, wrapped the way a guest wraps it", () =>
    Effect.gen(function*() {
      for (const seed of [1, 2, 3, 97]) {
        const payload = bytesOf(seed, 700)
        const encoded = encodeBase64(payload)
        // `base64` on a guest line-wraps at a width nobody agrees on, and a
        // decoder refuses a wrapped payload, which is why the strip exists.
        for (const width of [4, 60, 76]) {
          const wrapped = encoded.replaceAll(new RegExp(`(.{${width}})`, "g"), "$1\n")
          expect(Array.from(yield* decodeBase64(wrapped, "a file"))).toEqual(Array.from(payload))
          expect(Array.from(yield* decodeBase64Bytes(encoder.encode(wrapped), "a file"))).toEqual(
            Array.from(payload)
          )
        }
        // Carriage returns from a pseudo-terminal are whitespace too.
        expect(Array.from(yield* decodeBase64(`${encoded.slice(0, 8)}\r\n${encoded.slice(8)}`, "a file")))
          .toEqual(Array.from(payload))
      }
    }))

  it.effect("reports a payload the oracle refuses in the provider vocabulary", () =>
    Effect.gen(function*() {
      for (const garbage of ["!!!!", "AAAA=AAA", "A"]) {
        // Whatever `effect/encoding/Base64` refuses, this refuses, and it refuses it
        // as a `ProviderError` rather than by throwing whatever the decoder
        // threw.
        expect(Result.isFailure(Base64.decode(garbage))).toBe(true)
        const error = yield* Effect.flip(decodeBase64(garbage, "the file /tmp/x"))
        expect(error).toBeInstanceOf(ProviderError)
        expect(error.code).toBe("unknown")
        expect(error.message).toBe("the sandbox returned invalid base64 the file /tmp/x")
        // The oracle's own typed failure is preserved as the cause rather than
        // stringified away.
        expect(error.cause).toBeDefined()
      }
    }))

  it("neither retains nor mutates the caller's buffer", () => {
    const payload = bytesOf(11, 48)
    const original = Array.from(payload)
    const encoded = encodeBase64(payload)
    const bytes = encodeBase64Bytes(payload)
    expect(Array.from(payload)).toEqual(original)
    // A caller that reuses its buffer afterwards cannot change what was
    // already encoded.
    payload.fill(0)
    expect(encodeBase64(bytesOf(11, 48))).toBe(encoded)
    expect(decoder.decode(bytes)).toBe(encoded)
  })
})
