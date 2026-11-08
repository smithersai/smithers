import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { CacheStore } from "../src/CacheStore.vibe"
import * as TestCacheStore from "../src/test/TestCacheStore.vibe"

describe("TestCacheStore", () => {
  it.effect("provides a migrated step cache over an in-memory database", () =>
    Effect.gen(function*() {
      const entry = yield* (
        Effect.gen(function*() {
          const cache = yield* CacheStore
          yield* cache.put({
            keyDigest: "bundle-cache",
            result: { value: "ok" },
            meta: {},
            createdAtMs: 2,
            recordedRunId: "bundle-run",
            recordedEventSeq: 0
          })
          return yield* cache.get("bundle-cache")
        }).pipe(Effect.provide(TestCacheStore.layer), Effect.scoped)
      )

      expect(Option.getOrThrow(entry).result).toEqual({ value: "ok" })
    }))
})
