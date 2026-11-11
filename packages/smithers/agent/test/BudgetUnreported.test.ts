import { FlowRuntime } from "@smthrs/flow"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect } from "effect"
import { expect, it } from "vitest"
import * as Budget from "../src/Budget.vibe"

const inRun = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, FlowRuntime.FlowInstance, { executionId: id } as FlowRuntime.FlowInstance["Service"])

it("names usage that carries no token count", () => {
  expect(Budget.reportsTokens({})).toBe(false)
  expect(Budget.reportsTokens({ inputTokens: 4 })).toBe(false)
  expect(Budget.reportsTokens({ outputTokens: 4 })).toBe(false)
  expect(Budget.reportsTokens({ inputTokens: 0, outputTokens: 0 })).toBe(true)
  expect(Budget.reportsTokens({ totalTokens: 9 })).toBe(true)
})

it.each([
  { inputTokens: 0.5, outputTokens: 0 },
  { totalTokens: Number.NaN },
  { inputTokens: -1, outputTokens: 0 },
  { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
  { totalTokens: 1, outputTokens: Number.POSITIVE_INFINITY }
])("identifies an unusable token report (%j)", (usage) => {
  expect(Budget.reportsTokens(usage)).toBe(false)
})

it.each([false, true])(
  "counts calls whose provider reported no tokens, live and recovered (journal=%s)",
  async (journal) => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const ledger = Budget.memoryLedger()
        const first = yield* Budget.make({}, { ledger })
        yield* inRun("run", first.record("silent", {}))
        yield* inRun("run", first.record("partial", { inputTokens: 4 }))
        yield* inRun("run", first.record("paid", { inputTokens: 3, outputTokens: 2 }))
        yield* inRun("run", first.record("total", { totalTokens: 9 }))
        const expected = { tokens: 18, calls: 4, largestCall: 9, unreported: 2 }
        expect(yield* first.usageOf("run")).toEqual(expected)
        const fresh = yield* Budget.make({}, { ledger })
        expect(yield* fresh.usageOf("run")).toEqual(expected)
      }).pipe((effect) => journal ? Effect.provide(effect, TestJournal.layer()) : effect, Effect.scoped)
    )
  }
)

it("omits the unreported count when every call reported its tokens", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const budget = yield* Budget.make({})
    yield* inRun("run", budget.record("paid", { inputTokens: 3, outputTokens: 2 }))
    expect(yield* budget.usageOf("run")).toEqual({ tokens: 5, calls: 1, largestCall: 5 })
  }))
})
