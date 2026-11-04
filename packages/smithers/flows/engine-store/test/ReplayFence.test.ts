/**
 * Which dispatches heartbeat the run's fence. A dispatch a recorded attempt
 * answers alone runs nothing and writes nothing the fence guards, so it costs
 * no heartbeat: a resumed run used to pay one write transaction per replayed
 * step for it. Every dispatch that runs a body or writes more still heartbeats
 * first, and a run that lost its fence is stopped at its first such step. Runs
 * on the test database the matrix selects: SQLite, or PostgreSQL under
 * `SMITHERS_TEST_PG_URL`.
 */
import { describe, expect, it } from "@effect/vitest"
import type { Crypto } from "@smthrs/crypto"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import type { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as Clocks from "./Clocks.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const ownerA: Ownership.OwnerId = { hostId: "replay-fence-a", pid: 1, nonce: "replay-fence-a" }
const ownerB: Ownership.OwnerId = { hostId: "replay-fence-b", pid: 2, nonce: "replay-fence-b" }

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "replay-fence" as never, changeId: "replay-fence" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

type Services =
  | AttemptStore.AttemptStore
  | CacheStore.CacheStore
  | Journal.Journal
  | RunStore.RunStore
  | StepBoundary.Service
  | Jj.Jj
  | Scope.Scope
  | Crypto.Crypto

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(
    effect.pipe(
      Effect.provide(Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jj)),
      Effect.provide(TestClock.layer()),
      Effect.scoped
    )
  )

/** Claims and activates `runId` for `claimant`, stealing it from a live owner when there is one. */
const takeover = (runId: string, claimant: Ownership.OwnerId) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const stealing = row.status === "running" && row.owner !== null
    const now = (yield* Clock.currentTimeMillis) +
      (stealing ? Duration.toMillis(Ownership.heartbeatStaleAfter) + 1 : 0)
    const evidence: Ownership.LivenessEvidence | undefined = stealing
      ? { expectedOwner: row.owner!, checkedAtMs: now, kind: "cross-host-unreachable-stale" }
      : undefined
    const outcome = yield* Clocks.at(now, runs.claimAndOwn(runId, snapshot, claimant, now, evidence))
    if (outcome._tag !== "Activated") return yield* Effect.die(new Error(`takeover lost: ${outcome._tag}`))
  })

const activate = (runId: string) =>
  Effect.andThen(Effect.flatMap(RunStore.RunStore, (runs) => runs.create(runId, "{}")), takeover(runId, ownerA))

/** Counts the run-store heartbeats `effect` makes: each is one dispatch's fence. */
const countingHeartbeats = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const count = { heartbeats: 0 }
    const counted: RunStore.Service = {
      ...runs,
      heartbeat: (...args) => Effect.suspend(() => (count.heartbeats++, runs.heartbeat(...args)))
    }
    const exit = yield* Effect.exit(Effect.provideService(effect, RunStore.RunStore, counted))
    return { exit, heartbeats: count.heartbeats }
  })

/** One executor of `runId` under `owner`; `bodies` counts the bodies it ran. */
const executor = (
  runId: string,
  owner: Ownership.OwnerId,
  body: Effect.Effect<unknown, unknown> = Effect.succeed("v")
) => {
  const counts = { bodies: 0 }
  const execute = ActionPersistence.make({
    runId,
    owner,
    sourceId: `replay-fence-${owner.nonce}`,
    execute: () => Effect.suspend(() => (counts.bodies++, body))
  })
  return {
    counts,
    dispatch: (key: string, metadata?: ActionPersistence.BoundaryMetadata) =>
      execute({ action: {}, attempt: 1, key, tier: "sealed", ...(metadata === undefined ? {} : { metadata }) })
  }
}

/** Whether `exit` is a self-interruption: the dispatch's owner lost the run. */
const interrupted = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)

/** The error `exit` failed with, if it failed with one. */
const failure = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

/** Runs `effect` on a child fiber, so a self-interruption is an exit rather than the test's own. */
const awaitExit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.forkChild(effect, { startImmediately: true }), Fiber.await)

describe("a dispatch a recorded attempt answers alone", () => {
  it.effect("replays a success without a heartbeat, and a fresh step heartbeats once", () =>
    run(Effect.gen(function*() {
      yield* activate("fence-success")
      const fresh = yield* countingHeartbeats(executor("fence-success", ownerA).dispatch("step"))
      expect(fresh).toEqual({ exit: Exit.succeed("v"), heartbeats: 1 })
      const resumed = executor("fence-success", ownerA)
      const replayed = yield* countingHeartbeats(resumed.dispatch("step"))
      expect(replayed).toEqual({ exit: Exit.succeed("v"), heartbeats: 0 })
      expect(resumed.counts.bodies).toBe(0)
    })))

  it.effect("replays a failure without a heartbeat", () =>
    run(Effect.gen(function*() {
      yield* activate("fence-failure")
      const failing = executor("fence-failure", ownerA, Effect.fail("boom"))
      const fresh = yield* countingHeartbeats(failing.dispatch("step"))
      expect(fresh.heartbeats).toBe(1)
      const resumed = executor("fence-failure", ownerA)
      const replayed = yield* countingHeartbeats(resumed.dispatch("step"))
      expect(failure(replayed.exit)).toBe("boom")
      expect(replayed.heartbeats).toBe(0)
      expect(resumed.counts.bodies).toBe(0)
    })))

  it.effect("re-parks a suspension without a heartbeat", () =>
    run(Effect.gen(function*() {
      yield* activate("fence-suspended")
      const attempts = yield* AttemptStore.AttemptStore
      yield* attempts.put({
        runId: "fence-suspended",
        stepKeyDigest: sha256("step"),
        attempt: 1,
        state: "suspended",
        startedAtMs: 0,
        meta: { tier: "sealed" }
      }, ownerA)
      const resumed = executor("fence-suspended", ownerA)
      const replayed = yield* countingHeartbeats(resumed.dispatch("step"))
      expect(replayed.heartbeats).toBe(0)
      expect(failure(replayed.exit)).toMatchObject({ code: "attempt_suspended" })
      expect(resumed.counts.bodies).toBe(0)
    })))
})

describe("a dispatch that does more than replay", () => {
  it.effect("heartbeats before it puts a recorded success's outputs back", () =>
    run(Effect.gen(function*() {
      yield* activate("fence-outputs")
      const expected: ActionPersistence.BoundaryMetadata = { readSet: [], writeSet: ["out"], boundaryMode: "expected" }
      yield* executor("fence-outputs", ownerA).dispatch("step", expected)
      const resumed = executor("fence-outputs", ownerA)
      const replayed = yield* countingHeartbeats(resumed.dispatch("step", expected))
      expect(replayed).toEqual({ exit: Exit.succeed("v"), heartbeats: 1 })
      expect(resumed.counts.bodies).toBe(0)
    })))

  it.effect("heartbeats before it adopts an attempt left running", () =>
    run(Effect.gen(function*() {
      yield* activate("fence-running")
      const attempts = yield* AttemptStore.AttemptStore
      yield* attempts.put({
        runId: "fence-running",
        stepKeyDigest: sha256("step"),
        attempt: 1,
        state: "running",
        startedAtMs: 0,
        meta: { tier: "sealed" }
      }, ownerA)
      const resumed = executor("fence-running", ownerA)
      const adopted = yield* countingHeartbeats(resumed.dispatch("step"))
      expect(adopted.exit).toEqual(Exit.succeed("v"))
      expect(adopted.heartbeats).toBeGreaterThan(0)
      expect(resumed.counts.bodies).toBe(1)
    })))
})

describe("a run that lost its fence", () => {
  it.effect("replays what it recorded, and is stopped at its first step that runs, without running it", () =>
    run(Effect.gen(function*() {
      yield* activate("fence-lost")
      yield* executor("fence-lost", ownerA).dispatch("recorded")
      yield* takeover("fence-lost", ownerB)
      const journal = yield* Journal.Journal
      const before = (yield* journal.entries({ runId: "fence-lost" as never, limit: 100 })).entries.length
      const zombie = executor("fence-lost", ownerA)
      expect(yield* awaitExit(zombie.dispatch("recorded"))).toEqual(Exit.succeed("v"))
      const stopped = yield* awaitExit(zombie.dispatch("fresh"))
      expect(interrupted(stopped)).toBe(true)
      expect(zombie.counts.bodies).toBe(0)
      expect((yield* journal.entries({ runId: "fence-lost" as never, limit: 100 })).entries).toHaveLength(before)
    })))

  it.effect("cannot write a convergence record its journal lacks", () =>
    run(Effect.gen(function*() {
      yield* activate("fence-lost-record")
      const attempts = yield* AttemptStore.AttemptStore
      // A success whose records a crash lost: the replay must write attemptFinished.
      yield* attempts.put({
        runId: "fence-lost-record",
        stepKeyDigest: sha256("step"),
        attempt: 1,
        state: "running",
        startedAtMs: 0,
        meta: { tier: "sealed" }
      }, ownerA)
      yield* attempts.finish({
        runId: "fence-lost-record",
        stepKeyDigest: sha256("step"),
        attempt: 1,
        state: "succeeded",
        finishedAtMs: 1,
        outcome: "v"
      }, ownerA)
      yield* takeover("fence-lost-record", ownerB)
      const zombie = executor("fence-lost-record", ownerA)
      expect(interrupted(yield* awaitExit(zombie.dispatch("step")))).toBe(true)
      const journal = yield* Journal.Journal
      const finished = (yield* journal.entries({ runId: "fence-lost-record" as never, limit: 100 })).entries
        .filter((entry) => entry.eventType === "flows.engine.attempt-finished")
      expect(finished).toEqual([])
    })))
})
