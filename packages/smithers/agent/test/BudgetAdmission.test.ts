/**
 * Admission and account lifetime cases from the round-one review: an attempt
 * that reported no usage under weights, a retry of a step that already holds
 * a reservation, calls in flight under a daily cap, and accounts released
 * when their run ends.
 */
import { FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Exit, Scope } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"

const inRun = <A, E, R>(executionId: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(FlowRuntime.FlowInstance, { executionId } as FlowRuntime.FlowInstance["Service"]))
const inScope = <A, E>(scope: Scope.Scope, effect: Effect.Effect<A, E, Scope.Scope>) => Scope.provide(scope)(effect)
const close = (scope: Scope.Closeable) => Scope.close(scope, Exit.void)
const release = (budget: Budget.Service, runId: string) => budget.release?.(runId) ?? Effect.void

describe("weighted usage a provider never reported", () => {
  const weights = { m: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 4 } }

  it.each([
    ["nothing", {}],
    ["only a total", { totalTokens: 500 }],
    ["only its input", { inputTokens: 500 }]
  ])("charges an attempt that reported %s as unreported and admits the next call", async (_, usage) => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ weights, tokens: { max: 1_000 } })
      yield* budget.record("dropped", usage, "m")
      // The same attempt recorded again is the same charge, not a conflict.
      yield* budget.record("dropped", usage, "m")
      expect((yield* Effect.scoped(budget.reserve("next")))._tag).toBe("proceed")
      expect(yield* budget.usage).toEqual({ tokens: 0, calls: 1, largestCall: 0, unreported: 1 })
    }))
  })

  it("still weighs complete usage, and still fails closed on a malformed counter", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ weights, tokens: { max: 1_000 } })
      yield* budget.record("complete", { inputTokens: 10, outputTokens: 2 }, "m")
      expect(yield* budget.usage).toEqual({ tokens: 18, calls: 1, largestCall: 18 })
      expect((yield* budget.record("malformed", { inputTokens: -1 }, "m").pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* Effect.scoped(budget.reserve("next")).pipe(Effect.exit))._tag).toBe("Failure")
    }))
  })
})

describe("a step that already holds a reservation", () => {
  it("is refused on its retry once its failed attempt spent the allowance", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 100 } })
      const scope = yield* Scope.make()
      expect((yield* inScope(scope, budget.reserve("step")))._tag).toBe("proceed")
      // The attempt ended unsealed, so its spend is charged under a receipt.
      yield* budget.record("unsealed-model/step/receipt-1", { totalTokens: 100 })
      expect(yield* inScope(scope, budget.reserve("step"))).toMatchObject({
        _tag: "refuse",
        exceeded: { scope: "tokens", used: 100, reserved: 0, next: 100, max: 100 }
      })
      expect(yield* budget.check("step")).toMatchObject({ _tag: "refuse", exceeded: { used: 100, reserved: 0 } })
      yield* close(scope)
    }))
  })

  it("is refused by a latch that was set after it reserved", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 100, onExceeded: "skip-remaining" } })
      const scope = yield* Scope.make()
      expect((yield* inScope(scope, budget.reserve("held")))._tag).toBe("proceed")
      yield* budget.record("unsealed-model/held/receipt-1", { totalTokens: 100 })
      expect((yield* inScope(scope, budget.reserve("other")))._tag).toBe("refuse")
      const retried = yield* inScope(scope, budget.reserve("held"))
      expect(retried).toMatchObject({ _tag: "refuse", failure: { _tag: Budget.skippedTag } })
      yield* close(scope)
    }))
  })

  it("is never counted against itself, in tokens or in dollars", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 1_000 }, usd: { max: 1 } })
      const scope = yield* Scope.make()
      expect((yield* inScope(scope, budget.reserve("same")))._tag).toBe("proceed")
      expect((yield* inScope(scope, budget.reserve("same")))._tag).toBe("proceed")
      expect(yield* inScope(scope, budget.reserve("different"))).toMatchObject({
        _tag: "refuse",
        exceeded: { scope: "tokens", reserved: 1_000, next: 1_000 }
      })
      yield* close(scope)
    }))
  })

  it("holds only other steps' dollars against a USD ceiling", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ usd: { max: 1 } })
      const scope = yield* Scope.make()
      expect((yield* inScope(scope, budget.reserve("same")))._tag).toBe("proceed")
      expect((yield* inScope(scope, budget.reserve("same")))._tag).toBe("proceed")
      expect(yield* inScope(scope, budget.reserve("different"))).toMatchObject({
        _tag: "refuse",
        exceeded: { scope: "usd", reserved: 1, next: 1 }
      })
      yield* close(scope)
    }))
  })
})

describe("a daily cap and calls in flight", () => {
  const day = "1970-01-01"
  const atTheClock = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.provide(effect, TestClock.layer()))

  it("refuses the second of two fresh runs that reserve at once one token under the cap", async () => {
    await atTheClock(Effect.gen(function*() {
      const memory = Budget.memoryLedger()
      yield* memory.record({ day, runId: "earlier", stepKey: "paid", spent: 999 })
      // The read yields, so both runs have asked before either holds anything.
      const ledger: Budget.Ledger = {
        ...memory,
        total: (asked) => Effect.andThen(Effect.yieldNow, memory.total(asked))
      }
      const budget = yield* Budget.make({ daily: { max: 1_000 } }, { ledger })
      const scopes = [yield* Scope.make(), yield* Scope.make()]
      const verdicts = yield* Effect.forEach(
        scopes,
        (scope, index) => inRun(`fresh-${index}`, inScope(scope, budget.reserve("first"))),
        { concurrency: "unbounded" }
      )
      expect(verdicts.map((verdict) => verdict._tag).sort()).toEqual(["proceed", "refuse"])
      expect(verdicts.find((verdict) => verdict._tag === "refuse")).toMatchObject({
        exceeded: { scope: "daily", used: 999, reserved: 1, next: 0, max: 1_000 }
      })
      yield* Effect.forEach(scopes, close)
      // Released, the hold is gone: the day still has its one token.
      expect((yield* inRun("fresh-2", Effect.scoped(budget.reserve("first"))))._tag).toBe("proceed")
    }))
  })

  it("projects a fresh run's first call at its token allowance and holds it while in flight", async () => {
    await atTheClock(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 400 }, daily: { max: 1_000 } }, {
        ledger: Budget.memoryLedger()
      })
      const scope = yield* Scope.make()
      expect((yield* inRun("a", inScope(scope, budget.reserve("first"))))._tag).toBe("proceed")
      expect((yield* inRun("b", inScope(scope, budget.reserve("first"))))._tag).toBe("proceed")
      expect(yield* inRun("c", inScope(scope, budget.reserve("first")))).toMatchObject({
        _tag: "refuse",
        exceeded: { scope: "daily", used: 0, reserved: 800, next: 400 }
      })
      expect(yield* inRun("c", budget.check("first"))).toMatchObject({ _tag: "refuse", exceeded: { reserved: 800 } })
      // A reading projects nothing and is refused only by spend already made.
      expect((yield* inRun("c", budget.admitReading("reading")))._tag).toBe("proceed")
      yield* close(scope)
      expect((yield* inRun("c", Effect.scoped(budget.reserve("first"))))._tag).toBe("proceed")
    }))
  })

  it("holds each run's largest call per call in flight, and nothing for a settled step", async () => {
    await atTheClock(Effect.gen(function*() {
      const budget = yield* Budget.make({ daily: { max: 1_000 } }, { ledger: Budget.memoryLedger() })
      const scope = yield* Scope.make()
      yield* inRun("a", budget.record("s1", { totalTokens: 300 }))
      expect((yield* inRun("a", inScope(scope, budget.reserve("s2"))))._tag).toBe("proceed")
      // Settled while its reservation is still open: the ledger holds it now.
      yield* inRun("a", budget.record("s2", { totalTokens: 300 }))
      // A call outside any run and a fresh run each hold one token.
      expect((yield* inScope(scope, budget.reserve("loose")))._tag).toBe("proceed")
      expect((yield* inRun("b", inScope(scope, budget.reserve("first"))))._tag).toBe("proceed")
      expect((yield* inRun("a", inScope(scope, budget.reserve("s3"))))._tag).toBe("proceed")
      // Its own hold is not counted against a step that asks again.
      expect((yield* inRun("a", inScope(scope, budget.reserve("s3"))))._tag).toBe("proceed")
      expect(yield* inRun("a", inScope(scope, budget.reserve("s4")))).toMatchObject({
        _tag: "refuse",
        exceeded: { scope: "daily", used: 600, reserved: 302, next: 300 }
      })
      yield* close(scope)
    }))
  })
})

describe("a budget account when its run ends", () => {
  const spend = (budget: Budget.Service, runId: string) =>
    inRun(
      runId,
      Effect.gen(function*() {
        expect((yield* Effect.scoped(budget.reserve("call")))._tag).toBe("proceed")
        yield* budget.record("call", { totalTokens: 10 })
      })
    )

  it("passes three sequential memory-only runs through a two-run budget when each run releases", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({}, { maxRuns: 2 })
      for (const runId of ["first", "second", "third"]) {
        yield* Effect.scoped(Effect.andThen(Budget.releaseOnClose(runId), spend(budget, runId))).pipe(
          Effect.provideService(Budget.Budget, budget)
        )
      }
      // A released memory-only account is gone; nothing durable remembers it.
      expect(yield* budget.usageOf("first")).toEqual({ tokens: 0, calls: 0, largestCall: 0 })
    }))
  })

  it("refuses the third memory-only run when no run released", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({}, { maxRuns: 2 })
      yield* spend(budget, "first")
      yield* spend(budget, "second")
      expect((yield* inRun("third", budget.check("call")).pipe(Effect.exit))._tag).toBe("Failure")
    }))
  })

  it("keeps an account with a call in flight, and ignores a run it never saw", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({})
      yield* release(budget, "never-seen")
      const scope = yield* Scope.make()
      yield* inRun("busy", budget.record("paid", { totalTokens: 100 }))
      yield* inRun("busy", inScope(scope, budget.reserve("call")))
      yield* release(budget, "busy")
      expect(yield* budget.usageOf("busy")).toEqual({ tokens: 100, calls: 1, largestCall: 100 })
      yield* close(scope)
      yield* release(budget, "busy")
      expect(yield* budget.usageOf("busy")).toEqual({ tokens: 0, calls: 0, largestCall: 0 })
    }))
  })

  it("keeps an account whose usage no durable record holds yet", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const budget = yield* Budget.make({})
        const unwritable: Journal.Service = {
          ...journal,
          emitDurableUnfenced: (input) =>
            input.eventType === Budget.usageEvent
              ? Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "injected usage write failure" }))
              : journal.emitDurableUnfenced(input)
        }
        yield* inRun("pending", budget.record("paid", { totalTokens: 100 })).pipe(
          Effect.provideService(Journal.Journal, unwritable),
          Effect.exit
        )
        yield* release(budget, "pending")
        // Still the same account: its uncommitted spend keeps admission closed.
        expect((yield* inRun("pending", budget.check("next")).pipe(Effect.exit))._tag).toBe("Failure")
        yield* inRun("pending", budget.record("paid", { totalTokens: 100 }))
        yield* release(budget, "pending")
        // Released and durable: the account is rebuilt from its record.
        expect(yield* budget.usageOf("pending")).toEqual({ tokens: 100, calls: 1, largestCall: 100 })
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )
  })

  it("does nothing for a budget that keeps no accounts", async () => {
    await Effect.runPromise(
      Effect.scoped(Budget.releaseOnClose("any")).pipe(Effect.provide(Budget.layerUnbounded()))
    )
  })
})
