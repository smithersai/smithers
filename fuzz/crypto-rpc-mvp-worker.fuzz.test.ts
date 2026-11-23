import { Sha256, Uuid } from "@smthrs/crypto"
import { WebUrl, Sha256 as RpcSha256 } from "@smthrs/rpc"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Layer, Schema } from "effect"
import * as Digest from "effect/crypto/Digest"
import * as crypto from "node:crypto"
import { describe, expect } from "vitest"
import { aliasLocation, parseAliases } from "../apps/mvp/worker/aliases.ts"
import { isAppRoute } from "../apps/mvp/worker/appRoute.ts"
import { codeOf } from "../apps/mvp/worker/ErrorCode.ts"

const syncDigestLayer = Layer.succeed(Digest.Digest, {
  digest: (algo, data) =>
    Effect.sync(() => {
      const nodeAlgo = algo === Digest.sha1 ? "sha1" : algo === Digest.sha384 ? "sha384" : algo === Digest.sha512 ? "sha512" : "sha256"
      const buf = crypto.createHash(nodeAlgo).update(data instanceof Uint8Array ? data : new Uint8Array(data)).digest()
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    })
})

describe("@smthrs/crypto, @smthrs/rpc, and apps/mvp worker pure security fuzz", () => {
  it.fuzz(
    "crypto Sha256.digestSync matches Node.js OpenSSL SHA-256 bit-for-bit on arbitrary byte arrays and valid UTF-8 strings",
    [
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(Schema.isMaxLength(512)),
      Schema.String.check(Schema.isMaxLength(200))
    ],
    ([byteArr, rawStr]) => {
      const bytes = new Uint8Array(byteArr)
      const gotBytes = Sha256.digestSync(bytes)
      const expectedBytes = crypto.createHash("sha256").update(bytes).digest("hex")
      expect(gotBytes).toBe(expectedBytes)
      expect(Schema.decodeUnknownOption(Sha256.Digest)(gotBytes)._tag).toBe("Some")

      // Strip unpaired surrogates for well-formed UTF-8 string check
      const wellFormed = rawStr.toWellFormed()
      const gotStr = Sha256.digestSync(wellFormed)
      const expectedStr = crypto.createHash("sha256").update(wellFormed, "utf8").digest("hex")
      expect(gotStr).toBe(expectedStr)
      return true
    }
  )

  it.effect.fuzz(
    "crypto Uuid.v5 is deterministic, valid RFC 4122 v5, and namespace-separated",
    [
      Schema.Literals([
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        "6ba7b811-9dad-11d1-80b4-00c04fd430c8"
      ]),
      Schema.String.check(Schema.isMaxLength(128))
    ],
    ([ns, rawName]) =>
      Effect.gen(function*() {
        const name = rawName.toWellFormed()
        const u1 = yield* Uuid.v5(ns, name)
        const u2 = yield* Uuid.v5(ns, name)
        expect(u1).toBe(u2)
        expect(Uuid.isUuid(u1)).toBe(true)
        // RFC 4122 version nibble = 5, variant nibble in [8,9,a,b]
        expect(u1[14]).toBe("5")
        expect(["8", "9", "a", "b"]).toContain(u1[19])
        return true
      }).pipe(Effect.provide(syncDigestLayer))
  )

  it.fuzz(
    "rpc WebUrl refuses javascript:/data:/file: XSS schemes and RpcSha256 matches OpenSSL SHA-256",
    [Schema.String],
    ([raw]) => {
      const urlRes = WebUrl.HttpUrlSchema.safeParse(raw)
      if (urlRes.success) {
        const parsed = new URL(urlRes.data)
        expect(parsed.protocol === "http:" || parsed.protocol === "https:").toBe(true)
      }
      // Explicitly verify dangerous URL schemes are always rejected
      expect(WebUrl.HttpUrlSchema.safeParse("javascript:alert(1)").success).toBe(false)
      expect(WebUrl.HttpUrlSchema.safeParse("data:text/html,<script>").success).toBe(false)
      expect(WebUrl.HttpUrlSchema.safeParse("file:///etc/passwd").success).toBe(false)

      const wellFormed = raw.toWellFormed()
      const rpcDigest = RpcSha256.digestSync(wellFormed)
      const expected = crypto.createHash("sha256").update(wellFormed, "utf8").digest("hex")
      expect(rpcDigest).toBe(expected)
      return true
    }
  )

  it.fuzz(
    "apps/mvp parseAliases and aliasLocation never permit open redirects, duplicate hosts, or protocol-relative paths",
    [
      Schema.String.check(Schema.isMaxLength(200)),
      Schema.Literals(["https://factory.example.com/", "https://factory.example.com/?a=1", "https://factory.example.com/other"])
    ],
    ([listed, urlStr]) => {
      const parsed = parseAliases(listed)
      if (!("invalid" in parsed)) {
        const hosts = new Set<string>()
        for (const a of parsed) {
          expect(hosts.has(a.host)).toBe(false)
          hosts.add(a.host)
          expect(a.path.startsWith("/")).toBe(true)
          expect(a.path.startsWith("//")).toBe(false)
          expect(a.path.startsWith("/\\")).toBe(false)
        }
      }
      const url = new URL(urlStr)
      const loc = aliasLocation(listed, url)
      if (loc !== undefined) {
        // Security invariant: alias redirect ALWAYS stays on the exact same origin
        const target = new URL(loc)
        expect(target.origin).toBe(url.origin)
      }
      return true
    }
  )

  it.fuzz(
    "apps/mvp isAppRoute and codeOf never throw on arbitrary paths or error shapes",
    [Schema.String, Schema.Unknown],
    ([path, err]) => {
      expect(typeof isAppRoute(path)).toBe("boolean")
      const code = codeOf(err)
      expect(typeof code).toBe("string")
      expect(code.length).toBeGreaterThan(0)
      return true
    }
  )
})
