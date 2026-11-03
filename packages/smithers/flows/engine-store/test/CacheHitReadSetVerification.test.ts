/**
 * Pins issue #90: a sealed hard-boundary cache hit was decided entirely from
 * the caller-declared read-set digests folded into the step key. Nothing
 * measured the filesystem, `StepBoundary.prepare`'s `readSnapshot` had no
 * production reader, and `prepare` first ran strictly after the hit's early
 * return — so a declaration whose digests had gone stale relative to the real
 * files replayed a pre-edit result forever, with no detection path.
 *
 * The boundary is now measured before a hit is served: the recorded result is
 * reused only when every declared read-set entry still matches what the host
 * reports, which is Skyframe's dirty-check invariant (re-verify a node
 * against its dependencies' current values before reuse).
 */
import { describe, expect, it } from "@effect/vitest"
import type { FileInput } from "@smthrs/flow/FileInput"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as EngineStoreMetrics from "../src/EngineStoreMetrics.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise, sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "read-set-host", pid: 21, nonce: "read-set-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "read-set-snapshot" as never, changeId: "read-set-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const dispatch = (runId: string, key: string, execute: () => Effect.Effect<unknown, unknown>) =>
  ActionPersistence.make({ runId, owner, sourceId: `read-set-${runId}`, execute })({
    action: {},
    attempt: 1,
    key,
    tier: "sealed",
    metadata: declared
  })

/**
 * Runs the same sealed key twice: the first run records the cache entry, the
 * second sees whatever `measured` reports for the declared read set.
 */
const replayWithMeasurement = (
  label: string,
  measured: ReadonlyArray<FileInput>
) =>
  Effect.gen(function*() {
    const key = `read-set/${label}`
    let executions = 0
    let replays = 0
    const run = (runId: string, boundary: Layer.Layer<StepBoundary.Service>) =>
      Effect.gen(function*() {
        yield* activate(runId)
        return yield* dispatch(runId, key, () =>
          Effect.sync(() => {
            executions++
            return "recorded"
          }))
      }).pipe(Effect.provide(boundary))

    // One journal/cache/run store shared by both runs, so the second run sees
    // the first run's recorded entry — the cross-run reuse path.
    const first = yield* run(
      `${label}-first`,
      StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) })
    )
    const second = yield* run(
      `${label}-second`,
      StepBoundary.layerTest({
        readSnapshot: measured,
        onReplay: () => {
          replays++
        }
      })
    )
    return { executions, first, replays, second }
  }).pipe(
    Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
    Effect.scoped
  )

describe("sealed cache hits verify the measured read set (issue #90)", () => {
  it.effect("serves the recorded result when every declared read still matches the host", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        replayWithMeasurement("unchanged", [{ path: "config.json", digest: "D1" }])
      )
      expect(result.second).toBe("recorded")
      expect(result.executions).toBe(1)
      expect(result.replays).toBe(1)
    }))

  it.effect("ignores measured reads the declaration never claimed", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        replayWithMeasurement("extra-reads", [
          { path: "config.json", digest: "D1" },
          { path: "incidental.txt", digest: "X" }
        ])
      )
      expect(result.executions).toBe(1)
      expect(result.replays).toBe(1)
    }))

  it.effect("re-executes when a declared read's digest has gone stale", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        replayWithMeasurement("stale-digest", [{ path: "config.json", digest: "D2" }])
      )
      expect(result.second).toBe("recorded")
      // The stale hit is refused: the action runs a second time instead of
      // replaying the pre-edit result and its boundary outputs.
      expect(result.executions).toBe(2)
      expect(result.replays).toBe(0)
    }))

  it.effect("re-executes when a declared read is missing from the measured set", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(replayWithMeasurement("vanished-read", []))
      expect(result.executions).toBe(2)
      expect(result.replays).toBe(0)
    }))
})

describe("a refused stale hit invalidates the poisoned entry (issue #99)", () => {
  it.effect("records the differing re-executed result cleanly instead of permanently failing", () =>
    Effect.gen(function*() {
      // A stale read set means the inputs changed, so a *different* result is
      // the expected case. Without eviction the fresh result conflicted with
      // the poisoned row under the same key digest, the strict verdict failed
      // the run with cache_conflict_detected, and — the row never being
      // removed — every later run repeated the same refuse → re-execute →
      // conflict → fail cycle forever.
      const key = "read-set/stale-differing-result"
      const keyDigest = sha256(key)
      const results = ["recorded", "fresh-1", "fresh-2"]
      let executions = 0
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          const run = (runId: string, measured: ReadonlyArray<FileInput>) =>
            Effect.gen(function*() {
              yield* activate(runId)
              return yield* dispatch(runId, key, () => Effect.sync(() => results[executions++]))
            }).pipe(Effect.provide(StepBoundary.layerTest({ readSnapshot: measured })))
          const first = yield* run("stale-conflict-first", StepBoundary.exactReads(declared))
          // The declared digest went stale: the hit is refused and the entry
          // is invalidated, so the re-execution proceeds cleanly.
          const second = yield* run("stale-conflict-second", [{ path: "config.json", digest: "D2" }])
          // A permanently poisoned row made this third run fail forever; a
          // clean invalidation lets it re-execute instead.
          const third = yield* run("stale-conflict-third", [{ path: "config.json", digest: "D2" }])
          const entry = yield* cache.get(keyDigest)
          return { first, second, third, entry }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.first).toBe("recorded")
      expect(outcome.second).toBe("fresh-1")
      expect(outcome.third).toBe("fresh-2")
      expect(executions).toBe(3)
      // The stale-declaration executions were computed against content the
      // key does not describe, so nothing may be re-recorded under it
      // (issue #106) — the poisoned row is gone and stays gone.
      expect(Option.isNone(outcome.entry)).toBe(true)
    }))
})

describe("the effective cache decision is metered exactly once per consult", () => {
  const decisionCounts = Effect.gen(function*() {
    const read = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
      Effect.map(Metric.value(metric), (state) => state.count)
    return {
      miss: yield* read(EngineStoreMetrics.stepCacheDecision.Miss),
      verifiedHit: yield* read(EngineStoreMetrics.stepCacheDecision.VerifiedHit),
      staleReadSet: yield* read(EngineStoreMetrics.stepCacheDecision.StaleReadSet),
      replayFailed: yield* read(EngineStoreMetrics.stepCacheDecision.ReplayFailed)
    }
  })

  it("counts the recording consult as a miss and the verified replay as a verified hit", async () => {
    const observed = await runPromise(
      Effect.gen(function*() {
        const result = yield* replayWithMeasurement("metered-hit", [{ path: "config.json", digest: "D1" }])
        return { result, counts: yield* decisionCounts }
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))
    )
    expect(observed.result.executions).toBe(1)
    expect(observed.result.replays).toBe(1)
    // Two dispatches consulted the cache, so exactly two decisions land:
    // the recording run's miss and the second run's verified hit.
    expect(observed.counts).toEqual({ miss: 1, verifiedHit: 1, staleReadSet: 0, replayFailed: 0 })
  })

  it("counts a measured mismatch as a stale-read-set fall-through, not a hit or a raw-row hit", async () => {
    const observed = await runPromise(
      Effect.gen(function*() {
        const result = yield* replayWithMeasurement("metered-stale", [{ path: "config.json", digest: "D2" }])
        return { result, counts: yield* decisionCounts }
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))
    )
    expect(observed.result.executions).toBe(2)
    // The row was present — `flows_step_cache_lookups` would call it a hit —
    // but the effective decision refused it after measurement.
    expect(observed.counts).toEqual({ miss: 1, verifiedHit: 0, staleReadSet: 1, replayFailed: 0 })
  })

  it("records no decision when the hit's provenance emit fails before the result is served", async () => {
    // `verified_hit` means the cached result was actually returned. A journal
    // failure on the reuse-provenance emit fails the dispatch first, so the
    // consult must land NO decision — the failed dispatch's exit is what
    // `flows_engine_dispatches` records.
    const key = "read-set/metered-emit-failure"
    const boundary = StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) })
    const observed = await runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        let executions = 0
        const body = () =>
          Effect.sync(() => {
            executions++
            return "recorded"
          })
        yield* activate("metered-emit-first")
        yield* dispatch("metered-emit-first", key, body).pipe(Effect.provide(boundary))
        const failing: Journal.Service = {
          ...journal,
          emitDurable: (record, emitOwner) =>
            record.eventType === "flows.engine.cache-provenance"
              ? Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "journal sink down" }))
              : journal.emitDurable(record, emitOwner)
        }
        yield* activate("metered-emit-second")
        const failed = yield* dispatch("metered-emit-second", key, body).pipe(
          Effect.provide(boundary),
          Effect.provideService(Journal.Journal, failing),
          Effect.flip
        )
        return { executions, failed, counts: yield* decisionCounts }
      }).pipe(
        Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
        Effect.scoped,
        Effect.provideService(Metric.MetricRegistry, new Map())
      )
    )
    expect(observed.executions).toBe(1)
    expect(observed.failed).toMatchObject({ code: "sink_failed" })
    expect(observed.counts).toEqual({ miss: 1, verifiedHit: 0, staleReadSet: 0, replayFailed: 0 })
  })
})

describe("cache provenance records a refused hit (issue #90)", () => {
  it.effect("emits a stale-read-set provenance record instead of a reuse record", () =>
    Effect.gen(function*() {
      const key = "read-set/provenance"
      const keyDigest = sha256(key)
      const records = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* cache.put({
            keyDigest,
            result: "recorded",
            meta: {
              tier: "sealed",
              boundary: {
                declaredOutputs: { paths: ["output.txt"] },
                diffIdentity: "seeded-diff",
                wholeTreeWritesVerified: true,
                hermeticReadsVerified: true
              }
            },
            createdAtMs: 1,
            recordedRunId: "recorded-run",
            recordedEventSeq: 0
          })
          yield* activate("provenance-run")
          yield* dispatch("provenance-run", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: [{ path: "config.json", digest: "D2" }] }))
          )
          const journal = yield* Journal.Journal
          yield* journal.flush
          const page = yield* journal.entries({ runId: "provenance-run" as never, limit: 50 })
          return page.entries
            .filter((entry) => entry.eventType === "flows.engine.cache-provenance")
            .map((entry) => entry.payload as { readonly action?: string })
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )

      expect(records.map((record) => record.action)).toContain("stale_read_set")
    }))
})
