import * as Effect from "effect/Effect"
import { describe, test } from "vitest"
import { digest, digestSync, Identity, makeDigestPartsSync, Uuid, WebCrypto } from "../src/index.ts"

const smallText = JSON.stringify({
  domain: "smithers.flow.step",
  step: "compile",
  commit: "0123456789abcdef".repeat(4),
  inputs: ["src/index.ts", "src/Engine.ts"]
})

const payload64K = new Uint8Array(64 * 1024)
for (let i = 0; i < payload64K.length; i++) payload64K[i] = (i * 31) & 0xff

const payload4K = payload64K.subarray(0, 4096)
const digestWebCrypto4K = digest(payload4K).pipe(Effect.provide(WebCrypto.layer))

const sharedPrefix = Array.from({ length: 8 }, (_, index) => `prefix-segment-${index}-${"x".repeat(128)}`)
const prefixHasher = makeDigestPartsSync()
let suffixCounter = 0
prefixHasher([...sharedPrefix, "tail-init"])

const baseFn = function compute(this: Readonly<{ readonly region: string; readonly retries: number }>, input: string) {
  return `${this.region}:${this.retries}:${input}`
}
const capturedFn = Identity.capture({ region: "us-east-1", retries: 3 }, baseFn)

const uuidNamespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
const uuidV5Effect = Uuid.v5(uuidNamespace, "smithers/branch/main/conversation").pipe(Effect.provide(WebCrypto.layer))

const opts = { time: 120, warmupTime: 30 }

const digestSyncFn = digestSync
const captureFn = Identity.capture
const functionIdentityFn = Identity.functionIdentity
const runPromise = Effect.runPromise

describe("@smthrs/crypto", () => {
  test("digestSync small UTF-8 string", async ({ bench }) => {
    await bench("digestSync (small string)", () => {
      digestSyncFn(smallText)
    }).run(opts)
  })

  test("digestSync 64 KB Uint8Array", async ({ bench }) => {
    await bench("digestSync (64 KB bytes)", () => {
      digestSyncFn(payload64K)
    }).run(opts)
  })

  test("digest async WebCrypto 4 KB", async ({ bench }) => {
    await bench("digest WebCrypto (4 KB)", () => runPromise(digestWebCrypto4K)).run(opts)
  })

  test("makeDigestPartsSync with 8-segment shared prefix", async ({ bench }) => {
    await bench("makeDigestPartsSync (prefix hit)", () => {
      prefixHasher([...sharedPrefix, `tail-${suffixCounter++}`])
    }).run(opts)
  })

  test("Identity.capture and functionIdentity", async ({ bench }) => {
    await bench("Identity.capture", () => {
      captureFn({ region: "us-east-1", retries: 3 }, baseFn)
    }).run(opts)

    await bench("Identity.functionIdentity", () => {
      functionIdentityFn(capturedFn)
    }).run(opts)
  })

  test("Uuid.v5 over WebCrypto", async ({ bench }) => {
    await bench("Uuid.v5", () => runPromise(uuidV5Effect)).run(opts)
  })
})
