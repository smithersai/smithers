import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Effect, type Layer, PlatformError } from "effect"
import * as Digest from "effect/crypto/Digest"
import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Crypto, digest as sha256, digestSync, WebCrypto } from "../src/index.ts"

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const randomBytes = (size: number) => Effect.runSync(WebCrypto.make().randomBytes(size))

const digest = (algorithm: Crypto.DigestAlgorithm, data: Uint8Array) =>
  Effect.runPromise(WebCrypto.make().digest(algorithm, data))

const refusal = (algorithm: Crypto.DigestAlgorithm, data: Uint8Array) =>
  Effect.runPromise(Effect.flip(WebCrypto.make().digest(algorithm, data)))

afterEach(() => {
  vi.restoreAllMocks()
})

describe("WebCrypto.make randomBytes", () => {
  it.each([
    [0, []],
    [1, [1]],
    [65_536, [65_536]],
    [65_537, [65_536, 1]],
    [70_000, [65_536, 4_464]],
    [131_073, [65_536, 65_536, 1]]
  ])("fills %i bytes in chunks of at most 65,536", (size, chunks) => {
    const getRandomValues = vi.spyOn(globalThis.crypto, "getRandomValues")
    const bytes = randomBytes(size)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBe(size)
    expect(getRandomValues.mock.calls.map(([view]) => (view as Uint8Array).length)).toEqual(chunks)
  })

  it("fills every chunk, not only the first", () => {
    const bytes = randomBytes(3 * 65_536)
    for (let offset = 0; offset < bytes.length; offset += 65_536) {
      expect(bytes.subarray(offset, offset + 65_536).some((byte) => byte !== 0)).toBe(true)
    }
  })

  it("feeds Effect's derived randomness, such as a v4 UUID", () => {
    expect(Effect.runSync(WebCrypto.make().randomUUIDv4())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })
})

describe("randomness is read only on demand", () => {
  it("reads none while the module evaluates or make builds the service", async () => {
    const getRandomValues = vi.spyOn(globalThis.crypto, "getRandomValues")
    vi.resetModules()
    const fresh = await import("../src/WebCrypto.ts")
    const service = fresh.make()
    expect(getRandomValues).not.toHaveBeenCalled()
    Effect.runSync(service.randomBytes(16))
    expect(getRandomValues).toHaveBeenCalledTimes(1)
  })
})

describe("WebCrypto.make digest", () => {
  it("computes the FIPS 180-4 SHA-256 of abc", async () => {
    expect(hex(await digest("SHA-256", new TextEncoder().encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })

  it("agrees with the package's own SHA-256", async () => {
    const material = new TextEncoder().encode("the same key material on both sides of the machine boundary")
    expect(hex(await digest("SHA-256", material))).toBe(digestSync(material))
  })

  it.each(
    [
      ["SHA-1", Digest.sha1],
      ["SHA-256", Digest.sha256],
      ["SHA-384", Digest.sha384],
      ["SHA-512", Digest.sha512]
    ] as const
  )(
    "agrees with Node's crypto for %s, so a guest and its Node host derive the same ids",
    async (algorithm, nodeAlgorithm) => {
      const material = new TextEncoder().encode("the same key material on both sides of the machine boundary")
      const onNode = await Effect.runPromise(
        Effect.gen(function*() {
          return yield* (yield* Digest.Digest).digest(nodeAlgorithm, material)
        }).pipe(Effect.provide(NodeCrypto.layerDigest))
      )
      expect(await digest(algorithm, material)).toEqual(onNode)
    }
  )

  it("hashes the bytes a subarray views, not its whole buffer", async () => {
    const buffer = new TextEncoder().encode("xabcx")
    expect(hex(await digest("SHA-256", buffer.subarray(1, 4)))).toBe(digestSync("abc"))
  })

  it("maps a WebCrypto rejection to an Unknown PlatformError carrying the cause", async () => {
    const cause = new DOMException("the operation failed", "OperationError")
    vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValueOnce(cause)
    const error = await refusal("SHA-256", new Uint8Array(1))
    expect(error).toBeInstanceOf(PlatformError.PlatformError)
    expect(error.reason).toMatchObject({
      _tag: "Unknown",
      module: "Crypto",
      method: "digest",
      description: "WebCrypto could not compute SHA-256"
    })
    expect(error.reason.cause).toBe(cause)
  })

  it("names an algorithm WebCrypto refuses in the failure", async () => {
    const error = await refusal("MD5" as Crypto.DigestAlgorithm, new Uint8Array(1))
    expect(error.reason).toMatchObject({ _tag: "Unknown", module: "Crypto", method: "digest" })
    expect(error.message).toContain("WebCrypto could not compute MD5")
  })
})

describe("WebCrypto.layer", () => {
  it("provides the WebCrypto service as Effect's Crypto", async () => {
    const getRandomValues = vi.spyOn(globalThis.crypto, "getRandomValues")
    const [bytes, digested] = await Effect.runPromise(
      Effect.gen(function*() {
        const crypto = yield* Crypto.Crypto
        return [
          yield* crypto.randomBytes(70_000),
          yield* crypto.digest("SHA-256", new TextEncoder().encode("abc"))
        ] as const
      }).pipe(Effect.provide(WebCrypto.layer))
    )
    expect(bytes.length).toBe(70_000)
    expect(getRandomValues).toHaveBeenCalledTimes(2)
    expect(hex(digested)).toBe(digestSync("abc"))
  })
})

// The signatures docs/api.md publishes, annotated onto the real exports, so the
// typecheck rejects a documented type that no longer describes the source.
const documentedMake: () => Crypto.Crypto = WebCrypto.make
const documentedLayer: Layer.Layer<Crypto.Crypto> = WebCrypto.layer

const api = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8")

/** The first TypeScript fence under a `###` heading of the API reference. */
const signature = (heading: string): string => {
  const [, section] = api.split(`\n### ${heading}\n`)
  const fence = section?.split("```ts\n")[1]?.split("```")[0]
  if (fence === undefined) throw new Error(`docs/api.md has no ts fence under "### ${heading}"`)
  return fence
}

describe("docs/api.md WebCrypto signatures", () => {
  it("declares make and layer as the source exports them", () => {
    expect(signature("WebCrypto.make")).toBe("const make: () => Crypto.Crypto\n")
    expect(signature("WebCrypto.layer")).toBe("const layer: Layer.Layer<Crypto.Crypto>\n")
    expect(documentedMake).toBe(WebCrypto.make)
    expect(documentedLayer).toBe(WebCrypto.layer)
  })

  it("the documented example hashes through the layer", async () => {
    expect(await Effect.runPromise(sha256("hello").pipe(Effect.provide(WebCrypto.layer)))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    )
  })
})
