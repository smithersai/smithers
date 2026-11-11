import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { digest } from "../src/internal/JournalDigest.ts"

describe("journal fingerprint digest", () => {
  it.effect("hashes content with real SHA-256", () =>
    Effect.gen(function*() {
      const result = yield* digest(new TextEncoder().encode("abc"))
      expect(Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join(""))
        .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }))

  it.effect("preserves the native rejection for an unsupported shared buffer", () =>
    Effect.gen(function*() {
      // Web Crypto refuses shared memory. Exercise its real failure boundary
      // with a value that deliberately violates its ArrayBuffer-only input.
      const bytes = new Uint8Array(new SharedArrayBuffer(1)) as unknown as Uint8Array<ArrayBuffer>
      const failure = yield* Effect.flip(digest(bytes))
      expect(failure).toBeInstanceOf(TypeError)
      expect((failure as Error).name).toBe("TypeError")
    }))
})
