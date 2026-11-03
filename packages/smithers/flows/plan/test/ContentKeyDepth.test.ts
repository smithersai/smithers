import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { createHash } from "node:crypto"
import * as StepKey from "../src/StepKey.vibe"
import { withCrypto } from "./Crypto.ts"

describe("content-key depth includes its material envelope", () => {
  it.effect("hashes all accepted body bytes and refuses one extra level", () =>
    Effect.gen(function*() {
      for (const depth of [9_998, 9_999]) {
        let body: unknown = "leaf-雪"
        for (let index = 0; index < depth; index++) body = [body]
        const bodyJson = "[".repeat(depth) + "\"leaf-雪\"" + "]".repeat(depth)
        const document = `{"body":${bodyJson},"capabilities":{},"inputs":{},"kind":"content","layers":[]}`
        const expected = `key1_${createHash("sha256").update(document, "utf8").digest("hex")}`
        expect(yield* withCrypto(StepKey.content({ body, capabilities: {}, inputs: {}, layers: [] }))).toBe(expected)
      }
      let tooDeep: unknown = "leaf-雪"
      for (let index = 0; index < 10_000; index++) tooDeep = [tooDeep]
      const error = yield* withCrypto(Effect.flip(StepKey.content({
        body: tooDeep,
        capabilities: {},
        inputs: {},
        layers: []
      })))
      expect(error._tag).toBe("SchemaError")
      expect(error.message).toContain("canonicalization_failed")
    }))
})
