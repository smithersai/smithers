import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { type Config, empty, type Event, green, plan, samePart, type State, step, tree } from "../src/Kernel.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "2000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const RawEvent = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("enqueue"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
    priority: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("withdraw"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("result"),
    run: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
    check: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
    verdict: Schema.Literals(["pass", "fail"]),
    duration: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("fixed"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
    attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("gaveUp"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
    attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
    detail: Schema.Literal("unfixable")
  }),
  Schema.Struct({
    _tag: Schema.Literal("foreign"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("start"),
    count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("push"),
    run: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("probe"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("land"),
    run: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("blame"),
    run: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("cancel"),
    run: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 }))
  })
])

const config: Config = {
  required: [1, 2],
  maxAttempts: 2,
  maxBatch: 3,
  maxRuns: 3,
  window: 5,
  defaultDuration: 100
}

describe("@smthrs/merge-queue fuzz safety invariants", () => {
  it("main is strictly append-only and only green runs ever land across arbitrary adversarial event sequences", async () => {
    const arb = Arbitrary.schema(Schema.Array(RawEvent))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (events) => {
          let state: State = empty
          for (const ev of events.slice(0, 40) as ReadonlyArray<Event>) {
            const prevMain = state.main
            const prevLanded = state.landed.length
            const next = step(config, state, ev)

            // Safety 1: main is strictly append-only (never rewrites or shrinks landed parts).
            if (next.main.length < prevMain.length) return false
            for (let i = 0; i < prevMain.length; i++) {
              if (!samePart(prevMain[i]!, next.main[i]!)) return false
            }

            // Safety 2: any queue landing (non-foreign) MUST have come from a run that passed ALL required checks.
            if (ev._tag !== "foreign" && next.landed.length > prevLanded) {
              const newLandings = next.landed.slice(prevLanded)
              for (const landing of newLandings) {
                const run = state.runs.find((r) => r.id === landing.run)
                if (run === undefined) return false
                if (!green(config, run.results)) return false
                const runTree = tree(run)
                if (next.main.length !== runTree.length) return false
              }
            }

            // Safety 3: plan(config, next) returns a valid Event or undefined, and applying it preserves append-only main.
            const planned = plan(config, next)
            if (planned !== undefined) {
              const afterPlan = step(config, next, planned)
              if (afterPlan.main.length < next.main.length) return false
              for (let i = 0; i < next.main.length; i++) {
                if (!samePart(next.main[i]!, afterPlan.main[i]!)) return false
              }
            }

            state = next
          }
          return true
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
