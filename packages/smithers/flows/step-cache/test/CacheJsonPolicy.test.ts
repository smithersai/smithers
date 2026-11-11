import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as CacheStore from "../src/CacheStore.vibe"

/** A tree one level deeper than the cache admits. */
const overDeep = (): unknown => {
  let value: unknown = true
  for (let depth = 0; depth <= CacheStore.maximumJsonDepth; depth++) value = { child: value }
  return value
}

describe("cache JSON policy", () => {
  it.effect("forwards the shared boundary's complaint verbatim under the field name", () =>
    Effect.gen(function*() {
      const refusals = [
        [overDeep(), `result exceeds the maximum JSON depth of ${CacheStore.maximumJsonDepth}`],
        [Number.POSITIVE_INFINITY, "result contains a non-finite number"],
        [1n, "result contains a non-JSON bigint"],
        [new Array(CacheStore.maximumJsonMembers + 1).fill(0), "result exceeds the JSON members limit"]
      ] as const

      const messages = yield* Effect.forEach(refusals, ([value]) =>
        Effect.map(
          Effect.flip(CacheStore.encodeCanonical(value, "result")),
          (failure) => `${failure.code}: ${failure.message}`
        ))

      expect(messages).toEqual(refusals.map(([, message]) => `invalid_cache: ${message}`))
    }))

  it.effect("counts encoded bytes, not source characters, against the cache byte budget", () =>
    Effect.gen(function*() {
      // A newline encodes as the two-byte escape `\n`, so a string of half the
      // budget's characters is over the budget once encoded, while the same
      // number of one-byte characters is inside it.
      const characters = CacheStore.maximumJsonBytes / 2
      const failure = yield* Effect.flip(CacheStore.encodeCanonical("\n".repeat(characters), "meta"))
      expect(failure.message).toBe("meta contains unbounded or ill-formed text")
      expect(yield* CacheStore.encodeCanonical("a".repeat(characters), "meta")).toHaveLength(characters + 2)
    }))

  it.effect("keeps the boundary's accounting out of the admitted entry", () =>
    Effect.gen(function*() {
      const snapshot = yield* CacheStore.snapshotEntry({
        keyDigest: "digest-1",
        result: { output: "ok" },
        meta: { source: "recorded" },
        createdAtMs: 10,
        recordedRunId: "run-1",
        recordedEventSeq: 7
      })

      expect(Object.keys(snapshot).sort()).toEqual([
        "createdAtMs",
        "keyDigest",
        "meta",
        "recordedEventSeq",
        "recordedRunId",
        "result"
      ])
      expect(snapshot.result).toEqual({ output: "ok" })
      expect(snapshot.meta).toEqual({ source: "recorded" })
    }))
})
