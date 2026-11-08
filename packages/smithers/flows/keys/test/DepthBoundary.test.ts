import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import * as Keys from "../src/index.ts"

const nested = (depth: number, kind: "array" | "object" | "mixed") => {
  let value: unknown = "leaf-雪"
  let document = "\"leaf-雪\""
  for (let index = 0; index < depth; index++) {
    if (kind === "array" || (kind === "mixed" && index % 2 === 0)) {
      value = [value]
      document = `[${document}]`
    } else {
      value = { a: value }
      document = `{"a":${document}}`
    }
  }
  return { value, document }
}

describe("complete maximum-depth key derivation", () => {
  for (const kind of ["array", "object", "mixed"] as const) {
    for (const depth of [9_999, 10_000]) {
      it(`hashes the complete ${kind} document at depth ${depth} through both public paths`, () => {
        const { value, document } = nested(depth, kind)
        const expected = `key1_${createHash("sha256").update(document, "utf8").digest("hex")}`
        const direct = Effect.runSync(Keys.deriveKey(value).pipe(Effect.provide(NodeCrypto.layer)))
        const schema = Effect.runSync(
          Schema.decodeUnknownEffect(Keys.DerivedKey)(value).pipe(Effect.provide(NodeCrypto.layer))
        )
        expect(direct).toBe(expected)
        expect(schema).toBe(expected)
        expect(Schema.decodeUnknownSync(Keys.StoredKey)(schema)).toBe(expected)
      })
    }

    it(`rejects the ${kind} document one level past the maximum with typed failures`, () => {
      const { value } = nested(10_001, kind)
      const direct = Effect.runSync(
        Effect.flip(Keys.deriveKey(value)).pipe(Effect.provide(NodeCrypto.layer))
      )
      const schema = Effect.runSync(
        Effect.flip(Schema.decodeUnknownEffect(Keys.DerivedKey)(value)).pipe(Effect.provide(NodeCrypto.layer))
      )
      expect(direct.code).toBe("canonicalization_failed")
      expect(schema._tag).toBe("SchemaError")
      expect(schema.message).toContain("canonicalization_failed")
    })
  }
})
