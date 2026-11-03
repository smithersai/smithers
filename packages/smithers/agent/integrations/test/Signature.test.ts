import { Effect } from "effect"
import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  computeHmacSha256Hex,
  constantTimeEqual,
  GITHUB_SIGNATURE_PREFIX,
  type VerifyOptions,
  verifySignature
} from "../src/core/Signature.ts"

const SECRET = "shared-secret-correct"
const BODY = JSON.stringify({ branch: "main" })

// `node:crypto` is the oracle: the module under test computes with WebCrypto,
// so a digest it agrees with here was not checked against itself.
const hmac = (payload: string | Uint8Array, secret: string) => createHmac("sha256", secret).update(payload)
const hex = (payload: string, secret: string) => hmac(payload, secret).digest("hex")
const base64 = (payload: string, secret: string) => hmac(payload, secret).digest("base64")
const verify = (options: VerifyOptions) => Effect.runPromise(verifySignature(options))

describe("constantTimeEqual", () => {
  it("accepts identical bytes", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
  })

  // The pin: a comparison that returned early on the first differing byte
  // would leak the expected digest one byte at a time to an attacker who can
  // time the endpoint. The rejection must not depend on where the difference
  // is, so a difference in the last byte is rejected exactly like one in the
  // first, and a length mismatch is answered rather than thrown.
  it("rejects a difference in any position, including the last", () => {
    expect(constantTimeEqual(new Uint8Array([9, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(false)
    expect(constantTimeEqual(new Uint8Array([1, 2, 9]), new Uint8Array([1, 2, 3]))).toBe(false)
  })

  it("rejects a length mismatch without throwing", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false)
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true)
  })
})

describe("computeHmacSha256Hex", () => {
  it("agrees with node:crypto on text, bytes, UTF-8 and a key longer than the block", async () => {
    const cases: ReadonlyArray<readonly [string | Uint8Array, string]> = [
      [BODY, SECRET],
      [new TextEncoder().encode(BODY), SECRET],
      ["", SECRET],
      ["héllo ✓ 🦀", "sécret ✓"],
      [BODY, "k".repeat(200)]
    ]
    for (const [payload, secret] of cases) {
      expect(await Effect.runPromise(computeHmacSha256Hex(payload, secret))).toBe(hmac(payload, secret).digest("hex"))
    }
  })

  // WebCrypto refuses a zero-length HMAC key, and HMAC zero-pads a short key
  // to the block size, so the empty key is computed as one zero byte.
  it("signs with an empty secret exactly as HMAC defines it", async () => {
    expect(await Effect.runPromise(computeHmacSha256Hex(BODY, ""))).toBe(hex(BODY, ""))
  })

  it("reads its input when it runs, not when it is built", async () => {
    const bytes = new TextEncoder().encode(BODY)
    const digest = computeHmacSha256Hex(bytes, SECRET)
    bytes[0] = 0
    expect(await Effect.runPromise(digest)).toBe(hmac(bytes, SECRET).digest("hex"))
  })
})

describe("verifySignature", () => {
  it("accepts the GitHub sha256= hex form", async () => {
    expect(
      await verify({
        payload: BODY,
        secret: SECRET,
        signature: `${GITHUB_SIGNATURE_PREFIX}${hex(BODY, SECRET)}`,
        prefix: GITHUB_SIGNATURE_PREFIX
      })
    ).toBe(true)
  })

  it("accepts a bare hex digest, which is what Linear sends", async () => {
    expect(await verify({ payload: BODY, secret: SECRET, signature: hex(BODY, SECRET) })).toBe(true)
  })

  it("accepts an uppercase hex digest", async () => {
    expect(await verify({ payload: BODY, secret: SECRET, signature: hex(BODY, SECRET).toUpperCase() })).toBe(true)
  })

  it("accepts a base64 digest, padded or not", async () => {
    expect(await verify({ payload: BODY, secret: SECRET, signature: base64(BODY, SECRET) })).toBe(true)
    expect(await verify({ payload: BODY, secret: SECRET, signature: base64(BODY, SECRET).replace(/=+$/, "") }))
      .toBe(true)
  })

  it("strips an optional sha256= prefix when no prefix is required", async () => {
    expect(await verify({ payload: BODY, secret: SECRET, signature: `SHA256=${hex(BODY, SECRET)}` })).toBe(true)
  })

  it("rejects a digest computed with a different secret", async () => {
    expect(
      await verify({
        payload: BODY,
        secret: SECRET,
        signature: `${GITHUB_SIGNATURE_PREFIX}${hex(BODY, "shared-secret-wrong")}`,
        prefix: GITHUB_SIGNATURE_PREFIX
      })
    ).toBe(false)
  })

  // A near-miss is the shape a timing attack produces, so it gets its own case.
  it("rejects a digest that differs only in its final character", async () => {
    const digest = hex(BODY, SECRET)
    const tampered = `${digest.slice(0, -1)}${digest.endsWith("a") ? "b" : "a"}`
    expect(await verify({ payload: BODY, secret: SECRET, signature: tampered })).toBe(false)
  })

  it("rejects a signature over different bytes", async () => {
    expect(await verify({ payload: BODY, secret: SECRET, signature: hex(`${BODY} `, SECRET) })).toBe(false)
  })

  it("rejects a missing, empty, or non-string signature", async () => {
    expect(await verify({ payload: BODY, secret: SECRET, signature: undefined })).toBe(false)
    expect(await verify({ payload: BODY, secret: SECRET, signature: null })).toBe(false)
    expect(await verify({ payload: BODY, secret: SECRET, signature: "" })).toBe(false)
  })

  it("rejects an empty secret", async () => {
    expect(await verify({ payload: BODY, secret: "", signature: hex(BODY, "") })).toBe(false)
  })

  it("rejects a required prefix that is absent, and an empty digest after it", async () => {
    expect(
      await verify({ payload: BODY, secret: SECRET, signature: hex(BODY, SECRET), prefix: GITHUB_SIGNATURE_PREFIX })
    ).toBe(false)
    expect(
      await verify({
        payload: BODY,
        secret: SECRET,
        signature: GITHUB_SIGNATURE_PREFIX,
        prefix: GITHUB_SIGNATURE_PREFIX
      })
    ).toBe(false)
  })

  it("rejects a digest that is neither hex nor base64", async () => {
    expect(await verify({ payload: BODY, secret: SECRET, signature: "not a digest!!" })).toBe(false)
  })

  // Base64-shaped but undecodable: one character past a whole quantum, or
  // padding that does not end a quantum. The decoder's refusal is a `false`,
  // never a throw that would kill the ingress fiber.
  it("rejects a base64-shaped digest that does not decode", async () => {
    expect(await verify({ payload: BODY, secret: SECRET, signature: "a" })).toBe(false)
    expect(await verify({ payload: BODY, secret: SECRET, signature: `${base64(BODY, SECRET)}=` })).toBe(false)
  })

  it("verifies raw bytes, not only strings", async () => {
    const bytes = new TextEncoder().encode(BODY)
    expect(await verify({ payload: bytes, secret: SECRET, signature: hex(BODY, SECRET) })).toBe(true)
  })

  it("does no work until it runs", async () => {
    const options = { payload: BODY, secret: SECRET, signature: hex(BODY, SECRET) }
    const verdict = verifySignature(options)
    options.signature = hex(BODY, "shared-secret-wrong")
    expect(await Effect.runPromise(verdict)).toBe(false)
  })
})
