import { FlowRuntime } from "@smthrs/flow"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { describe, expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"

const inRun = <A, E, R>(executionId: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(FlowRuntime.FlowInstance, { executionId } as FlowRuntime.FlowInstance["Service"]))
const inScope = <A, E>(scope: Scope.Scope, effect: Effect.Effect<A, E, Scope.Scope>) => Scope.provide(scope)(effect)
const close = (scope: Scope.Closeable) => Scope.close(scope, Exit.void)

describe("atomic budget reservations", () => {
  it("admits only one of two concurrent calls that each fit the remaining allowance", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 1_000 } })
      yield* budget.record("seed", { totalTokens: 400 })
      const scopes = [yield* Scope.make(), yield* Scope.make()]
      const verdicts = yield* Effect.forEach(scopes, (scope, i) => inScope(scope, budget.reserve(`call-${i}`)), {
        concurrency: "unbounded"
      })
      expect(verdicts.map((v) => v._tag).sort()).toEqual(["proceed", "refuse"])
      const admitted = verdicts.findIndex((v) => v._tag === "proceed")
      yield* budget.record(`call-${admitted}`, { totalTokens: 400 })
      yield* Effect.forEach(scopes, close)
      expect(yield* budget.usage).toEqual({ tokens: 800, calls: 2, largestCall: 400 })
      expect((yield* Effect.scoped(budget.reserve("next")))._tag).toBe("refuse")
    }))
  })

  it("holds capacity for an unmeasured first call and releases it after cancellation", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 1_000 } })
      const entered = yield* Deferred.make<void>()
      const fiber = yield* Effect.scoped(Effect.gen(function*() {
        expect((yield* budget.reserve("first"))._tag).toBe("proceed")
        yield* Deferred.succeed(entered, undefined)
        return yield* Effect.never
      })).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      expect((yield* Effect.scoped(budget.reserve("second")))._tag).toBe("refuse")
      yield* Fiber.interrupt(fiber)
      expect((yield* Effect.scoped(budget.reserve("second")))._tag).toBe("proceed")
      expect(yield* budget.usage).toEqual({ tokens: 0, calls: 0, largestCall: 0 })
    }))
  })

  it("does not release a duplicate key's reservation until its last holder closes", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 1_000 } })
      yield* budget.record("seed", { totalTokens: 400 })
      const first = yield* Scope.make()
      const second = yield* Scope.make()
      expect((yield* inScope(first, budget.reserve("same")))._tag).toBe("proceed")
      expect((yield* inScope(second, budget.reserve("same")))._tag).toBe("proceed")
      yield* close(first)
      expect((yield* Effect.scoped(budget.reserve("different")))._tag).toBe("refuse")
      yield* close(second)
      expect((yield* Effect.scoped(budget.reserve("different")))._tag).toBe("proceed")
    }))
  })

  it("reconciles actual spend and increases outstanding forecasts when a larger call settles", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 1_500 } })
      yield* budget.record("seed", { totalTokens: 400 })
      const scope = yield* Scope.make()
      expect((yield* inScope(scope, budget.reserve("small")))._tag).toBe("proceed")
      expect((yield* inScope(scope, budget.reserve("large")))._tag).toBe("proceed")
      yield* budget.record("small", { totalTokens: 100 })
      expect((yield* inScope(scope, budget.reserve("pending")))._tag).toBe("proceed")
      yield* budget.record("large", { totalTokens: 700 })
      expect(yield* budget.check("next")).toMatchObject({
        _tag: "refuse",
        exceeded: { used: 1_200, reserved: 700, next: 700 }
      })
      expect(yield* budget.usage).toEqual({ tokens: 1_200, calls: 3, largestCall: 700 })
      // Paid replay is free, even with other reservations or after overspend.
      expect((yield* inScope(scope, budget.reserve("large")))._tag).toBe("proceed")
      yield* close(scope)
    }))
  })

  it("refuses zero token budgets, with explicit warn and skip policy behavior", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      for (const onExceeded of ["fail", "warn", "skip-remaining"] as const) {
        const budget = yield* Budget.make({ tokens: { max: 0, onExceeded } })
        const verdict = yield* Effect.scoped(budget.reserve("first"))
        expect(verdict._tag).toBe(onExceeded === "warn" ? "warn" : "refuse")
        expect((yield* budget.check("next"))._tag).toBe(verdict._tag)
      }
    }))
  })

  it("releases a failed call but retains its reported usage", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 1_000 } })
      yield* Effect.scoped(Effect.gen(function*() {
        yield* budget.reserve("failed")
        yield* budget.record("failed", { totalTokens: 300 })
        return yield* Effect.fail("provider failed after reporting usage")
      })).pipe(Effect.exit)
      expect((yield* Effect.scoped(budget.reserve("next")))._tag).toBe("proceed")
      expect(yield* budget.usage).toEqual({ tokens: 300, calls: 1, largestCall: 300 })
    }))
  })

  it("pins a durable account for the whole reservation lifetime", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({}, { maxRuns: 1 })
        const scope = yield* Scope.make()
        yield* inRun("reserved", inScope(scope, budget.reserve("call")))
        expect((yield* inRun("other", budget.check("next")).pipe(Effect.exit))._tag).toBe("Failure")
        yield* close(scope)
        expect((yield* inRun("other", budget.check("next")))._tag).toBe("proceed")
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )
  })
})
