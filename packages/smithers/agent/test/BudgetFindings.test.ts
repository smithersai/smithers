import { FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"

const inRun = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, FlowRuntime.FlowInstance, { executionId: id } as FlowRuntime.FlowInstance["Service"])

it.each(["latency", "suspension", "skip"] as const)("pins ledger-only %s state against eviction", async (state) => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const budget = yield* Budget.make(
        state === "skip"
          ? { tokens: { max: 0, onExceeded: "skip-remaining" } }
          : { latency: { maxMillis: 5 } },
        { ledger: Budget.memoryLedger(), maxRuns: 1 }
      )
      yield* inRun("a", budget.check("first"))
      if (state === "suspension") yield* inRun("a", budget.suspend)
      const admission = yield* inRun("b", budget.check("first")).pipe(Effect.exit)
      expect(admission._tag).toBe("Failure")
      yield* TestClock.adjust("10 millis")
      expect((yield* inRun("a", budget.check("second")))._tag).toBe(state === "suspension" ? "proceed" : "refuse")
    }).pipe(Effect.provide(TestClock.layer()))
  )
})

it.each(["tokens", "usd", "daily"] as const)("enforces %s after a latency warning", async (scope) => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const budget = yield* Budget.make({
        latency: { maxMillis: 1, onExceeded: "warn" },
        [scope]: { max: 1 }
      }, { ledger: Budget.memoryLedger() })
      yield* inRun("a", budget.check("first"))
      yield* inRun("a", budget.record("paid", { totalTokens: 2, costUsd: 2 }))
      yield* TestClock.adjust("2 millis")
      expect(yield* inRun("a", budget.check("next"))).toMatchObject({ _tag: "refuse", exceeded: { scope } })
    }).pipe(Effect.provide(TestClock.layer()))
  )
})

it.each(["suspend", "resume"] as const)("keeps live latency consistent after a rolled-back %s", async (transition) => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const budget = yield* Budget.make({ latency: { maxMillis: 5 } })
      yield* budget.check("first")
      if (transition === "resume") {
        yield* budget.suspend
        yield* TestClock.adjust("10 millis")
      }
      const result = yield* journal.transact(
        Effect.andThen(transition === "suspend" ? budget.suspend : budget.resume(), Effect.fail("rollback"))
      ).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      yield* TestClock.adjust("10 millis")
      expect((yield* budget.check("next"))._tag).toBe(transition === "suspend" ? "refuse" : "proceed")
      const fresh = yield* Budget.make({ latency: { maxMillis: 5 } })
      expect((yield* fresh.check("next"))._tag).toBe(transition === "suspend" ? "refuse" : "proceed")
    }).pipe(
      (effect) => inRun("transaction", effect),
      Effect.provide(TestJournal.layer()),
      Effect.provide(TestClock.layer()),
      Effect.scoped
    )
  )
})

it.each([false, true])("reads uncached ledger charges with journal=%s", async (journal) => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const ledger = Budget.memoryLedger()
      const first = yield* Budget.make({}, { ledger })
      yield* inRun("paid", first.record("step", { totalTokens: 7, costUsd: 1 }))
      const fresh = yield* Budget.make({}, { ledger })
      expect(yield* fresh.usageOf("paid")).toEqual({ tokens: 7, calls: 1, largestCall: 7 })
    }).pipe((effect) => journal ? Effect.provide(effect, TestJournal.layer()) : effect, Effect.scoped)
  )
})

it.each(["tokens", "usd"] as const)("proposes an effective raise for an unused zero %s ceiling", async (scope) => {
  await Effect.runPromise(Effect.gen(function*() {
    const budget = yield* Budget.make({ [scope]: { max: 0, onExceeded: "park" } })
    const verdict = yield* budget.check("first")
    expect(verdict._tag).toBe("refuse")
    if (verdict._tag !== "refuse") throw new Error("expected refusal")
    const proposed = Budget.raise({ [scope]: 0 }, verdict.exceeded)
    expect(proposed[scope]).toBeGreaterThan(0)
    const raised = yield* Budget.make({ [scope]: { max: proposed[scope]! } })
    expect((yield* raised.check("first"))._tag).toBe("proceed")
  }))
})

it("fails closed when uncached ledger charges cannot be read", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const ledger: Budget.Ledger = { ...Budget.memoryLedger(), run: () => Effect.fail("ledger unavailable") }
    const budget = yield* Budget.make({}, { ledger })
    expect((yield* budget.usageOf("unknown").pipe(Effect.exit))._tag).toBe("Failure")
  }))
})

it.each(["fail", "warn", "park", "skip-remaining"] as const)(
  "enforces a zero latency ceiling on the first call with %s",
  async (onExceeded) => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ latency: { maxMillis: 0, onExceeded } })
        for (const key of ["first", "same-millisecond"]) {
          const verdict = yield* Effect.scoped(budget.reserve(key))
          expect(verdict).toMatchObject({
            _tag: onExceeded === "warn" ? "warn" : "refuse",
            exceeded: { scope: "latency", onExceeded, used: 0, max: 0 }
          })
          expect((yield* budget.check(key))._tag).toBe(verdict._tag)
        }
      }).pipe(Effect.provide(TestClock.layer()))
    )
  }
)

it("admits a call exactly at a positive latency ceiling and refuses after it", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const budget = yield* Budget.make({ latency: { maxMillis: 5 } })
      expect((yield* budget.check("first"))._tag).toBe("proceed")
      yield* TestClock.adjust("5 millis")
      expect((yield* Effect.scoped(budget.reserve("at-limit")))._tag).toBe("proceed")
      yield* TestClock.adjust("1 millis")
      expect((yield* budget.check("past-limit"))._tag).toBe("refuse")
    }).pipe(Effect.provide(TestClock.layer()))
  )
})
