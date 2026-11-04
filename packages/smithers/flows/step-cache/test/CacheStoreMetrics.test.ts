/**
 * The cache counters: lookups and recordings land in the registry the caller
 * provided, keyed by the outcome the store actually resolved.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import type * as SqlClient from "effect/sql/SqlClient"
import { CacheStore } from "../src/CacheStore.vibe"
import * as CacheStoreLive from "../src/CacheStore.vibe"
import * as CacheStoreMetrics from "../src/CacheStoreMetrics.vibe"
import * as CombinedCacheStore from "../src/CombinedCacheStore.vibe"
import * as Migrations from "../src/Migrations.vibe"

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | CacheStore>
) =>
  effect.pipe(
    Effect.provide(CacheStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer),
    Effect.provideService(Metric.MetricRegistry, new Map())
  )

const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Effect.map(Metric.value(metric), (state) => state.count)

const entry = {
  keyDigest: "digest-metrics",
  result: { output: "ok" },
  meta: { source: "recorded" },
  createdAtMs: 10,
  recordedRunId: "run-1",
  recordedEventSeq: 7
} as const

describe("CacheStoreMetrics", () => {
  it.effect("counts misses, hits, and every put outcome through the provided registry", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        const store = yield* CacheStore

        expect(yield* store.get(entry.keyDigest)).toMatchObject({ _tag: "None" })
        expect(yield* store.put(entry)).toEqual({ _tag: "Inserted" })
        expect(yield* store.get(entry.keyDigest)).toMatchObject({ _tag: "Some" })
        expect(yield* store.put(entry)).toEqual({ _tag: "ExistingSame" })
        expect(yield* store.put({ ...entry, result: { output: "different" } })).toEqual({ _tag: "Conflict" })

        expect(yield* count(CacheStoreMetrics.miss)).toBe(1)
        expect(yield* count(CacheStoreMetrics.hit)).toBe(1)
        expect(yield* count(CacheStoreMetrics.put.Inserted)).toBe(1)
        expect(yield* count(CacheStoreMetrics.put.ExistingSame)).toBe(1)
        expect(yield* count(CacheStoreMetrics.put.Conflict)).toBe(1)
        // The unattributed handles aggregate nothing on their own; every update
        // carried an outcome attribute.
        expect(yield* count(CacheStoreMetrics.lookups)).toBe(0)
        expect(yield* count(CacheStoreMetrics.puts)).toBe(0)
      }))
    }))

  it.effect("registers a remote-served lookup as a local miss plus its write-back", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        const local = yield* CacheStore
        // The shared tier holds the entry and updates no counters of its own,
        // which is what makes a two-tier hit rate read low: the numbers below
        // are the contract an operator's dashboard is built on.
        const remote: CacheStoreLive.Service = {
          get: () => Effect.succeed(Option.some(entry)),
          put: () => Effect.succeed({ _tag: "ExistingSame" }),
          evict: () => Effect.succeed(false),
          sweepExpired: () => Effect.succeed(0)
        }
        const combined = CombinedCacheStore.make({ local, remote })

        expect(Option.isSome(yield* combined.get(entry.keyDigest))).toBe(true)

        expect(yield* count(CacheStoreMetrics.miss)).toBe(1)
        expect(yield* count(CacheStoreMetrics.hit)).toBe(0)
        expect(yield* count(CacheStoreMetrics.put.Inserted)).toBe(1)
        // The write-back made it local, so the next lookup is the hit the
        // first one was not.
        expect(Option.isSome(yield* combined.get(entry.keyDigest))).toBe(true)
        expect(yield* count(CacheStoreMetrics.hit)).toBe(1)
      }))
    }))
})
