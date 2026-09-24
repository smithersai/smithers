import { describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { readFileSync } from "node:fs"
import * as Inconsistency from "../src/Inconsistency.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "inconsistency-host", pid: 7, nonce: "inconsistency-process" }

const boundary: ActionPersistence.BoundaryMetadata = {
  readSet: [],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () =>
      Effect.succeed({ commitId: "inconsistency-snapshot" as never, changeId: "inconsistency-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const base = Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jj)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") {
      return yield* Effect.die(new Error(`run ${runId} claim was lost`))
    }
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") {
      return yield* Effect.die(new Error(`run ${runId} activation was lost`))
    }
  })

// A recorded row whose meta fails the sealed hard-boundary replay check: the
// executor skips the cache hit, dispatches, and its put reports a conflict.
const seedConflictingRow = (keyDigest: string, result: unknown) =>
  Effect.gen(function*() {
    const cache = yield* CacheStore.CacheStore
    yield* cache.put({
      keyDigest,
      result,
      meta: {},
      createdAtMs: 1,
      recordedRunId: "recorded-run",
      recordedEventSeq: 0
    })
  })

const dispatch = (runId: string, key: string, result: string) =>
  ActionPersistence.make({
    runId,
    owner,
    sourceId: "inconsistency-test",
    execute: () => Effect.succeed(result)
  })({
    action: {},
    attempt: 1,
    key,
    tier: "sealed",
    metadata: boundary
  })

const conflictEvents = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 50 })
    return page.entries.filter((entry) => entry.eventType === "flows.engine.cache-conflict")
  })

describe("Inconsistency", () => {
  it.effect("journals the conflict and fails the run under layerStrict", () =>
    Effect.gen(function*() {
      const key = "inconsistency/strict"
      const keyDigest = sha256(key)
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("strict-run")
          yield* seedConflictingRow(keyDigest, "original")
          const error = yield* Effect.flip(dispatch("strict-run", key, "divergent"))
          const cache = yield* CacheStore.CacheStore
          return {
            error,
            cached: yield* cache.get(keyDigest),
            conflicts: yield* conflictEvents("strict-run")
          }
        }).pipe(Effect.provide(Layer.provideMerge(Inconsistency.layerStrict(owner), base)), Effect.scoped)
      )

      expect(result.error).toBeInstanceOf(ActionPersistence.CacheConflictDetected)
      expect(result.error).toMatchObject({
        code: "cache_conflict_detected",
        keyDigest,
        recordedRunId: "recorded-run"
      })
      expect(Option.getOrThrow(result.cached).result).toBe("original")
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]!.payload).toMatchObject({ cacheKey: keyDigest, verdict: "fail" })
    }))

  it.effect("journals the conflict and keeps serving the original row under layerTolerant", () =>
    Effect.gen(function*() {
      const key = "inconsistency/tolerant"
      const keyDigest = sha256(key)
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("tolerant-run")
          yield* seedConflictingRow(keyDigest, "original")
          const value = yield* dispatch("tolerant-run", key, "divergent")
          const cache = yield* CacheStore.CacheStore
          return {
            value,
            cached: yield* cache.get(keyDigest),
            conflicts: yield* conflictEvents("tolerant-run")
          }
        }).pipe(Effect.provide(Layer.provideMerge(Inconsistency.layerTolerant(owner), base)), Effect.scoped)
      )

      expect(result.value).toBe("divergent")
      expect(Option.getOrThrow(result.cached).result).toBe("original")
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]!.payload).toMatchObject({ cacheKey: keyDigest, verdict: "tolerate" })
    }))

  it.effect("does not note Inserted or ExistingSame puts", () =>
    Effect.gen(function*() {
      let notes = 0
      const counting = Inconsistency.layerNoop({
        note: () =>
          Effect.sync(() => {
            notes++
            return "tolerate" as const
          })
      })
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("clean-run")
          yield* seedConflictingRow(sha256("inconsistency/existing-same"), "same")
          const inserted = yield* dispatch("clean-run", "inconsistency/inserted", "fresh")
          const existingSame = yield* dispatch("clean-run", "inconsistency/existing-same", "same")
          return { inserted, existingSame, conflicts: yield* conflictEvents("clean-run") }
        }).pipe(Effect.provide(Layer.merge(base, counting)), Effect.scoped)
      )

      expect(result.inserted).toBe("fresh")
      expect(result.existingSame).toBe("same")
      expect(result.conflicts).toHaveLength(0)
      expect(notes).toBe(0)
    }))

  it("never discards a cache.put result in ActionPersistence", () => {
    const source = readFileSync(new URL("../src/internal/ActionPersistence.ts", import.meta.url), "utf8")
    const puts = source.match(/cache\.put\(/g) ?? []
    const bound = source.match(/= yield\* cache\.put\(/g) ?? []
    expect(puts.length).toBeGreaterThan(0)
    expect(bound.length).toBe(puts.length)
  })
})
