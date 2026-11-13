import { syncCrypto } from "@smthrs/crypto"
import * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { expect, expectTypeOf, it } from "vitest"
import { DerivedKey, deriveKey, KeyDerivationError, type KeyV1 } from "../src/index.ts"

const api = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8")

it("documents the DerivedKey codec with its Digest decoding service", () => {
  expectTypeOf(DerivedKey).toExtend<Schema.Codec<KeyV1, unknown, EffectDigest.Digest, never>>()
  expectTypeOf<typeof DerivedKey["DecodingServices"]>().toEqualTypeOf<EffectDigest.Digest>()
  expectTypeOf<typeof DerivedKey["EncodingServices"]>().toEqualTypeOf<never>()

  expect(api).toContain("const DerivedKey: Schema.Codec<KeyV1, unknown, EffectDigest.Digest, never>")
})

it("documents the cause-preserving factory separately from the public-field constructor", () => {
  const signature = api.match(/constructor\(([\s\S]*?)\n  \)/)?.[1]
  expect(signature).toBeDefined()
  expect(signature).toContain("readonly code: KeyDerivationErrorCode")
  expect(signature).toContain("readonly message: string")
  expect(signature).not.toContain("cause")
  expect(api).toContain("static new(")

  const cause = new Error("digest unavailable")
  const error = KeyDerivationError.new({ code: "digest_failed", message: "Digest unavailable", cause })
  expect(error.cause).toBe(cause)
  expect(Object.keys(error)).not.toContain("cause")
})

const troubleshooting = readFileSync(new URL("../docs/troubleshooting.md", import.meta.url), "utf8")
const brokenDigest = EffectDigest.Digest.of({
  digest: () => Effect.die(PlatformError.systemError({ _tag: "Unknown", module: "test-host", method: "digest" })),
  digestHex(algorithm, data) {
    return Effect.map(this.digest(algorithm, data), Hex.encode)
  }
})

it.each([
  { code: "canonicalization_failed", material: { value: 1n }, digest: syncCrypto },
  { code: "digest_failed", material: { value: 1 }, digest: brokenDigest }
])("documents $code messages at the deriveKey and DerivedKey boundaries", ({ code, material, digest }) => {
  const layer = Layer.succeed(EffectDigest.Digest)(digest)
  const failure = Effect.runSync(deriveKey(material).pipe(Effect.flip, Effect.provide(layer)))
  expect(failure.code).toBe(code)
  const section = troubleshooting.split(`## \`${code}\``)[1]!.split("\n## ")[0]!
  const messages = [...section.matchAll(/```text\n([^\n]+)\n```/g)].map((match) => match[1])
  expect(messages).toEqual([failure.message, `[${code}] ${failure.message}`])
  const schemaFailure = Effect.runSync(
    Schema.decodeUnknownEffect(DerivedKey)(material).pipe(Effect.flip, Effect.provide(layer))
  )
  expect(schemaFailure.message).toContain(messages[1])
})
