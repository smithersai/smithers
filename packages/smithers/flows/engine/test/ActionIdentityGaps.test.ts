import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Result, Schedule, Schema, Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect } from "./Harness.ts"

const hostFlow = Flow.make("IdentityGaps/host", {
  payload: { id: Schema.String },
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})

const provideHost = <A, E>(
  self: Effect.Effect<
    A,
    E,
    Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Scope.Scope
  >
): Effect.Effect<A, E, Crypto.Crypto> =>
  self.pipe(
    Effect.scoped,
    Effect.provideService(
      FlowRuntime.FlowInstance,
      FlowEngine.makeInstance(hostFlow, "host-run")
    ),
    Effect.provide(FlowEngine.layerMemory)
  )

describe("Action.idempotencyKey scoping", () => {
  effect("separates durable declarations by caller name within the same parent scope", () => {
    const baselineInstance = FlowEngine.makeInstance(hostFlow, "run-names")
    const replayInstance = FlowEngine.makeInstance(hostFlow, "run-names")
    const isolatedFirstInstance = FlowEngine.makeInstance(hostFlow, "run-names")
    const isolatedSecondInstance = FlowEngine.makeInstance(hostFlow, "run-names")
    const otherRunInstance = FlowEngine.makeInstance(hostFlow, "other-run")
    const parentScope = "queue:orders"
    return Effect.gen(function*() {
      const first = yield* Action.idempotencyKey("first-name", { parentScope }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, baselineInstance)
      )
      const second = yield* Action.idempotencyKey("second-name", { parentScope }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, baselineInstance)
      )
      const replaySecond = yield* Action.idempotencyKey("second-name", { parentScope }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, replayInstance)
      )
      const replayFirst = yield* Action.idempotencyKey("first-name", { parentScope }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, replayInstance)
      )
      const isolatedFirst = yield* Action.idempotencyKey("first-name", { parentScope }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, isolatedFirstInstance)
      )
      const isolatedSecond = yield* Action.idempotencyKey("second-name", { parentScope }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, isolatedSecondInstance)
      )
      const otherRunFirst = yield* Action.idempotencyKey("first-name", { parentScope }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, otherRunInstance)
      )

      // Each declaration has an independent counter, so swapping arrival
      // order during replay cannot transfer one declaration's ordinal to the
      // other. Comparing each declaration's first allocation is the issue-#98
      // regression guard: the old name-free scope gave both the same key.
      expect(first).not.toBe(second)
      expect(isolatedFirst).not.toBe(isolatedSecond)
      expect(first).toBe(isolatedFirst)
      expect(second).toBe(isolatedSecond)
      expect(replayFirst).toBe(first)
      expect(replaySecond).toBe(second)
      expect(otherRunFirst).not.toBe(first)
    })
  })

  effect("scopes the key by the current attempt only when includeAttempt is set", () => {
    return Effect.gen(function*() {
      const plainAtOne = yield* Action.idempotencyKey("op").pipe(
        Effect.provideService(Action.CurrentAttempt, 1),
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(hostFlow, "run-attempt"))
      )
      const plainAtSeven = yield* Action.idempotencyKey("op").pipe(
        Effect.provideService(Action.CurrentAttempt, 7),
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(hostFlow, "run-attempt"))
      )
      const offAtSeven = yield* Action.idempotencyKey("op", { includeAttempt: false }).pipe(
        Effect.provideService(Action.CurrentAttempt, 7),
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(hostFlow, "run-attempt"))
      )
      const scopedAtSeven = yield* Action.idempotencyKey("op", { includeAttempt: true }).pipe(
        Effect.provideService(Action.CurrentAttempt, 7),
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(hostFlow, "run-attempt"))
      )
      const scopedAtEight = yield* Action.idempotencyKey("op", { includeAttempt: true }).pipe(
        Effect.provideService(Action.CurrentAttempt, 8),
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(hostFlow, "run-attempt"))
      )

      expect(plainAtSeven).toBe(plainAtOne)
      expect(offAtSeven).toBe(plainAtOne)
      expect(scopedAtSeven).not.toBe(plainAtOne)
      expect(scopedAtEight).not.toBe(scopedAtSeven)
    })
  })

  effect("an explicit parentScope wins over includeAttempt", () => {
    return Effect.gen(function*() {
      const withBoth = yield* Action.idempotencyKey("op", {
        parentScope: "queue:orders",
        includeAttempt: true
      }).pipe(
        Effect.provideService(Action.CurrentAttempt, 4),
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(hostFlow, "run-scope"))
      )
      const parentOnlyAtAnotherAttempt = yield* Action.idempotencyKey("op", {
        parentScope: "queue:orders"
      }).pipe(
        Effect.provideService(Action.CurrentAttempt, 9),
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(hostFlow, "run-scope"))
      )
      const attemptOnly = yield* Action.idempotencyKey("op", { includeAttempt: true }).pipe(
        Effect.provideService(Action.CurrentAttempt, 4),
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(hostFlow, "run-scope"))
      )

      expect(withBoth).toBe(parentOnlyAtAnotherAttempt)
      expect(withBoth).not.toBe(attemptOnly)
    })
  })

  effect("keys allocated under the same attempt scope stay distinct per ordinal", () => {
    const baselineInstance = FlowEngine.makeInstance(hostFlow, "run-same")
    const replayInstance = FlowEngine.makeInstance(hostFlow, "run-same")
    return Effect.gen(function*() {
      const baseline = yield* Effect.all([
        Action.idempotencyKey("op", { includeAttempt: true }),
        Action.idempotencyKey("op", { includeAttempt: true })
      ], { concurrency: 1 }).pipe(
        Effect.provideService(Action.CurrentAttempt, 3),
        Effect.provideService(FlowRuntime.FlowInstance, baselineInstance)
      )
      const replay = yield* Effect.all([
        Action.idempotencyKey("op", { includeAttempt: true }),
        Action.idempotencyKey("op", { includeAttempt: true })
      ], { concurrency: 1 }).pipe(
        Effect.provideService(Action.CurrentAttempt, 3),
        Effect.provideService(FlowRuntime.FlowInstance, replayInstance)
      )
      const [a, b] = baseline

      expect(a).not.toBe(b)
      expect(replay).toEqual(baseline)
    })
  })

  effect("keys with distinct parent scopes survive a replay with reversed arrival order (issue #98)", () => {
    // Two concurrent `DurableQueue.offer`-style allocations each declare
    // their payload key as `parentScope`. A run-global counter numbered them
    // in fiber-arrival order, so a replay whose interleaving reversed the
    // arrivals handed payload A payload B's ordinal — a brand-new key the
    // persisted queue had never seen, duplicating the work item and leaving
    // the original await watching a deferred nothing resolves. With the
    // counter scoped per declared parent, arrival order is immaterial.
    const allocate = (order: ReadonlyArray<string>) => {
      const instance = FlowEngine.makeInstance(hostFlow, "run-arrival")
      return Effect.gen(function*() {
        const keys: Record<string, string> = {}
        for (const parent of order) {
          keys[parent] = yield* Action.idempotencyKey("offer", { parentScope: parent })
        }
        return keys
      }).pipe(Effect.provideService(FlowRuntime.FlowInstance, instance))
    }
    return Effect.gen(function*() {
      const first = yield* allocate(["payload:a", "payload:b"])
      const replay = yield* allocate(["payload:b", "payload:a"])
      // Identity is a function of the declared parent alone, never of which
      // fiber happened to allocate first.
      expect(replay).toEqual(first)
      expect(first["payload:a"]).not.toBe(first["payload:b"])
    })
  })
})

describe("infrastructure interrupt retry", () => {
  effect("passes a non-infrastructure failure through untouched instead of dying", () => {
    // The `while: isInfraInterrupt` retry wrapper must not convert an ordinary
    // typed failure into a defect just because a policy is installed.
    let attempts = 0
    const action = Action.make({
      name: "IdentityGaps/typed-failure",
      error: Schema.String,
      interruptRetryPolicy: Schedule.recurs(3),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail("business-error")
      })
    })

    return Effect.gen(function*() {
      const exit = yield* action.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe("business-error")
      // a typed failure is never retried by the infra-interrupt policy
      expect(attempts).toBe(1)
    }).pipe(provideHost)
  })

  effect("retries an infrastructure interrupt until the policy is exhausted, then dies", () => {
    let attempts = 0
    const action = Action.make({
      name: "IdentityGaps/infra-exhausted",
      error: Schema.Unknown,
      interruptRetryPolicy: Schedule.recurs(2),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail(new Action.InfraInterrupt({ reason: "host-lost" }))
      })
    })

    return Effect.gen(function*() {
      const exit = yield* action.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
        "infrastructure interrupt retry attempts exhausted"
      )
      // initial attempt + 2 recurrences
      expect(attempts).toBe(3)
    }).pipe(provideHost)
  })

  effect("recovers when a retried infrastructure interrupt later succeeds", () => {
    let attempts = 0
    const action = Action.make({
      name: "IdentityGaps/infra-recovers",
      success: Schema.Number,
      error: Schema.Unknown,
      interruptRetryPolicy: Schedule.recurs(5),
      execute: Effect.suspend(() => {
        attempts++
        return attempts < 3
          ? Effect.fail(new Action.InfraInterrupt({ reason: "host-lost" }))
          : Effect.succeed(attempts)
      })
    })

    return Effect.gen(function*() {
      expect(yield* action.execute).toBe(3)
    }).pipe(provideHost)
  })

  effect("without a policy an infrastructure interrupt surfaces as its own typed failure", () => {
    const action = Action.make({
      name: "IdentityGaps/infra-unpolicied",
      error: Schema.Unknown,
      execute: Effect.fail(new Action.InfraInterrupt({ reason: "host-lost" }))
    })

    return Effect.gen(function*() {
      const exit = yield* action.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(
        Exit.isFailure(exit) && (Cause.squash(exit.cause) as Action.InfraInterrupt)._tag
      ).toBe("@smthrs/flow/InfraInterrupt")
    }).pipe(provideHost)
  })
})
