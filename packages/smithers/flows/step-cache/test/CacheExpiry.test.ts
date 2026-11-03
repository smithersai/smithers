/**
 * Age-bounded reads and expiry sweeps over the real SQLite step cache.
 *
 * A cached step result is a claim about work that was correct when it was
 * recorded. A caller that declares a time-to-live says the claim decays, so
 * the store must be able to refuse a row that is older than the bound and to
 * remove the rows nothing will read again.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { CacheStore } from "../src/CacheStore.vibe"
import * as CacheStoreLive from "../src/CacheStore.vibe"
import * as CombinedCacheStore from "../src/CombinedCacheStore.vibe"
import * as Migrations from "../src/Migrations.vibe"

const layers = Layer.mergeAll(
  CacheStoreLive.layer,
  Layer.empty
).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

const withStore = <A, E>(
  effect: Effect.Effect<A, E, CacheStore | SqlClient.SqlClient>
) => effect.pipe(Effect.provide(layers), Effect.provide(TestClock.layer()))

const entry = (keyDigest: string, createdAtMs: number): CacheStoreLive.CacheEntry => ({
  keyDigest,
  result: { output: keyDigest },
  meta: { source: "recorded" },
  createdAtMs,
  recordedRunId: "run-1",
  recordedEventSeq: 3
})

describe("age-bounded reads", () => {
  it.effect("serves an entry inside the bound and refuses one outside it", () =>
    withStore(Effect.gen(function*() {
      const cache = yield* CacheStore
      yield* cache.put(entry("fresh", 0))
      yield* TestClock.adjust("1 second")
      const atBound = yield* cache.get("fresh", { maxAgeMs: 1000 })
      yield* TestClock.adjust("1 millis")
      const pastBound = yield* cache.get("fresh", { maxAgeMs: 1000 })
      const unbounded = yield* cache.get("fresh")
      expect(Option.isSome(atBound)).toBe(true)
      expect(Option.isNone(pastBound)).toBe(true)
      // The bound is a read policy, not a deletion: the row is still there.
      expect(Option.isSome(unbounded)).toBe(true)
    })))

  it.effect("bounds the recorded-provenance read as well as the head", () =>
    withStore(Effect.gen(function*() {
      const cache = yield* CacheStore
      yield* cache.put(entry("recorded", 0))
      yield* TestClock.adjust("2 seconds")
      const recordedBy = { runId: "run-1", eventSeq: 3 }
      const bounded = yield* cache.get("recorded", { recordedBy, maxAgeMs: 1000 })
      const unbounded = yield* cache.get("recorded", { recordedBy })
      expect(Option.isNone(bounded)).toBe(true)
      expect(Option.isSome(unbounded)).toBe(true)
    })))

  it.effect("refuses an out-of-age recorded row instead of serving the fresher head", () =>
    withStore(Effect.gen(function*() {
      const cache = yield* CacheStore
      // The ledger holds the row a replay of `run-1` seq 3 must read, and the
      // head holds a newer row a later run recorded under its own provenance.
      yield* cache.put(entry("provenance", 0))
      yield* cache.evict("provenance")
      yield* TestClock.adjust("5 seconds")
      yield* cache.put({ ...entry("provenance", 5000), recordedRunId: "run-2", recordedEventSeq: 9 })
      yield* TestClock.adjust("1 millis")
      const bounded = yield* cache.get("provenance", {
        recordedBy: { runId: "run-1", eventSeq: 3 },
        maxAgeMs: 1000
      })
      // The exact row exists and is too old, so the answer is a miss. Serving
      // the head here would hand a replay of that event a result another run
      // recorded.
      expect(Option.isNone(bounded)).toBe(true)
      // A provenance the ledger holds nothing for still falls back to the head.
      const fallback = yield* cache.get("provenance", {
        recordedBy: { runId: "run-3", eventSeq: 1 },
        maxAgeMs: 1000
      })
      expect(Option.isSome(fallback)).toBe(true)
    })))

  it.effect("refuses a bound no row could satisfy", () =>
    withStore(Effect.gen(function*() {
      const cache = yield* CacheStore
      const exit = yield* Effect.exit(cache.get("fresh", { maxAgeMs: -1 }))
      expect(Exit.isFailure(exit)).toBe(true)
      const reason = Exit.isFailure(exit) ? exit.cause.reasons[0]! : undefined
      expect(reason?._tag === "Fail" ? reason.error.code : undefined).toBe("invalid_cache")
    })))
})

describe("expiry sweeps", () => {
  it.effect("removes only the head rows older than the bound", () =>
    withStore(Effect.gen(function*() {
      const cache = yield* CacheStore
      yield* cache.put(entry("old", 0))
      yield* TestClock.adjust("5 seconds")
      yield* cache.put(entry("new", 5000))
      yield* TestClock.adjust("1 second")
      const swept = yield* cache.sweepExpired(2000)
      expect(swept).toBe(1)
      expect(Option.isNone(yield* cache.get("old"))).toBe(true)
      expect(Option.isSome(yield* cache.get("new"))).toBe(true)
    })))

  it.effect("leaves the append-only recorded ledger intact", () =>
    withStore(Effect.gen(function*() {
      const cache = yield* CacheStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* cache.put(entry("ledger", 0))
      yield* TestClock.adjust("10 seconds")
      yield* cache.sweepExpired(1000)
      const rows = yield* sql<{ readonly key_digest: string }>`
        SELECT key_digest FROM flows_step_cache_recorded WHERE key_digest = 'ledger'
      `.pipe(Effect.orDie)
      expect(rows.length).toBe(1)
      const recorded = yield* cache.get("ledger", { recordedBy: { runId: "run-1", eventSeq: 3 } })
      expect(Option.isSome(recorded)).toBe(true)
    })))

  it.effect("keeps a head row recorded exactly at the floor", () =>
    withStore(Effect.gen(function*() {
      // The sweep deletes strictly below the floor, mirroring the at-bound
      // serve on the read side: one row is expired for a reader exactly when
      // the sweep would remove it, never a millisecond earlier.
      const cache = yield* CacheStore
      yield* cache.put(entry("at-floor", 1000))
      yield* cache.put(entry("below-floor", 999))
      yield* TestClock.adjust("3 seconds")
      expect(yield* cache.sweepExpired(2000)).toBe(1)
      expect(Option.isSome(yield* cache.get("at-floor"))).toBe(true)
      expect(Option.isNone(yield* cache.get("below-floor"))).toBe(true)
    })))

  it.effect("preserves foreign provenance when no retention policy is supplied", () =>
    withStore(Effect.gen(function*() {
      // Foreign provenance can be referenced by a local journal. Age alone
      // cannot authorize deleting it; retention requires the host's policy.
      const cache = yield* CacheStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const foreign = { ...entry("write-back", 0), recordedRunId: "run-on-another-host" }
      const combined = CombinedCacheStore.make({
        local: cache,
        remote: {
          get: () => Effect.succeed(Option.some(foreign)),
          put: () => Effect.succeed({ _tag: "ExistingSame" }),
          evict: () => Effect.succeed(false),
          sweepExpired: () => Effect.succeed(0)
        }
      })
      expect(Option.isSome(yield* combined.get("write-back"))).toBe(true)

      yield* TestClock.adjust("10 seconds")
      expect(yield* cache.evict("write-back")).toBe(true)
      expect(yield* cache.sweepExpired(0)).toBe(0)
      const ledger = yield* sql<{ readonly recorded_run_id: string }>`
        SELECT recorded_run_id FROM flows_step_cache_recorded WHERE key_digest = 'write-back'
      `.pipe(Effect.orDie)
      expect(ledger.map((row) => row.recorded_run_id)).toEqual(["run-on-another-host"])
    })))

  it.effect("checks exact provenance and the age floor across retention pages", () =>
    withStore(Effect.gen(function*() {
      const cache = yield* CacheStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      for (let index = 0; index < 102; index++) {
        yield* cache.put({ ...entry("versions", 0), recordedEventSeq: index })
      }
      yield* cache.put(entry("at-floor", 1000))
      yield* cache.put(entry("fresh", 2000))
      yield* TestClock.adjust("2 seconds")
      const checked: Array<number> = []
      expect(
        yield* cache.sweepExpired(1000, {
          canReclaimRecorded: (record) =>
            Effect.sync(() => {
              expect(record.keyDigest).toBe("versions")
              expect(record.recordedRunId).toBe("run-1")
              checked.push(record.recordedEventSeq)
              return record.recordedEventSeq === 101
            })
        })
      ).toBe(1)
      expect(checked).toEqual(Array.from({ length: 102 }, (_, index) => index))
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM flows_step_cache_recorded
      `
      expect(remaining[0]!.count).toBe(103)
      expect(yield* cache.get("versions", { recordedBy: { runId: "run-1", eventSeq: 101 } }))
        .toEqual(Option.none())
      expect(Option.isSome(yield* cache.get("versions", { recordedBy: { runId: "run-1", eventSeq: 100 } })))
        .toBe(true)
      expect(Option.isSome(yield* cache.get("at-floor"))).toBe(true)
      expect(Option.isSome(yield* cache.get("fresh"))).toBe(true)
    })))

  it.effect("rolls back collection if the reference policy fails", () =>
    withStore(Effect.gen(function*() {
      const cache = yield* CacheStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* cache.put(entry("a", 0))
      yield* cache.put(entry("b", 0))
      yield* TestClock.adjust("1 second")
      const refused = new CacheStoreLive.CacheStoreError({ code: "unknown", message: "references unavailable" })
      expect(
        yield* Effect.flip(cache.sweepExpired(0, {
          canReclaimRecorded: (record) => record.keyDigest === "a" ? Effect.succeed(true) : Effect.fail(refused)
        }))
      ).toEqual(refused)
      expect(Option.isSome(yield* cache.get("a"))).toBe(true)
      expect(Option.isSome(yield* cache.get("b"))).toBe(true)
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM flows_step_cache_recorded
      `
      expect(remaining[0]!.count).toBe(2)
    })))

  it.effect("refuses a negative sweep bound", () =>
    withStore(Effect.gen(function*() {
      const cache = yield* CacheStore
      const exit = yield* Effect.exit(cache.sweepExpired(-1))
      const reason = Exit.isFailure(exit) ? exit.cause.reasons[0]! : undefined
      expect(reason?._tag === "Fail" ? reason.error.code : undefined).toBe("invalid_cache")
    })))
})
