import { describe, test } from "vitest"
import { resolveRedactionOptions } from "../../scripts/redact-state.ts"
import { constantTimeEquals } from "../constantTimeEquals.ts"
import { jsonTextFault } from "../jsonTextFault.ts"
import { canonicalJson, invalidKeyDigest } from "../protocol.ts"

const opts = { time: 120, warmupTime: 30 }

const cachePayload = {
  version: 1,
  keyDigest: "a".repeat(64),
  target: "//packages/smithers/build/targets:test",
  outputs: Array.from({ length: 24 }, (_, index) => ({
    path: `dist/esm/file-${index}.js`,
    digest: `${index.toString(16).padStart(2, "0")}${"b".repeat(62)}`,
    bytes: 4096 + index * 128,
    executable: false
  })),
  metadata: {
    durationMs: 1420,
    toolchain: { node: "26.10.0", pnpm: "11.25.0" }
  }
}

const payloadJson = JSON.stringify(cachePayload)

const keyDigests = [
  "a".repeat(64),
  "ns-ci/" + "f".repeat(64),
  "../escape/" + "a".repeat(64),
  "invalid-digest-too-short"
]

const hashA = new Uint8Array(32).fill(0x5a)
const hashB = new Uint8Array(32).fill(0x5a)
const hashC = new Uint8Array(32).fill(0x5a)
hashC[31] = 0x5b

describe("@smthrs/build-infra", () => {
  test("canonicalJson on action-cache payload", async ({ bench }) => {
    await bench("canonicalJson (24 outputs)", () => {
      canonicalJson(cachePayload)
    }).run(opts)
  })

  test("jsonTextFault scanning JSON payload", async ({ bench }) => {
    await bench("jsonTextFault (~3 KB JSON)", () => {
      jsonTextFault(payloadJson, { numbers: true })
    }).run(opts)
  })

  test("invalidKeyDigest across 4 digests", async ({ bench }) => {
    await bench("invalidKeyDigest (4 keys)", () => {
      for (const digest of keyDigests) invalidKeyDigest(digest)
    }).run(opts)
  })

  test("constantTimeEquals (32-byte digests)", async ({ bench }) => {
    await bench("constantTimeEquals (eq + neq)", () => {
      constantTimeEquals(hashA, hashB)
      constantTimeEquals(hashA, hashC)
    }).run(opts)
  })

  test("resolveRedactionOptions", async ({ bench }) => {
    await bench("resolveRedactionOptions", () => {
      resolveRedactionOptions({})
    }).run(opts)
  })
})
