import * as EffectCron from "effect/Cron"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import * as Cron from "../src/Cron.ts"

// A cron the field parser accepts and the calendar never reaches. Building it
// by hand is the only way to reach the search paths, because `parse` now
// refuses the expression.
const unsatisfiable = (): Cron.Cron => {
  const parsed = EffectCron.parse("0 0 30 2 *")
  if (Result.isFailure(parsed)) throw new Error("February 30 must parse as fields")
  return { expression: "0 0 30 2 *", value: parsed.success }
}

describe("Cron", () => {
  it("uses Effect cron timezone scheduling", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 9 * * *", "America/New_York"))
    const occurrence = await Effect.runPromise(Cron.next(cron, new Date("2026-01-01T13:00:00.000Z")))
    expect(occurrence.toISOString()).toBe("2026-01-01T14:00:00.000Z")
  })

  it("reports invalid expressions as typed errors", async () => {
    const exit = await Effect.runPromiseExit(Cron.parse("not cron"))
    expect(exit._tag).toBe("Failure")
  })

  it("selects only occurrences within the requested interval", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    expect(
      await Effect.runPromise(
        Cron.occurrencesBetween(cron, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T02:00:00.000Z"))
      )
    ).toEqual([
      new Date("2026-01-01T01:00:00.000Z"),
      new Date("2026-01-01T02:00:00.000Z")
    ])
  })

  it("refuses a parseable expression the calendar never satisfies", async () => {
    const error = await Effect.runPromise(Effect.flip(Cron.parse("0 0 30 2 *")))
    expect(error.code).toBe("unsatisfiable_cron")
    expect(await Effect.runPromise(Effect.flip(Cron.parse("0 0 31 4 *")))).toMatchObject({
      code: "unsatisfiable_cron"
    })
  })

  it("reports an exhausted occurrence search as a typed failure, never a defect", async () => {
    const cron = unsatisfiable()
    const at = new Date("2026-01-01T00:00:00.000Z")
    expect(await Effect.runPromise(Effect.flip(Cron.next(cron, at)))).toMatchObject({
      code: "unsatisfiable_cron"
    })
    expect(await Effect.runPromise(Effect.flip(Cron.previousAtOrBefore(cron, at)))).toMatchObject({
      code: "unsatisfiable_cron"
    })
    expect(await Effect.runPromise(Effect.flip(Cron.occurrencesBetween(cron, at, at)))).toMatchObject({
      code: "unsatisfiable_cron"
    })
  })

  it("tests the cap before it pushes, so a limit of zero returns nothing", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    const from = new Date("2026-01-01T00:00:00.000Z")
    const to = new Date("2026-01-01T05:00:00.000Z")
    expect(await Effect.runPromise(Cron.occurrencesBetween(cron, from, to, 0))).toEqual([])
    expect(await Effect.runPromise(Cron.occurrencesBetween(cron, from, to, 1))).toEqual([
      new Date("2026-01-01T01:00:00.000Z")
    ])
    expect(await Effect.runPromise(Cron.occurrencesBetween(cron, from, to, 5))).toHaveLength(5)
    expect(await Effect.runPromise(Cron.occurrencesBetween(cron, from, to, 6))).toHaveLength(5)
  })

  // A limit that is not a count used to disable the cap rather than be refused,
  // so `NaN` searched without a bound at all.
  it("refuses a limit that is not a non-negative safe integer", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    const from = new Date("2026-01-01T00:00:00.000Z")
    const to = new Date("2026-01-01T05:00:00.000Z")
    for (const limit of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY]) {
      const error = await Effect.runPromise(Effect.flip(Cron.occurrencesBetween(cron, from, to, limit)))
      expect(error).toMatchObject({ code: "invalid_options", path: "limit" })
      expect(error.message).toContain(String(limit))
    }
  })

  it("fails when an unstated limit would exceed maxOccurrences", async () => {
    const cron = await Effect.runPromise(Cron.parse("* * * * *", "UTC"))
    const from = new Date("2026-01-01T00:00:00.000Z")
    const to = new Date("2026-01-03T00:00:00.000Z")
    const error = await Effect.runPromise(Effect.flip(Cron.occurrencesBetween(cron, from, to)))
    expect(error).toMatchObject({ code: "catch_up_bound_exceeded" })
    expect(error.message).toContain(String(Cron.maxOccurrences))
  })

  it("returns an interval holding exactly maxOccurrences", async () => {
    const cron = await Effect.runPromise(Cron.parse("* * * * *", "UTC"))
    const from = new Date("2026-01-01T00:00:00.000Z")
    const to = new Date(from.getTime() + Cron.maxOccurrences * 60_000)
    const occurrences = await Effect.runPromise(Cron.occurrencesBetween(cron, from, to))
    expect(occurrences).toHaveLength(Cron.maxOccurrences)
  })

  // The occurrence is the boundary instant, never the sub-second offset the
  // caller happened to observe it at, so an idempotency key derived from it is
  // the same for every observer of the same tick.
  it("zeroes milliseconds when the instant itself matches", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    const matching = new Date("2026-01-01T01:00:00.000Z")
    matching.setMilliseconds(457)
    const occurrence = await Effect.runPromise(Cron.previousAtOrBefore(cron, matching))
    expect(occurrence.toISOString()).toBe("2026-01-01T01:00:00.000Z")
  })

  it("keeps the parsed timezone beside the expression it came from", async () => {
    const zoned = await Effect.runPromise(Cron.parse("0 9 * * *", "America/New_York"))
    const naive = await Effect.runPromise(Cron.parse("0 9 * * *"))
    expect(zoned).toMatchObject({ expression: "0 9 * * *", timezone: "America/New_York" })
    expect("timezone" in naive).toBe(false)
  })
})
