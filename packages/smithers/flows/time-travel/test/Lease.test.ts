import { describe, expect, it } from "@effect/vitest"
import { RunStore } from "@smthrs/run-store"
import * as Ownership from "@smthrs/run-store/Ownership"
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"
import * as Lease from "../src/internal/Lease.ts"
import { error } from "../src/TimeTravelError.ts"

/**
 * Rewind and recovery both hold a run's lease while they act on it, and both
 * claim and activate rows the same way. These pin the shared contract.
 */

const owner: OwnerId = { hostId: "lease-host", pid: 7, nonce: "lease-owner" }
const snapshot: RunStore.RunSnapshot = { status: "suspended", owner: null, heartbeatAtMs: null }

const withRuns = <A, E>(
  effect: Effect.Effect<A, E, RunStore.RunStore>,
  overrides: Partial<RunStore.Service>
) => Effect.provideService(effect, RunStore.RunStore, RunStore.makeNoop(overrides))

const request = (overrides: Partial<Lease.ClaimRequest> = {}): Lease.ClaimRequest => ({
  runId: "run",
  expected: snapshot,
  claimant: owner,
  nowMs: 5,
  operations: { claim: "claim run", activate: "activate run" },
  refused: (outcome) => error("busy", `refused ${outcome._tag}`),
  lost: error("busy", "activation lost"),
  ...overrides
})

describe("Lease.withHeldLease", () => {
  it.effect("fails the guarded body with fence_lost when the heartbeat loses the fence", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        withRuns(
          Lease.withHeldLease("run", owner, (lease) => lease.guard(Effect.never)),
          { heartbeat: () => Effect.succeed({ _tag: "FenceLost" as const }) }
        ),
        { startImmediately: true }
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      const failure = yield* Effect.flip(Fiber.join(fiber))
      expect(failure).toMatchObject({ code: "fence_lost", message: "run run lost its ownership lease" })
    }))

  it.effect("treats the fence loss as expected once the release is marked", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        withRuns(
          Lease.withHeldLease("run", owner, (lease) =>
            lease.guard(lease.releasing.pipe(Effect.andThen(Deferred.await(gate)), Effect.as("done")))),
          {
            heartbeat: () =>
              Effect.succeed({ _tag: "FenceLost" as const })
          }
        ),
        { startImmediately: true }
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      yield* Deferred.succeed(gate, undefined)
      expect(yield* Fiber.join(fiber)).toBe("done")
    }))

  it.effect("keeps pulsing through work after the guarded body and stops on exit", () =>
    Effect.gen(function*() {
      let pulses = 0
      const cleanup = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        withRuns(
          Lease.withHeldLease("run", owner, (lease) =>
            Effect.exit(lease.guard(Effect.fail("boom"))).pipe(Effect.andThen(Deferred.await(cleanup)))),
          {
            heartbeat: () =>
              Effect.sync(() => {
                pulses += 1
                return { _tag: "Updated" as const }
              })
          }
        ),
        { startImmediately: true }
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      expect(pulses).toBe(1)
      yield* Deferred.succeed(cleanup, undefined)
      yield* Fiber.join(fiber)
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      expect(pulses).toBe(1)
    }))
})

describe("Lease.claimAndActivate", () => {
  it.effect("claims, activates, and returns the claim timestamp", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const runs = RunStore.makeNoop({
        claim: () => Effect.sync(() => (calls.push("claim"), { _tag: "Claimed" as const, claimedAtMs: 5 })),
        activate: (_runId, _claimant, claimedAtMs) =>
          Effect.sync(() => (calls.push(`activate:${claimedAtMs}`), { _tag: "Activated" as const }))
      })
      expect(yield* Lease.claimAndActivate(runs, request())).toBe(5)
      expect(calls).toEqual(["claim", "activate:5"])
    }))

  it.effect("steals instead of claiming when liveness evidence is supplied", () =>
    Effect.gen(function*() {
      const evidence = { reason: "lease-expired" } as unknown as LivenessEvidence
      let stolenWith: LivenessEvidence | undefined
      const runs = RunStore.makeNoop({
        steal: (_runId, _expected, _claimant, _nowMs, supplied) =>
          Effect.sync(() => {
            stolenWith = supplied
            return { _tag: "Claimed" as const, claimedAtMs: 9 }
          }),
        activate: () => Effect.succeed({ _tag: "Activated" as const })
      })
      expect(yield* Lease.claimAndActivate(runs, request({ evidence }))).toBe(9)
      expect(stolenWith).toBe(evidence)
    }))

  it.effect("maps a refused claim through the caller's refusal", () =>
    Effect.gen(function*() {
      const runs = RunStore.makeNoop({ claim: () => Effect.succeed({ _tag: "HeartbeatFresh" as const }) })
      const failure = yield* Effect.flip(Lease.claimAndActivate(runs, request()))
      expect(failure).toMatchObject({ code: "busy", message: "refused HeartbeatFresh" })
    }))

  it.effect("abandons the exact claim when activation loses it", () =>
    Effect.gen(function*() {
      const abandoned: Array<unknown> = []
      const runs = RunStore.makeNoop({
        claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 5 }),
        activate: () => Effect.succeed({ _tag: "ClaimLost" as const }),
        abandonClaim: (runId, claimant, claimedAtMs) =>
          Effect.sync(() => {
            abandoned.push([runId, claimant, claimedAtMs])
            return { _tag: "Abandoned" as const }
          })
      })
      const failure = yield* Effect.flip(Lease.claimAndActivate(runs, request()))
      expect(failure).toMatchObject({ code: "busy", message: "activation lost" })
      expect(abandoned).toEqual([["run", owner, 5]])
    }))

  it.effect("maps a run-store failure with the named operation", () =>
    Effect.gen(function*() {
      const runs = RunStore.makeNoop({
        claim: () =>
          Effect.fail(
            new RunStore.RunStoreError({
              code: "persistence_failed",
              method: "claim",
              message: "claim failed",
              cause: "claim"
            })
          )
      })
      const failure = yield* Effect.flip(Lease.claimAndActivate(runs, request()))
      expect(failure).toMatchObject({ code: "unknown", message: "claim run failed" })
    }))
})
