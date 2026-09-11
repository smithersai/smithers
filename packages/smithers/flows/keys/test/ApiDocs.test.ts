import type * as Crypto from "effect/Crypto"
import type * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { expect, expectTypeOf, it } from "vitest"
import { DerivedKey, type KeyV1 } from "../src/index.ts"

const api = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8")

it("documents the DerivedKey codec with its Crypto decoding service", () => {
  expectTypeOf(DerivedKey).toExtend<Schema.Codec<KeyV1, unknown, Crypto.Crypto, never>>()
  expectTypeOf<typeof DerivedKey["DecodingServices"]>().toEqualTypeOf<Crypto.Crypto>()
  expectTypeOf<typeof DerivedKey["EncodingServices"]>().toEqualTypeOf<never>()

  expect(api).toContain("const DerivedKey: Schema.Codec<KeyV1, unknown, Crypto.Crypto, never>")
})
