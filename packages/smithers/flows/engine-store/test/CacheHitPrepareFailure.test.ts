/**
 * Issue #110: a transient host filesystem error during cache-hit prepare was
 * collapsed by `Effect.option` into the same branch as a genuinely stale
 * read set, so a one-off EIO/EACCES journalled a factually wrong
 * `stale_read_set` record and destroyed a valid, expensively-computed shared
 * cache row every other run was legitimately reusing. A host that cannot
 * measure right now is not evidence the inputs changed: the hit is refused
 * for this dispatch only, the row survives, and the dispatch path's own
 * re-prepare surfaces the host failure as an ordinary retryable attempt
 * failure. Eviction is reserved for a measured mismatch, and it re-reads the
 * row's provenance first so a fresh entry recorded by a concurrent run
 * between the get and the evict is not deleted with the poison.
 */
import { describe, expect, it } from "@effect/vitest"
import { RetryPolicy } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { type Ownership } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, jj as jjLayer } from "./CachePolicyFixtures.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "prepare-failure-host", pid: 31, nonce: "prepare-failure-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const dispatch = (runId: string, key: string, execute: () => Effect.Effect<unknown, unknown>) =>
  ActionPersistence.make({ runId, owner, sourceId: `prepare-failure-${runId}`, execute })({
    action: {},
    attempt: 1,
    key,
    tier: "sealed",
    metadata: declared
  })

const journalEntries = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 50 })
    return page.entries
  })

const provenance = (runId: string) =>
  journalEntries(runId).pipe(Effect.map((entries) =>
    entries
      .filter((entry) => entry.eventType === "flows.engine.cache-provenance")
      .map((entry) => entry.payload as { readonly action?: string })
  ))

describe("transient prepare host errors on a cache hit (issue #110)", () => {
  it.effect("keeps the valid row, journals no stale_read_set, and fails the attempt retryably", () =>
    Effect.gen(function*() {
      const key = "prepare-failure/transient"
      const keyDigest = sha256(key)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          let executions = 0
          const body = () =>
            Effect.sync(() => {
              executions++
              return "recorded"
            })
          // First run records the entry under a healthy boundary.
          yield* activate("prepare-transient-first", owner)
          yield* dispatch("prepare-transient-first", key, body).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) }))
          )
          // Second run's host dies measuring the read set: every prepare —
          // the cache-hit gate and the dispatch path's own — fails.
          yield* activate("prepare-transient-second", owner)
          const exit = yield* dispatch("prepare-transient-second", key, body).pipe(
            Effect.provide(StepBoundary.layerTest({ supported: false })),
            Effect.exit
          )
          const entry = yield* cache.get(keyDigest)
          const records = yield* provenance("prepare-transient-second")
          const eventTypes = (yield* journalEntries("prepare-transient-second")).map((entry) => entry.eventType)
          return { executions, exit, entry, records, eventTypes }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      // The attempt fails as the host's own refusal, which the retry ladder
      // owns: a typed failure, not an interrupt, and not a non-retryable tag…
      const error = Exit.isFailure(outcome.exit) ? Cause.squash(outcome.exit.cause) : undefined
      expect(RetryPolicy.errorTag(error)).toBe("@smthrs/engine-store/UnsupportedBoundary")
      expect(
        RetryPolicy.isNonRetryable(RetryPolicy.make({ initialMs: 1, factor: 2, maxMs: 10, maxAttempts: 10 }), error)
      ).toBe(false)
      // …the body never ran under the broken host…
      expect(outcome.executions).toBe(1)
      // …the valid shared row survives for every other run…
      expect(Option.isSome(outcome.entry)).toBe(true)
      // …and no factually wrong stale_read_set record was journalled.
      expect(outcome.records.map((record) => record.action)).not.toContain("stale_read_set")
      // …nor a hard violation: a host that cannot measure broke no declaration (issue #4757).
      expect(outcome.eventTypes).toContain("flows.engine.attempt-finished")
      expect(outcome.eventTypes).not.toContain("flows.engine.hard-violation")
    }))

  it.effect("a transient prepare failure refuses the hit, re-prepares, and runs the body (issue #126)", () =>
    Effect.gen(function*() {
      const key = "prepare-failure/transient-recovery"
      const keyDigest = sha256(key)
      // The transient cell: prepare dies on its FIRST invocation (the
      // cache-hit gate's measurement) and returns a verified snapshot on
      // every later one (the dispatch path's own re-prepare).
      const transientBoundary = () => {
        let prepares = 0
        return Layer.succeed(
          StepBoundary.StepBoundary,
          StepBoundary.make({
            prepare: (descriptor) =>
              ++prepares === 1
                ? Effect.fail(
                  new StepBoundary.UnsupportedBoundary({
                    code: "unsupported_boundary",
                    message: "transient EIO measuring the read set"
                  })
                )
                : Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
            settle: (prepared) =>
              Effect.succeed({
                declaredOutputs: { paths: prepared.descriptor.writeSet },
                diffIdentity: "transient-recovery-diff"
              }),
            replayOutputs: () => Effect.void
          })
        )
      }
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          let executions = 0
          const body = () =>
            Effect.sync(() => {
              executions++
              return "recorded"
            })
          yield* activate("prepare-transient-recovery-first", owner)
          yield* dispatch("prepare-transient-recovery-first", key, body).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) }))
          )
          yield* activate("prepare-transient-recovery-second", owner)
          const result = yield* dispatch("prepare-transient-recovery-second", key, body).pipe(
            Effect.provide(transientBoundary())
          )
          const entry = yield* cache.get(keyDigest)
          const records = yield* provenance("prepare-transient-recovery-second")
          return { result, executions, entry, records }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      // The dispatch succeeds on the re-prepared real execution…
      expect(outcome.result).toBe("recorded")
      // …the cache-hit gate refused (never replayed) and the body ran again…
      expect(outcome.executions).toBe(2)
      // …the valid shared row survives…
      expect(Option.isSome(outcome.entry)).toBe(true)
      // …and no factually wrong stale_read_set record was journalled.
      expect(outcome.records.map((record) => record.action)).not.toContain("stale_read_set")
    }))

  it.effect("a genuinely stale measurement still journals stale_read_set and evicts", () =>
    Effect.gen(function*() {
      const key = "prepare-failure/still-stale"
      const keyDigest = sha256(key)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate("prepare-stale-first", owner)
          yield* dispatch("prepare-stale-first", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) }))
          )
          yield* activate("prepare-stale-second", owner)
          yield* dispatch("prepare-stale-second", key, () => Effect.succeed("fresh")).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: [{ path: "config.json", digest: "D2" }] }))
          )
          const entry = yield* cache.get(keyDigest)
          const records = yield* provenance("prepare-stale-second")
          return { entry, records }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.records.map((record) => record.action)).toContain("stale_read_set")
      // The poisoned row was invalidated (the re-execution recorded nothing
      // new here: its declaration still mismatches the measured set). The
      // strong form: the row is gone, not merely different — the old
      // disjunction also passed if the evict silently failed and the row was
      // replaced (issue #127).
      expect(Option.isNone(outcome.entry)).toBe(true)
    }))

  it.effect("skips the evict when a concurrent run re-recorded the entry between get and evict", () =>
    Effect.gen(function*() {
      const key = "prepare-failure/concurrent-put"
      const keyDigest = sha256(key)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate("prepare-race-first", owner)
          yield* dispatch("prepare-race-first", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) }))
          )
          // A racing dispatch observes the first row, decides it is stale, and
          // — between its `get` and its `evict` — a *foreign process* replaces
          // the entry. The per-key admission permit cannot close that window
          // (issue #119), so the fencing predicate inside the DELETE is what
          // protects the fresh row: the interceptor lands the replacement
          // immediately before the eviction reaches the store.
          yield* activate("prepare-race-second", owner)
          const swapping: typeof cache = {
            put: (entry) => cache.put(entry),
            get: (digest) => cache.get(digest),
            sweepExpired: (olderThanMs) => cache.sweepExpired(olderThanMs),
            evict: (digest, options) =>
              Effect.gen(function*() {
                // The concurrent run's fresh entry lands before the delete.
                yield* cache.evict(digest)
                yield* cache.put({
                  keyDigest: digest,
                  result: "fresh-from-concurrent-run",
                  meta: { tier: "sealed" },
                  createdAtMs: 99,
                  recordedRunId: "concurrent-run",
                  recordedEventSeq: 9
                })
                return yield* cache.evict(digest, options)
              })
          }
          const exit = yield* dispatch("prepare-race-second", key, () => Effect.succeed("fresh")).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: [{ path: "config.json", digest: "D2" }] })),
            Effect.provideService(CacheStore.CacheStore, swapping),
            Effect.exit
          )
          const entry = yield* cache.get(keyDigest)
          return { exit, entry }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      // The racing dispatch ran its own body to completion: the skipped evict
      // neither failed it nor was mistaken for a hit.
      expect(outcome.exit).toEqual(Exit.succeed("fresh"))
      // The concurrent run's fresh entry survives the racing evict.
      expect(Option.isSome(outcome.entry)).toBe(true)
      if (Option.isSome(outcome.entry)) {
        expect(outcome.entry.value.recordedRunId).toBe("concurrent-run")
      }
    }))
})
