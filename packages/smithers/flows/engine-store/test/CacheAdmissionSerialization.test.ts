/**
 * Issue #118: the whole cache-hit block — `cache.get`, the verification
 * `prepare`, `replayOutputs`, and the stale eviction — ran *before*
 * `admission.withPermit`, so two concurrent same-key dispatches verified and
 * materialized the shared row simultaneously, interleaving boundary work the
 * per-key permit exists to serialize. The block now joins the permit-wrapped
 * span: every cache mutation and read-verify-materialize step happens under
 * the per-key admission permit, and a verified hit returns from inside it.
 */
import { describe, expect, it } from "@effect/vitest"
import { type Ownership } from "@smthrs/run-store"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as AttemptAdmission from "../src/internal/AttemptAdmission.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, jj as jjLayer } from "./CachePolicyFixtures.ts"
import { withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "cache-serial-host", pid: 47, nonce: "cache-serial-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

/**
 * A boundary whose every operation is an observable critical section: an
 * occupancy counter is bumped around explicit yield points, so two fibers
 * verifying or materializing the same cache row concurrently are caught as
 * `maxActive > 1`.
 */
const observableBoundary = () => {
  let active = 0
  let maxActive = 0
  const span = <A, E>(body: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.gen(function*() {
      active++
      maxActive = Math.max(maxActive, active)
      yield* Effect.yieldNow
      const result = yield* body
      yield* Effect.yieldNow
      active--
      return result
    })
  const layer = Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.make({
      prepare: (descriptor) => span(Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) })),
      settle: (prepared) =>
        span(Effect.succeed({
          declaredOutputs: { paths: prepared.descriptor.writeSet },
          diffIdentity: "cache-serial-diff"
        })),
      replayOutputs: () => span(Effect.void)
    })
  )
  return { layer, maxActive: () => maxActive }
}

describe("the cache-hit block runs under the per-key admission permit (issue #118)", () => {
  it.effect("serializes concurrent same-key cache verification and materialization", () =>
    Effect.gen(function*() {
      const key = "cache-serial/concurrent-hit"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          // First run records the shared row under a healthy boundary.
          yield* activate("cache-serial-first", owner)
          yield* ActionPersistence.make({
            runId: "cache-serial-first",
            owner,
            sourceId: "cache-serial-first",
            execute: () => Effect.succeed("recorded")
          })({ action: {}, attempt: 1, key, tier: "sealed", metadata: declared }).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) }))
          )
          // Second run dispatches the same key twice, concurrently, through one
          // executor (one shared admission mutex). Both take the cache-hit
          // path; their prepare/replayOutputs spans must never overlap.
          yield* activate("cache-serial-second", owner)
          const boundary = observableBoundary()
          const execute = ActionPersistence.make({
            runId: "cache-serial-second",
            owner,
            sourceId: "cache-serial-second",
            execute: () => Effect.die("must not execute: both dispatches are verified hits")
          })
          const dispatch = execute({ action: {}, attempt: 1, key, tier: "sealed", metadata: declared }).pipe(
            Effect.provide(boundary.layer)
          )
          const results = yield* Effect.all([dispatch, dispatch], { concurrency: 2 })
          return { results, maxActive: boundary.maxActive() }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.results).toEqual(["recorded", "recorded"])
      // The permit serializes the whole read-verify-materialize span: at no
      // point were two dispatches inside the boundary at once.
      expect(outcome.maxActive).toBe(1)
    }))

  it.effect("serializes same-key dispatches whose enclosing retry blocks hold different attempt counters (issue #133)", () =>
    Effect.gen(function*() {
      // The cache row is addressed by keyDigest alone, so the permit must be
      // per (runId, keyDigest): folding the attempt counter into the permit key
      // let two sanctioned keyed dispatches at skewed attempts (#111/#116)
      // acquire different permits and interleave the read-verify-materialize
      // span the permit exists to serialize.
      const key = "cache-serial/attempt-skew"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("cache-serial-skew-first", owner)
          yield* ActionPersistence.make({
            runId: "cache-serial-skew-first",
            owner,
            sourceId: "cache-serial-skew-first",
            execute: () => Effect.succeed("recorded")
          })({ action: {}, attempt: 1, key, tier: "sealed", metadata: declared }).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) }))
          )
          yield* activate("cache-serial-skew-second", owner)
          const boundary = observableBoundary()
          const execute = ActionPersistence.make({
            runId: "cache-serial-skew-second",
            owner,
            sourceId: "cache-serial-skew-second",
            execute: () => Effect.die("must not execute: both dispatches are verified hits")
          })
          const dispatchAt = (attempt: number) =>
            execute({ action: {}, attempt, key, tier: "sealed", metadata: declared }).pipe(
              Effect.provide(boundary.layer)
            )
          const results = yield* Effect.all([dispatchAt(1), dispatchAt(2)], { concurrency: 2 })
          return { results, maxActive: boundary.maxActive() }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.results).toEqual(["recorded", "recorded"])
      expect(outcome.maxActive).toBe(1)
    }))
})

describe("a process executes one cache key once across runs (issue #3898)", () => {
  it.effect("holds a second run's dispatch until the first run records the result, then serves it", () =>
    Effect.gen(function*() {
      const key = "cache-serial/cross-run"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          // One admission mutex, as `EngineStore.make` threads into every dispatch.
          const admission = AttemptAdmission.makeUnsafe()
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let bodies = 0
          const dispatchIn = (runId: string, result: string) =>
            ActionPersistence.make({
              runId,
              owner,
              sourceId: runId,
              admission,
              execute: () =>
                Effect.gen(function*() {
                  bodies++
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                  return result
                })
            })({ action: {}, attempt: 1, key, tier: "sealed", metadata: declared })
          yield* activate("cache-serial-running", owner)
          yield* activate("cache-serial-waiting", owner)
          const running = yield* Effect.forkScoped(dispatchIn("cache-serial-running", "first"))
          yield* Deferred.await(entered)
          const waiting = yield* Effect.forkScoped(dispatchIn("cache-serial-waiting", "second"))
          // Real turns for the store, so a dispatch nothing holds reaches its body.
          for (let turn = 0; turn < 50; turn++) {
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)))
          }
          const concurrent = bodies
          yield* Deferred.succeed(release, undefined)
          const results = [yield* Fiber.join(running), yield* Fiber.join(waiting)]
          return { concurrent, results, bodies }
        }).pipe(
          Effect.provide(Layer.mergeAll(
            TestStores.layer(),
            jjLayer,
            StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) })
          )),
          Effect.scoped
        )
      )
      expect(outcome.concurrent).toBe(1)
      // The second run was answered by the first run's row.
      expect(outcome.results).toEqual(["first", "first"])
      expect(outcome.bodies).toBe(1)
    }))
})
