import { syncCrypto } from "@smthrs/crypto"
import * as Context from "effect/Context"
import * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import { afterAll, describe, test } from "vitest"
import { ArtifactStore, ImmutableCache } from "../src/index.ts"

const scope = Effect.runSync(Scope.make())
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))

const provideCrypto = <A, E>(effect: Effect.Effect<A, E, EffectDigest.Digest>) =>
  Effect.provideService(effect, EffectDigest.Digest, syncCrypto)

const store = ArtifactStore.makeMemory()
const cache = Context.get(
  await Effect.runPromise(Layer.buildWithScope(ImmutableCache.layerMemory(), scope)),
  ImmutableCache.ImmutableCache
)

const blob4K = new Uint8Array(4096)
for (let i = 0; i < blob4K.length; i++) blob4K[i] = (i * 17) & 0xff

const storedDigest = Effect.runSync(provideCrypto(store.put(blob4K)))

// Pre-populate 100 digests, query mix of 50 present + 50 missing.
const batchDigests: Array<string> = []
for (let i = 0; i < 50; i++) {
  const bytes = new Uint8Array(64)
  bytes[0] = i
  batchDigests.push(Effect.runSync(provideCrypto(store.put(bytes))))
}
for (let i = 0; i < 50; i++) {
  batchDigests.push(String(i).padStart(64, "a"))
}

const cacheKey = ImmutableCache.key("repo.blob", "smithersai/smithers", "a".repeat(40), "src/Engine.ts")
const cacheEntry: ImmutableCache.Entry = { bytes: blob4K, metadata: { contentType: "text/typescript" } }
await Effect.runPromise(cache.put(cacheKey, cacheEntry))

const putEffect = provideCrypto(store.put(blob4K))
const getEffect = provideCrypto(store.get(storedDigest))
const hasEffect = store.has(storedDigest)
const findMissingEffect = store.findMissing(batchDigests)
const cacheGetEffect = cache.get(cacheKey)
const cachePutEffect = cache.put(cacheKey, cacheEntry)

const runSync = Effect.runSync
const runPromise = Effect.runPromise
const validateDigestFn = ArtifactStore.validateDigest
const opts = { time: 120, warmupTime: 30 }

describe("@smthrs/artifacts", () => {
  test("ArtifactStore memory put (4 KB)", async ({ bench }) => {
    await bench("ArtifactStore.put (4 KB)", () => {
      runSync(putEffect)
    }).run(opts)
  })

  test("ArtifactStore memory get + SHA-256 verify (4 KB)", async ({ bench }) => {
    await bench("ArtifactStore.get verified (4 KB)", () => {
      runSync(getEffect)
    }).run(opts)
  })

  test("ArtifactStore has and findMissing (100 digests)", async ({ bench }) => {
    await bench("ArtifactStore.has", () => {
      runSync(hasEffect)
    }).run(opts)

    await bench("ArtifactStore.findMissing (100)", () => {
      runSync(findMissingEffect)
    }).run(opts)
  })

  test("ArtifactStore.validateDigest", async ({ bench }) => {
    await bench("validateDigest", () => {
      runSync(validateDigestFn(storedDigest))
    }).run(opts)
  })

  test("ImmutableCache memory get hit and put (4 KB)", async ({ bench }) => {
    await bench("ImmutableCache.get hit (4 KB)", () => runPromise(cacheGetEffect)).run(opts)
    await bench("ImmutableCache.put (4 KB)", () => runPromise(cachePutEffect)).run(opts)
  })
})
