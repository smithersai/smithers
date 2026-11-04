import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Effect, PlatformError, Schema, SchemaIssue } from "effect"
import { inspect } from "node:util"
import { describe, expect, it } from "vitest"
import * as Crypto from "../src/Crypto.ts"
import { Digest, digest, digestSync, Sha256, Sha256Error, syncCrypto } from "../src/index.ts"
import { millionA, vectors } from "./fixtures.ts"

const runDigest = (input: string | Uint8Array): Digest =>
  Effect.runSync(digest(input).pipe(Effect.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest))))

const decode = (input: string | Uint8Array): Digest =>
  Effect.runSync(
    Schema.decodeUnknownEffect(Sha256)(input).pipe(Effect.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest)))
  )

const digestFailure = (input: string | Uint8Array) =>
  Effect.runSync(Effect.flip(Effect.provideService(digest(input), Crypto.Crypto, syncCrypto)))

const expectRedacted = (error: Schema.SchemaError, secret: string): void => {
  const visit = (issue: SchemaIssue.Issue): void => {
    expect(issue).not.toHaveProperty("input")
    expect(issue).not.toHaveProperty("actual")
    if ("issue" in issue) visit(issue.issue)
    if ("issues" in issue) issue.issues.forEach(visit)
  }
  visit(error.issue)
  const bytes = new TextEncoder().encode(secret)
  for (
    const serialized of [
      error.message,
      JSON.stringify(error),
      JSON.stringify(error.issue),
      inspect(error, { depth: null, breakLength: Infinity, compact: true }),
      inspect(error, { depth: null, breakLength: Infinity, compact: true, customInspect: false })
    ]
  ) {
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(JSON.stringify(bytes))
    expect(serialized).not.toContain(inspect(bytes, { breakLength: Infinity, compact: true }))
  }
}

describe("SHA-256 entry points", () => {
  it.each(vectors)("matches the published vector for %j", (input, expected) => {
    const bytes = new TextEncoder().encode(input)
    expect(digestSync(input)).toBe(expected)
    expect(digestSync(bytes)).toBe(expected)
    expect(runDigest(input)).toBe(expected)
    expect(runDigest(bytes)).toBe(expected)
    expect(decode(input)).toBe(expected)
  })

  it("hashes only a Uint8Array view and snapshots it", () => {
    const backing = new Uint8Array([0xff, 0xff, 0x61, 0x62, 0x63, 0xff])
    const view = backing.subarray(2, 5)
    const effect = digest(view)
    backing.fill(0)

    // Snapshot semantics begin when the Effect executes, so this sees the
    // deliberate pre-execution mutation.
    expect(Effect.runSync(effect.pipe(Effect.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest))))).toBe(
      digestSync(new Uint8Array(3))
    )

    backing.set([0x61, 0x62, 0x63], 2)
    expect(digestSync(view)).toBe(vectors[1][1])
  })

  it("accepts Node and Bun Buffer as a Uint8Array subclass", () => {
    expect(digestSync(Buffer.from("abc"))).toBe(vectors[1][1])
    expect(runDigest(Buffer.from("abc"))).toBe(vectors[1][1])
    expect(decode(Buffer.from("abc"))).toBe(vectors[1][1])
  })

  it("rejects unpaired surrogates without normalizing valid text", () => {
    for (const input of ["\ud800", "\udfff", `x\ud800y`, `x\udc00y`]) {
      expect(() => digestSync(input)).toThrow(expect.objectContaining({
        _tag: "@smthrs/crypto/Sha256Error",
        code: "invalid_text"
      }))
      expect(digestFailure(input)).toMatchObject({ code: "invalid_text" })
    }

    expect(digestSync("é")).not.toBe(digestSync("e\u0301"))
  })

  it("hashes the million-'a' FIPS vector with the whole-buffer API", () => {
    const input = "a".repeat(1_000_000)
    expect(digestSync(input)).toBe(millionA)
    expect(runDigest(input)).toBe(millionA)
  })

  it("exports Digest directly and through the compatibility namespace", () => {
    const value = vectors[0][1]
    expect(Schema.decodeUnknownSync(Digest)(value)).toBe(value)
    expect(Schema.decodeUnknownSync(Sha256.Digest)(value)).toBe(value)
    expect(Sha256.digestSync("abc")).toBe(vectors[1][1])
    expect(Sha256.digest).toBe(digest)
  })
})

describe("Digest validation and one-way schema behavior", () => {
  it.each([
    vectors[0][1].toUpperCase(),
    "0".repeat(63),
    "0".repeat(65),
    "g".repeat(64),
    ` ${"0".repeat(64)}`,
    `${"0".repeat(64)} `,
    42,
    null
  ])("rejects invalid digest %j", (value) => {
    expect(() => Schema.decodeUnknownSync(Digest)(value)).toThrow()
  })

  it.each([
    new ArrayBuffer(3),
    new DataView(new ArrayBuffer(3)),
    new Uint16Array(3),
    [1, 2, 3],
    { bytes: [1, 2, 3] }
  ])(
    "rejects unsupported hash input %j",
    (value) => {
      expect(Effect.runSync(Effect.flip(
        Schema.decodeUnknownEffect(Sha256)(value).pipe(Effect.provideService(Crypto.Crypto, syncCrypto))
      ))).toMatchObject({ _tag: "SchemaError" })
      expect(() => digestSync(value as never)).toThrow(expect.objectContaining({ code: "invalid_input" }))
    }
  )

  it("redacts values rejected by the input schema", () => {
    const secret = "unsupported-input-secret"
    const error = Effect.runSync(Effect.flip(
      Schema.decodeUnknownEffect(Sha256)({ secret }, { reportInput: true }).pipe(
        Effect.provideService(Crypto.Crypto, syncCrypto)
      )
    ))
    expect(error.message).not.toContain(secret)
    expect(error.issue).not.toHaveProperty("actual")
    expectRedacted(error, secret)
  })

  it("uses the exact forbidden-encode message", () => {
    const error = Effect.runSync(Effect.flip(Schema.encodeEffect(Sha256)(vectors[0][1] as Digest)))
    const message = "A digest cannot be converted back into its source bytes"
    expect(error.message).toContain(message)
    expect(error.issue).toMatchObject({ issue: { annotations: { message } } })
  })

  it("preserves text-encoding failures without retaining the input", () => {
    const cause = new Error("encoder unavailable")
    const original = TextEncoder.prototype.encode
    TextEncoder.prototype.encode = () => {
      throw cause
    }
    try {
      expect(() => digestSync("secret-text")).toThrow(expect.objectContaining({
        code: "text_encoding_failed",
        cause
      }))
      const error = digestFailure("secret-text")
      expect(error).toBeInstanceOf(Sha256Error)
      expect(error).toMatchObject({ code: "text_encoding_failed", cause })
      expect(error.message).not.toContain("secret-text")
    } finally {
      TextEncoder.prototype.encode = original
    }
  })

  it("turns a detached byte view into a cause-preserving invalid-input error", () => {
    const bytes = new Uint8Array([1, 2, 3])
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] })
    expect(() => digestSync(bytes)).toThrow(expect.objectContaining({
      code: "invalid_input",
      message: "SHA-256 byte input could not be copied",
      cause: expect.any(TypeError)
    }))
    expect(digestFailure(bytes)).toMatchObject({
      code: "invalid_input",
      cause: expect.any(TypeError)
    })
  })
})

// Child parse options cannot change an enclosing issue's input reporting.
// These controls pin that limitation alongside the documented decode boundary.
describe("composed schema input reporting", () => {
  const secret = "hash-input-secret"
  const bytes = new TextEncoder().encode(secret)
  const failedHost = Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: () =>
      Effect.fail(PlatformError.badArgument({
        module: "test-host",
        method: "digest",
        description: "host unavailable"
      }))
  })
  const defectiveHost = Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: () => Effect.die(new Error("host unavailable"))
  })
  const failures = [
    { label: "host failure, text", contents: secret, crypto: failedHost },
    { label: "host failure, bytes", contents: bytes, crypto: failedHost },
    { label: "host defect, text", contents: secret, crypto: defectiveHost },
    { label: "host defect, bytes", contents: bytes, crypto: defectiveHost },
    { label: "invalid UTF-16", contents: `${secret}\ud800`, crypto: syncCrypto }
  ]

  it.each(failures)("redacts standalone issues with reportInput:true ($label)", ({ contents, crypto }) => {
    const error = Effect.runSync(Effect.flip(
      Schema.decodeUnknownEffect(Sha256)(contents, { reportInput: true }).pipe(
        Effect.provideService(Crypto.Crypto, crypto)
      )
    ))
    expectRedacted(error, secret)
  })

  describe.each([
    {
      label: "Struct",
      schema: Schema.Struct({ contents: Sha256 }),
      wrap: (contents: string | Uint8Array) => ({ contents })
    },
    {
      label: "Array",
      schema: Schema.Array(Sha256),
      wrap: (contents: string | Uint8Array) => [contents]
    },
    {
      label: "Union",
      schema: Schema.Union([Schema.Struct({ contents: Sha256 }), Schema.Number]),
      wrap: (contents: string | Uint8Array) => ({ contents })
    }
  ])("$label", ({ schema, wrap }) => {
    it.each(failures)("requires outer reportInput:false ($label)", ({ contents, crypto }) => {
      const input = wrap(contents)
      const decodeFailure = (reportInput: boolean) =>
        Effect.runSync(Effect.flip(
          Schema.decodeUnknownEffect(schema)(input, { reportInput }).pipe(
            Effect.provideService(Crypto.Crypto, crypto)
          )
        ))

      const unsafe = decodeFailure(true)
      expect(unsafe.issue.input).toBe(input)
      expect(JSON.stringify(unsafe.issue)).toContain(JSON.stringify(contents))
      expect(inspect(unsafe, { depth: null, breakLength: Infinity, compact: true, customInspect: false })).toContain(
        inspect(contents, { breakLength: Infinity, compact: true })
      )

      expectRedacted(decodeFailure(false), secret)
    })
  })

  const Manifest = Schema.Struct({ contents: Sha256, name: Schema.String })
  describe.each([
    { label: "Struct", schema: Manifest, wrap: (contents: string | Uint8Array) => ({ contents, name: 42 }) },
    {
      label: "Array",
      schema: Schema.Array(Manifest),
      wrap: (contents: string | Uint8Array) => [{ contents, name: 42 }]
    },
    {
      label: "Union",
      schema: Schema.Union([Manifest, Schema.Number]),
      wrap: (contents: string | Uint8Array) => ({ contents, name: 42 })
    }
  ])("$label with a sibling validation failure", ({ schema, wrap }) => {
    it.each([secret, bytes])("requires outer reportInput:false for %j", (contents) => {
      const input = wrap(contents)
      const decodeFailure = (reportInput: boolean) =>
        Effect.runSync(Effect.flip(
          Schema.decodeUnknownEffect(schema)(input, { reportInput, errors: "all" }).pipe(
            Effect.provideService(Crypto.Crypto, syncCrypto)
          )
        ))

      const unsafe = decodeFailure(true)
      expect(unsafe.issue.input).toBe(input)
      expect(JSON.stringify(unsafe.issue)).toContain(JSON.stringify(contents))
      expect(inspect(unsafe, { depth: null, breakLength: Infinity, compact: true, customInspect: false })).toContain(
        inspect(contents, { breakLength: Infinity, compact: true })
      )

      const safe = decodeFailure(false)
      expect(safe.message).toContain("Expected string")
      expect(safe.message).not.toContain("[digest_failed]")
      expectRedacted(safe, secret)
    })
  })
})
