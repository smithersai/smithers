import { Effect } from "effect"
import { transformSync } from "esbuild"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Crypto from "../src/Crypto.vibe"
import { type Digest, digest, digestSync, type Sha256Error, syncCrypto } from "../src/index.ts"

// Execute the published put fence so the regression follows the example itself.
const quickstart = readFileSync(new URL("../docs/quickstart.md", import.meta.url), "utf8")
const fence = quickstart.split("```ts\n")[1]?.split("```")[0]
if (fence === undefined) throw new Error("docs/quickstart.md has no TypeScript fence")
const { code } = transformSync(fence.replace(/^import .*\n/gm, "").replace("export const put", "const put"), {
  loader: "ts"
})
const makeStore = () =>
  new Function("digest", "Effect", `${code}\nreturn { put, blobs }`)(digest, Effect) as {
    put: (bytes: Uint8Array) => Effect.Effect<Digest, Sha256Error, Crypto.Crypto>
    blobs: Map<string, Uint8Array>
  }

describe("docs/quickstart.md content-addressed put", () => {
  it("preserves stored bytes when the caller reuses its buffer after put", () => {
    const { put, blobs } = makeStore()
    const input = new TextEncoder().encode("abc")
    const address = Effect.runSync(put(input).pipe(Effect.provideService(Crypto.Crypto, syncCrypto)))
    input.fill(0)

    const stored = blobs.get(address)!
    expect(digestSync(stored)).toBe(address)
    expect(stored).toEqual(new TextEncoder().encode("abc"))
    expect(stored).not.toBe(input)
  })

  it("owns its bytes before an asynchronous host yields and publishes only after hashing", async () => {
    const { put, blobs } = makeStore()
    const input = new TextEncoder().encode("abc")
    const crypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (algorithm, snapshot) =>
        Effect.gen(function*() {
          yield* Effect.promise(async () => {
            await Promise.resolve()
            expect(blobs.size).toBe(0)
            input.fill(0)
          })
          return yield* syncCrypto.digest(algorithm, snapshot)
        })
    })
    const address = await Effect.runPromise(put(input).pipe(Effect.provideService(Crypto.Crypto, crypto)))

    const stored = blobs.get(address)!
    expect(address).toBe(digestSync("abc"))
    expect(input).toEqual(new Uint8Array(3))
    expect(stored).not.toBe(input)
    expect(digestSync(stored)).toBe(address)
    expect(stored).toEqual(new TextEncoder().encode("abc"))
    input.fill(1)
    expect(digestSync(stored)).toBe(address)
  })
})
