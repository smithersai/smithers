import { syncCrypto } from "@smthrs/crypto"
import * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, test } from "vitest"
import { DerivedKey, deriveKey, digest, StoredKey } from "../src/index.ts"

const smallMaterial = {
  domain: "smithers.flow.step",
  version: 1,
  flow: "deploy",
  stepId: "build-worker",
  inputs: { commit: "a".repeat(40), env: "staging" }
}

const mediumMaterial = {
  domain: "smithers.flow.plan",
  version: 1,
  flow: "release",
  nodes: Array.from({ length: 24 }, (_, index) => ({
    id: `node-${index}`,
    kind: "sealed",
    dependsOn: index > 0 ? [`node-${index - 1}`] : [],
    capabilities: ["fs:read:/src/**", "proc:spawn:pnpm"],
    body: { target: `pkg-${index}`, flags: ["--release", "--frozen-lockfile"] }
  }))
}

const provideSync = <A, E>(effect: Effect.Effect<A, E, EffectDigest.Digest>) =>
  Effect.provideService(effect, EffectDigest.Digest, syncCrypto)

const deriveSmall = provideSync(deriveKey(smallMaterial))
const deriveMedium = provideSync(deriveKey(mediumMaterial))
const decodeDerived = provideSync(Schema.decodeUnknownEffect(DerivedKey)(smallMaterial, { reportInput: false }))
const sampleKey = Effect.runSync(deriveSmall)
const decodeStored = Schema.decodeUnknownSync(StoredKey)

const opts = { time: 120, warmupTime: 30 }

const runSync = Effect.runSync
const extractDigest = digest

describe("@smthrs/keys", () => {
  test("deriveKey small step material", async ({ bench }) => {
    await bench("deriveKey (small)", () => {
      runSync(deriveSmall)
    }).run(opts)
  })

  test("deriveKey medium 24-node material", async ({ bench }) => {
    await bench("deriveKey (24 nodes)", () => {
      runSync(deriveMedium)
    }).run(opts)
  })

  test("DerivedKey schema decode", async ({ bench }) => {
    await bench("DerivedKey decode", () => {
      runSync(decodeDerived)
    }).run(opts)
  })

  test("StoredKey validation", async ({ bench }) => {
    await bench("StoredKey decodeSync", () => {
      decodeStored(sampleKey)
    }).run(opts)
  })

  test("digest extraction from KeyV1", async ({ bench }) => {
    await bench("digest(key)", () => {
      extractDigest(sampleKey)
    }).run(opts)
  })
})
