import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Clock, Effect, Exit, Layer, Logger, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { CacheStore, CombinedCacheStore, Migrations } from "../src/index.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261150")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(40, Math.min(baseExecutions, 120))

const assertPassed = <A, E = unknown>(report: Fuzz.Report<A, E>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const makeEntry = (
  keyDigest: string,
  value: number,
  createdAtMs: number,
  recordedRunId: string,
  recordedEventSeq: number
): CacheStore.CacheEntry => ({
  keyDigest,
  result: { value },
  meta: { source: "wave9" },
  createdAtMs,
  recordedRunId,
  recordedEventSeq
})

describe("@smthrs/step-cache Wave 9 deep CombinedCacheStore fuzzing", () => {
  it(
    "CombinedCacheStore upholds local-first, expired-head CAS refresh, exact-record refusal, remote failure resilience, deferred publication, and conflict metrics",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          publication: Schema.Literals(["inline", "deferred"]),
          remoteMode: Schema.Literals(["hit", "miss", "fail", "conflict"]),
          localState: Schema.Literals(["empty", "fresh", "expired-head", "expired-exact", "no-import-head"]),
          maxAgeMs: Schema.Literals([0, 500, 10_000]),
          siblingRace: Schema.Literals(["none", "same-key", "exact-expired"]),
          localConflict: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ publication, remoteMode, localState, maxAgeMs, siblingRace, localConflict }) =>
            Effect.gen(function*() {
              const sqlLocal = yield* CacheStore.CacheStore
              const remoteMap = new Map<string, CacheStore.CacheEntry>()
              const sqlRemote: CacheStore.Service = {
                get: (k) => Effect.sync(() => Option.fromUndefinedOr(remoteMap.get(k))),
                put: (e) =>
                  Effect.sync(() => {
                    const prev = remoteMap.get(e.keyDigest)
                    if (prev === undefined) {
                      remoteMap.set(e.keyDigest, e)
                      return { _tag: "Inserted" as const }
                    }
                    if (JSON.stringify(prev.result) === JSON.stringify(e.result)) {
                      return { _tag: "ExistingSame" as const, entry: prev }
                    }
                    return { _tag: "Conflict" as const, existing: prev }
                  }),
                evict: (k) => Effect.sync(() => remoteMap.delete(k)),
                sweepExpired: () => Effect.succeed(0)
              }
              const now = yield* Clock.currentTimeMillis
              const key = "a".repeat(64)
              const freshTs = now
              const oldTs = now - 60_000

              // Seed local state
              if (localState === "fresh") {
                yield* sqlLocal.put(makeEntry(key, 1, freshTs, "run-local", 1))
              } else if (localState === "expired-head") {
                yield* sqlLocal.put(makeEntry(key, 1, oldTs, "run-other", 1))
              } else if (localState === "expired-exact") {
                yield* sqlLocal.put(makeEntry(key, 1, oldTs, "run-exact", 7))
              }

              // Seed remote state
              if (remoteMode === "hit") {
                yield* sqlRemote.put(makeEntry(key, 2, freshTs, "run-remote", 3))
              } else if (remoteMode === "conflict") {
                yield* sqlRemote.put(makeEntry(key, 99, freshTs, "run-remote", 9))
              }

              const wrappedLocal: CacheStore.Service = localState === "no-import-head"
                ? {
                  get: sqlLocal.get,
                  put: sqlLocal.put,
                  evict: sqlLocal.evict,
                  sweepExpired: sqlLocal.sweepExpired
                }
                : sqlLocal

              let remoteGetCount = 0
              let remotePutCount = 0
              const wrappedRemote: CacheStore.Service = {
                get: (k, opts) =>
                  Effect.gen(function*() {
                    remoteGetCount += 1
                    if (remoteMode === "fail") {
                      return yield* new CacheStore.CacheStoreError({
                        code: "persistence_failed",
                        message: "remote get down"
                      })
                    }
                    if (siblingRace === "same-key") {
                      yield* sqlLocal.put(makeEntry(k, 77, freshTs, "run-sibling", 2))
                    } else if (siblingRace === "exact-expired") {
                      yield* sqlLocal.put(makeEntry(k, 88, oldTs, "run-exact", 7))
                    }
                    return yield* sqlRemote.get(k, opts)
                  }),
                put: (entry) =>
                  Effect.gen(function*() {
                    remotePutCount += 1
                    if (remoteMode === "fail") {
                      return yield* new CacheStore.CacheStoreError({
                        code: "persistence_failed",
                        message: "remote put down"
                      })
                    }
                    return yield* sqlRemote.put(entry)
                  }),
                evict: sqlRemote.evict,
                sweepExpired: sqlRemote.sweepExpired
              }

              const combined = CombinedCacheStore.make({
                local: wrappedLocal,
                remote: wrappedRemote,
                publication
              })

              const getOpts: CacheStore.GetOptions = localState === "expired-exact" || siblingRace === "exact-expired"
                ? { ...(maxAgeMs > 0 ? { maxAgeMs } : {}), recordedBy: { runId: "run-exact", eventSeq: 7 } }
                : maxAgeMs > 0
                ? { maxAgeMs }
                : {}

              const got = yield* combined.get(key, getOpts)

              if (localState === "expired-exact" && maxAgeMs > 0 && maxAgeMs < 60_000) {
                expect(Option.isNone(got)).toBe(true)
                expect(remoteGetCount).toBe(0)
              }
              if (localState === "fresh") {
                expect(Option.isSome(got)).toBe(true)
                expect(remoteGetCount).toBe(0)
              }
              if (
                remoteMode === "fail" && localState !== "fresh" &&
                (localState === "empty" || localState === "no-import-head" || maxAgeMs > 0)
              ) {
                expect(Option.isNone(got)).toBe(true)
              }

              const putKey = "b".repeat(64)
              if (localConflict) {
                yield* sqlLocal.put(makeEntry(putKey, 10, freshTs, "run-a", 1))
              }
              if (remoteMode === "conflict") {
                yield* sqlRemote.put(makeEntry(putKey, 20, freshTs, "run-r", 1))
              }
              const putOutcome = yield* combined.put(makeEntry(putKey, 11, freshTs, "run-b", 2))
              if (localConflict) {
                expect(putOutcome._tag).toBe("Conflict")
                expect(remotePutCount).toBe(0)
              } else {
                expect(putOutcome._tag).toBe("Inserted")
                expect(remotePutCount).toBe(publication === "deferred" ? 0 : 1)
              }

              const remoteBeforeEvict = yield* sqlRemote.get(key)
              yield* combined.evict(key)
              const remoteAfterEvict = yield* sqlRemote.get(key)
              expect(Option.isSome(remoteAfterEvict)).toBe(Option.isSome(remoteBeforeEvict))
              yield* combined.sweepExpired(oldTs)

              const badKeyExit = yield* Effect.exit(combined.get(""))
              expect(Exit.isFailure(badKeyExit)).toBe(true)
              const badAgeExit = yield* Effect.exit(combined.get(key, { maxAgeMs: -5 }))
              expect(Exit.isFailure(badAgeExit)).toBe(true)
              const throwingCandidate = Object.defineProperty(
                makeEntry(putKey, 1, freshTs, "run-x", 1),
                "keyDigest",
                {
                  enumerable: true,
                  get() {
                    throw new Error("getter-boom")
                  }
                }
              )
              const badPutExit = yield* Effect.exit(combined.put(throwingCandidate))
              expect(Exit.isFailure(badPutExit)).toBe(true)

              const layered = yield* Effect.flatMap(CacheStore.CacheStore, (s) => s.get(putKey)).pipe(
                Effect.provide(
                  CombinedCacheStore.layer({
                    local: Effect.succeed(wrappedLocal),
                    remote: Effect.succeed(wrappedRemote),
                    publication
                  })
                )
              )
              expect(Option.isSome(layered)).toBe(true)
              return true
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  CacheStore.layer.pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))),
                  Logger.layer([])
                )
              )
            ),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
