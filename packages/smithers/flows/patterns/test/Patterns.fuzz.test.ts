import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Duration, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Bounded, PatternError, Quarantine, Saga } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "800" : "150"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/patterns deterministic concurrency fuzz invariants", () => {
  it("Bounded.run never exceeds concurrency cap under arbitrary FuzzSimulation fiber schedules", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        delays: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ count, concurrency, delays }) =>
          Effect.gen(function*() {
            let active = 0
            let peak = 0
            const members: Record<string, Effect.Effect<number>> = {}
            for (let i = 0; i < count; i++) {
              const delay = delays[i] ?? 0
              members[`m${i}`] = Effect.gen(function*() {
                active++
                if (active > peak) peak = active
                yield* Effect.sleep(Duration.millis(delay))
                yield* Effect.yieldNow
                active--
                return i * 3 + 1
              })
            }
            const result = yield* Bounded.run(members, { concurrency })
            if (peak > concurrency || active !== 0) return false
            for (let i = 0; i < count; i++) {
              if (result[`m${i}`] !== i * 3 + 1) return false
            }
            return true
          }),
        { seed, executions, execution: FuzzSimulation.execution() }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Saga.run unwinds completed steps in exact LIFO reverse order and preserves residue on compensation faults", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        stepCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 })),
        failAt: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 6 })),
        compFailMask: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 127 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ stepCount, failAt, compFailMask }) =>
          Effect.gen(function*() {
            const forwardLog: Array<string> = []
            const unwindLog: Array<string> = []
            const shouldFailAt = failAt >= 0 && failAt < stepCount ? failAt : -1

            const steps = Array.from({ length: stepCount }, (_, i) => {
              const id = `s${i}`
              const compFails = ((compFailMask >> i) & 1) === 1
              return {
                id,
                action: () =>
                  Effect.gen(function*() {
                    yield* Effect.yieldNow
                    if (i === shouldFailAt) return yield* Effect.fail(`step-${id}-failed`)
                    forwardLog.push(id)
                    return i
                  }),
                compensation: () =>
                  Effect.gen(function*() {
                    yield* Effect.yieldNow
                    unwindLog.push(id)
                    if (compFails) return yield* Effect.fail(`comp-${id}-failed`)
                  })
              }
            })

            const outcome = yield* Effect.result(Saga.run("input", { steps }))

            if (shouldFailAt === -1) {
              return (
                outcome._tag === "Success" &&
                outcome.success._tag === "Completed" &&
                unwindLog.length === 0 &&
                forwardLog.length === stepCount
              )
            }

            // Every step BEFORE shouldFailAt MUST have run forward AND unwound in exact reverse order.
            const expectedForward = Array.from({ length: shouldFailAt }, (_, i) => `s${i}`)
            const expectedUnwind = [...expectedForward].reverse()
            if (JSON.stringify(forwardLog) !== JSON.stringify(expectedForward)) return false
            if (JSON.stringify(unwindLog) !== JSON.stringify(expectedUnwind)) return false

            const failingComps = expectedUnwind.filter((_, revIdx) => {
              const origIdx = shouldFailAt - 1 - revIdx
              return ((compFailMask >> origIdx) & 1) === 1
            })
            if (failingComps.length > 0) {
              return (
                outcome._tag === "Failure" &&
                outcome.failure instanceof PatternError.PatternError &&
                outcome.failure.code === "compensation_failed"
              )
            }
            return outcome._tag === "Success" && outcome.success._tag === "Compensated"
          }),
        { seed, executions, execution: FuzzSimulation.execution() }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Quarantine.run isolates failing siblings so every member settles under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Array(Schema.Literals(["ok", "fail"]))
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (raw) =>
          Effect.gen(function*() {
            const kinds = raw.length === 0 ? ["ok" as const] : raw.slice(0, 8)
            const members: Record<string, Effect.Effect<number, string>> = {}
            for (let i = 0; i < kinds.length; i++) {
              const kind = kinds[i]!
              members[`k${i}`] = Effect.gen(function*() {
                yield* Effect.yieldNow
                if (kind === "fail") return yield* Effect.fail(`err-${i}`)
                return i
              })
            }
            const settled = yield* Quarantine.run(members, { policy: "quarantine" })
            for (let i = 0; i < kinds.length; i++) {
              const entry = settled[`k${i}`]
              if (entry === undefined) return false
              if (kinds[i] === "ok" && (entry._tag !== "Succeeded" || entry.value !== i)) return false
              if (kinds[i] === "fail" && entry._tag !== "Quarantined") return false
            }
            return true
          }),
        { seed, executions, execution: FuzzSimulation.execution() }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
