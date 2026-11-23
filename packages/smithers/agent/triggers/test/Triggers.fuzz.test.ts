import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Cron } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/triggers Cron fuzz invariants", () => {
  it("Cron.parse never throws defects on arbitrary garbage expressions", async () => {
    const arb = Arbitrary.schema(
      Schema.Tuple([Schema.String, Schema.Literals(["UTC", "America/Los_Angeles", "Invalid/Zone"])])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ([expr, tz]) =>
          Effect.map(
            Effect.result(Cron.parse(expr, tz)),
            (res) => Result.isSuccess(res) || res.failure._tag === "flows/triggers/TriggerError"
          ),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Cron.next is strictly monotonic and consistent with previousAtOrBefore and occurrencesBetween", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        minute: Schema.Literals(["*", "0", "15", "*/5", "0,30"]),
        hour: Schema.Literals(["*", "0", "12", "*/6"]),
        dom: Schema.Literals(["*", "1", "15"]),
        month: Schema.Literals(["*", "1", "6"]),
        dow: Schema.Literals(["*", "1", "1-5"]),
        epochSec: Schema.Int.check(Schema.isBetween({ minimum: 1_700_000_000, maximum: 1_800_000_000 })),
        windowMins: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 720 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ minute, hour, dom, month, dow, epochSec, windowMins }) =>
          Effect.gen(function*() {
            const cron = yield* Cron.parse(`${minute} ${hour} ${dom} ${month} ${dow}`, "UTC")
            const from = new Date(epochSec * 1000)
            const t1 = yield* Cron.next(cron, from)
            if (!(t1.getTime() > from.getTime())) return false
            const t2 = yield* Cron.next(cron, t1)
            if (!(t2.getTime() > t1.getTime())) return false
            const prev = yield* Cron.previousAtOrBefore(cron, t1)
            if (prev.getTime() !== t1.getTime()) return false
            const to = new Date(from.getTime() + windowMins * 60_000)
            const between = yield* Cron.occurrencesBetween(cron, from, to)
            if (between.length > Cron.maxOccurrences) return false
            for (let i = 0; i < between.length; i++) {
              const cur = between[i]!.getTime()
              if (cur < from.getTime() || cur > to.getTime()) return false
              if (i > 0 && !(between[i - 1]!.getTime() < cur)) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
