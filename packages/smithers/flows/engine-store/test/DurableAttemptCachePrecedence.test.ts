import { describe, expect, it } from "@effect/vitest"
import { AttemptStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, boundary, descriptor, jj, owner } from "./CachePolicyFixtures.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const layer = Layer.mergeAll(TestStores.layer(), boundary(), jj)
const dispatch = (runId: string, execute: ActionPersistence.Dependencies["execute"]) =>
  ActionPersistence.make({ runId, owner, sourceId: "cache-precedence", execute })({
    action: {},
    key: "cache-precedence",
    attempt: 1,
    tier: "sealed",
    nondeterministic: true,
    metadata: descriptor
  })

describe("durable attempts precede shared cache acceleration", () => {
  it.effect("preserves a succeeded run's own result after another producer replaces the evicted cache entry", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("original")
        expect(yield* dispatch("original", () => Effect.succeed("original-result"))).toBe("original-result")
        const cache = yield* CacheStore.CacheStore
        yield* cache.evict(sha256("cache-precedence"))
        yield* activate("replacement")
        expect(yield* dispatch("replacement", () => Effect.succeed("replacement-result"))).toBe("replacement-result")
        expect(yield* dispatch("original", () => Effect.die("body must not repeat"))).toBe("original-result")
        expect(Option.getOrThrow(yield* cache.get(sha256("cache-precedence"))).result).toBe("replacement-result")
      }).pipe(Effect.provide(layer), Effect.scoped)
    ))

  it.effect("rethrows a persisted failure even when another run has since published a cache hit", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("failed")
        expect(yield* dispatch("failed", () => Effect.fail("original-failure")).pipe(Effect.flip))
          .toBe("original-failure")
        yield* activate("replacement")
        yield* dispatch("replacement", () => Effect.succeed("replacement-result"))
        expect(yield* dispatch("failed", () => Effect.die("body must not repeat")).pipe(Effect.flip))
          .toBe("original-failure")
        const attempts = yield* AttemptStore.AttemptStore
        expect(
          Option.getOrThrow(
            yield* attempts.get({
              runId: "failed",
              stepKeyDigest: sha256("cache-precedence"),
              attempt: 1
            })
          ).state
        ).toBe("failed")
      }).pipe(Effect.provide(layer), Effect.scoped)
    ))
})
