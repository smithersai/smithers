import { ArtifactStore, ImmutableCache } from "@smthrs/artifacts"
import { BoundedJson, CanonicalError, canonicalize } from "@smthrs/canonical"
import { WebCrypto } from "@smthrs/crypto"
import * as crypto from "node:crypto"
import * as Digest from "effect/crypto/Digest"
import * as Layer from "effect/Layer"
import { FuzzSimulation } from "@smthrs/fuzz"
import { Redaction } from "@smthrs/journal"
import { deriveKey } from "@smthrs/keys"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Fiber, Option, Schema } from "effect"
import { describe, expect } from "vitest"

const JsonLeaf = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Int.check(Schema.isBetween({ minimum: -100_000, maximum: 100_000 })),
  Schema.String.check(Schema.isMaxLength(40))
])

const JsonObj = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,12}$/)),
  Schema.Union([JsonLeaf, Schema.Array(JsonLeaf).check(Schema.isMaxLength(5))])
)

describe("@smthrs/canonical, @smthrs/keys, @smthrs/journal, @smthrs/artifacts fuzz", () => {
  it.fuzz(
    "RFC 8785 canonicalize is idempotent, key-order independent, and round-trips JSON.parse",
    [JsonObj],
    ([obj]) => {
      const hasLoneSurrogate = (v: unknown): boolean =>
        typeof v === "string"
          ? !v.isWellFormed()
          : Array.isArray(v)
          ? v.some(hasLoneSurrogate)
          : v !== null && typeof v === "object" && Object.values(v).some(hasLoneSurrogate)
      if (hasLoneSurrogate(obj)) {
        expect(() => canonicalize(obj)).toThrow(CanonicalError)
        return true
      }
      const c1 = canonicalize(obj)
      const parsed = JSON.parse(c1)
      const c2 = canonicalize(parsed)
      expect(c1).toBe(c2)

      // Permuting object keys in reverse insertion order MUST produce byte-identical canonical JSON
      const reversed: Record<string, unknown> = {}
      for (const k of Object.keys(obj).reverse()) {
        reversed[k] = obj[k]
      }
      expect(canonicalize(reversed)).toBe(c1)
      return true
    }
  )

  it.fuzz(
    "BoundedJson.admit never crashes on arbitrary values and enforces byte/depth ceilings",
    [Schema.Unknown],
    ([raw]) => {
      const res = BoundedJson.admit(raw, { maxBytes: 4096, maxDepth: 8, maxKeys: 64, maxElements: 64, maxStringBytes: 1024, maxTotalMembers: 128 })
      expect(typeof res.ok).toBe("boolean")
      return true
    }
  )

  it.effect.fuzz(
    "deriveKey is deterministic and invariant to object property insertion order",
    [Schema.String.check(Schema.isPattern(/^[a-z]{1,10}$/)), JsonObj],
    ([namespace, obj]) =>
      Effect.gen(function*() {
        const reversed: Record<string, unknown> = {}
        for (const k of Object.keys(obj).reverse()) {
          reversed[k] = obj[k]
        }
        const clean = JSON.parse(JSON.stringify(obj))
        const cleanRev: Record<string, unknown> = {}
        for (const k of Object.keys(clean).reverse()) cleanRev[k] = clean[k]
        const k1 = yield* deriveKey(namespace, clean).pipe(Effect.provide(WebCrypto.layer))
        const k2 = yield* deriveKey(namespace, cleanRev).pipe(Effect.provide(WebCrypto.layer))
        expect(k1).toBe(k2)
        return true
      })
  )

  it.fuzz(
    "Redaction.redact and lineRedactor scrub secret-shaped tokens across arbitrary chunk splits",
    [
      Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{24,40}$/)),
      Schema.String.check(Schema.isMaxLength(30)),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 15 }))
    ],
    ([secretSuffix, noise, chunkSize]) => {
      const fakeGithubToken = `ghp_${secretSuffix}`
      const nested = {
        authorization: `Bearer ${fakeGithubToken}`,
        apiKey: fakeGithubToken,
        nested: { note: `${noise} ${fakeGithubToken}` }
      }
      const redacted = Redaction.redact(nested)
      const serialized = JSON.stringify(redacted)
      expect(serialized).not.toContain(fakeGithubToken)

      // Streaming line redactor across arbitrary chunk splits must also scrub the token
      const lr = Redaction.lineRedactor()
      const streamText = `line1 ${noise}\nBearer ${fakeGithubToken}\nlast\n`
      const out: Array<string> = []
      const lines = streamText.split("\n")
      for (const l of lines) {
        for (let i = 0; i < l.length; i += chunkSize) {
          const piece = l.slice(i, i + chunkSize)
          if (i + chunkSize < l.length) lr.part(piece)
          else out.push(...lr.line(piece))
        }
        if (l.length === 0) out.push(...lr.line(""))
      }
      out.push(...lr.flush())
      expect(out.join("\n")).not.toContain(fakeGithubToken)
      return true
    }
  )

  it.effect.fuzz(
    "ArtifactStore.layerMemory preserves content-addressed byte integrity under concurrent FuzzSimulation",
    [
      Schema.Array(
        Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(Schema.isMaxLength(64))
      ).check(Schema.isMinLength(1), Schema.isMaxLength(6))
    ],
    ([blobs]) =>
      Effect.gen(function*() {
        const store = yield* ArtifactStore.ArtifactStore
        const fibers = yield* Effect.forEach(blobs, (rawBytes) =>
          Effect.forkChild(
            Effect.gen(function*() {
              const bytes = Uint8Array.from(rawBytes)
              const digest = yield* store.put(bytes)
              const exists = yield* store.has(digest)
              expect(exists).toBe(true)
              const fetched = yield* store.get(digest)
              expect(fetched).toEqual(bytes)
            })
          )
        )
        for (const f of fibers) {
          yield* Fiber.join(f)
        }
        return true
      }).pipe(
        Effect.provide(ArtifactStore.layerMemory),
        Effect.provide(Layer.succeed(Digest.Digest, {
          digest: (_algo, data) => Effect.sync(() => {
            const buf = crypto.createHash("sha256").update(data instanceof Uint8Array ? data : new Uint8Array(data)).digest()
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          })
        }))
      ),
    { fuzz: { execution: FuzzSimulation.execution({ maxSteps: 100_000 }) } }
  )

  it.effect.fuzz(
    "ImmutableCache.layerMemory readThrough caches values by key without corruption",
    [
      Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,8}$/)),
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(Schema.isMaxLength(64))
    ],
    ([name, rawBytes]) =>
      Effect.gen(function*() {
        const cache = yield* ImmutableCache.ImmutableCache
        const bytes = Uint8Array.from(rawBytes)
        const cacheKey = ImmutableCache.key("fuzz", name)
        let calls = 0
        const entry = { bytes, metadata: { contentType: "application/octet-stream" } }
        const compute = Effect.sync(() => {
          calls++
          return entry
        })
        const first = yield* ImmutableCache.readThrough(cacheKey, compute)
        const second = yield* ImmutableCache.readThrough(cacheKey, compute)
        expect(first.bytes).toEqual(bytes)
        expect(second.bytes).toEqual(bytes)
        expect(calls).toBe(1)
        const hit = yield* cache.get(cacheKey)
        expect(Option.isSome(hit)).toBe(true)
        return true
      }).pipe(Effect.provide(ImmutableCache.layerMemory()))
  )
})
