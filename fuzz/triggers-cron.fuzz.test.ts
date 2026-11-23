import { Cron, Webhook } from "@smthrs/triggers"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"

const ValidCronExpr = Schema.Literals([
  "* * * * *",
  "*/5 * * * *",
  "0 0 * * *",
  "30 2 * * 1-5",
  "15 14 1 * *",
  "0 0 29 2 *",
  "59 23 31 12 *",
  "0,15,30,45 * * * *"
])

describe("@smthrs/triggers Cron & Webhook fuzz", () => {
  it.effect.fuzz(
    "Cron.parse never dies on arbitrary expressions or timezones",
    [Schema.String, Schema.Literals(["UTC", "America/New_York", "Invalid/Zone"])],
    ([expr, tz]) =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(Cron.parse(expr, tz))
        expect(exit._tag === "Success" || exit._tag === "Failure").toBe(true)
        return true
      })
  )

  it.effect.fuzz(
    "Cron.next, previousAtOrBefore, and occurrencesBetween preserve strict monotonicity across dates",
    [
      ValidCronExpr,
      Schema.Int.check(Schema.isBetween({ minimum: 1_577_836_800_000, maximum: 1_893_456_000_000 })),
      Schema.Int.check(Schema.isBetween({ minimum: 60_000, maximum: 86_400_000 * 3 }))
    ],
    ([expr, startMs, spanMs]) =>
      Effect.gen(function*() {
        const cron = yield* Cron.parse(expr, "UTC")
        const from = new Date(startMs)
        const n1 = yield* Cron.next(cron, from)
        const n2 = yield* Cron.next(cron, n1)
        expect(n1.getTime()).toBeGreaterThan(from.getTime())
        expect(n2.getTime()).toBeGreaterThan(n1.getTime())

        const prev = yield* Cron.previousAtOrBefore(cron, from)
        expect(prev.getTime()).toBeLessThanOrEqual(from.getTime())
        const afterPrev = yield* Cron.next(cron, prev)
        expect(afterPrev.getTime()).toBeGreaterThanOrEqual(from.getTime())

        const to = new Date(startMs + spanMs)
        const betweenExit = yield* Effect.exit(Cron.occurrencesBetween(cron, from, to))
        if (betweenExit._tag === "Success") {
          const between = betweenExit.value
          expect(between.length).toBeLessThanOrEqual(Cron.maxOccurrences)
          for (let i = 0; i < between.length; i++) {
            const ts = between[i]!.getTime()
            expect(ts).toBeGreaterThan(from.getTime())
            expect(ts).toBeLessThanOrEqual(to.getTime())
            if (i > 0) expect(ts).toBeGreaterThan(between[i - 1]!.getTime())
          }
        }
        return true
      })
  )

  it.fuzz(
    "Webhook.constantTimeEqual matches exact byte equality across arbitrary slices",
    [
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(Schema.isMaxLength(64)),
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(Schema.isMaxLength(64))
    ],
    ([a, b]) => {
      const ua = Uint8Array.from(a)
      const ub = Uint8Array.from(b)
      const exact = ua.length === ub.length && ua.every((v, i) => v === ub[i])
      expect(Webhook.constantTimeEqual(ua, ub)).toBe(exact)
      expect(Webhook.constantTimeEqual(ub, ua)).toBe(exact)
      expect(Webhook.constantTimeEqual(ua, ua)).toBe(true)
      return true
    }
  )
})
