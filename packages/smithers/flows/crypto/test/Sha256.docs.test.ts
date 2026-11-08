import { Schema } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Digest, digest, digestSync, Sha256 } from "../src/index.ts"

// The signatures docs/api.md publishes for the two schemas, annotated onto the
// real exports. Typechecking the test suite therefore rejects a documented type
// that no longer describes the source, which is how the reference kept the
// obsolete two-argument `Schema.Schema` form after Effect split `Schema` from
// `Codec`.
const documentedDigest: Schema.Codec<Digest, string> = Digest

const documentedSha256: Schema.Codec<Digest, string | Uint8Array, EffectDigest.Digest> & {
  readonly Digest: typeof Digest
  readonly digest: typeof digest
  readonly digestSync: typeof digestSync
} = Sha256

const api = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8")

/** The first TypeScript fence under a `###` heading of the API reference. */
const signature = (heading: string): string => {
  const [, section] = api.split(`\n### ${heading}\n`)
  const fence = section?.split("```ts\n")[1]?.split("```")[0]
  if (fence === undefined) throw new Error(`docs/api.md has no ts fence under "### ${heading}"`)
  return fence
}

describe("docs/api.md schema signatures", () => {
  it("declares Digest as the codec the source exports", () => {
    expect(signature("Digest")).toContain("const Digest: Schema.Codec<Digest, string>\n")
    expect(documentedDigest).toBe(Digest)
  })

  it("declares Sha256 with its Crypto decoding requirement", () => {
    expect(signature("Sha256")).toContain(
      "const Sha256: Schema.Codec<Digest, string | Uint8Array, EffectDigest.Digest> & {\n"
    )
    expect(documentedSha256).toBe(Sha256)
  })

  it("publishes no two-argument Schema.Schema type", () => {
    expect(api).not.toContain("Schema.Schema<")
  })
})
