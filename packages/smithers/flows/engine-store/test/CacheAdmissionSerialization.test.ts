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
import { Jj } from "@smthrs/kernel"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "cache-serial-host", pid: 47, nonce: "cache-serial-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () =>
      Effect.succeed({ commitId: "cache-serial-snapshot" as never, changeId: "cache-serial-snapshot" as never }),
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
          yield* activate("cache-serial-first")
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
          yield* activate("cache-serial-second")
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
          yield* activate("cache-serial-skew-first")
          yield* ActionPersistence.make({
            runId: "cache-serial-skew-first",
            owner,
            sourceId: "cache-serial-skew-first",
            execute: () => Effect.succeed("recorded")
          })({ action: {}, attempt: 1, key, tier: "sealed", metadata: declared }).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) }))
          )
          yield* activate("cache-serial-skew-second")
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
