import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import { describe, expect, it } from "vitest"
import * as DueOccurrences from "../src/internal/DueOccurrences.ts"
import type { Registered } from "../src/TriggerStore.ts"

const hour = 60 * 60 * 1_000
const now = 3.5 * hour
const staleAfter = 5 * 60 * 1_000

const hourly = (overrides: Partial<Registered> = {}): Registered => ({
  id: "hourly",
  flowId: "flow",
  input: null,
  cron: "0 * * * *",
  timezone: "UTC",
  overlap: "skip",
  catchUp: "all",
  maxCatchUp: 3,
  enabled: true,
  revision: 1,
  ...overrides
})

const compute = (trigger: Registered, observed: number | undefined, freshFor = staleAfter) =>
  Effect.runPromise(DueOccurrences.compute(trigger, now, observed, freshFor))

describe("DueOccurrences", () => {
  it("owes nothing on first sight of a trigger that never fired, and starts the watermark at the current boundary", async () => {
    expect(await compute(hourly(), undefined)).toEqual({ occurrences: [], watermark: 3 * hour })
  })

  // A restart across a never-fired trigger's first boundary used to lose it:
  // the new process had no baseline but its own first sight.
  it("owes the boundaries since registration on first sight of a trigger that never fired", async () => {
    expect(await compute(hourly({ registeredAt: 1.5 * hour }), undefined)).toEqual({
      occurrences: [2 * hour, 3 * hour],
      watermark: 3 * hour
    })
    expect(await compute(hourly({ registeredAt: 3.2 * hour }), undefined)).toEqual({
      occurrences: [],
      watermark: 3 * hour
    })
    expect(await compute(hourly({ registeredAt: 0, lastFiredAt: 2 * hour }), undefined)).toEqual({
      occurrences: [3 * hour],
      watermark: 3 * hour
    })
  })

  it("owes the catch-up since lastFiredAt on first sight, current occurrence included", async () => {
    expect(await compute(hourly({ lastFiredAt: 0 }), undefined)).toEqual({
      occurrences: [hour, 2 * hour, 3 * hour],
      watermark: 3 * hour
    })
    expect(await compute(hourly({ lastFiredAt: 0, catchUp: "one" }), undefined)).toEqual({
      occurrences: [3 * hour],
      watermark: 3 * hour
    })
  })

  // Under `none` a restart owes the boundary it crossed only while that
  // boundary is still the present. The 03:00 boundary is half an hour old.
  it("owes the current boundary under catchUp none only while it is no older than staleAfter", async () => {
    for (const observed of [undefined, hour]) {
      const trigger = hourly({ lastFiredAt: 0, catchUp: "none" })
      expect(await compute(trigger, observed, hour)).toEqual({ occurrences: [3 * hour], watermark: 3 * hour })
      expect(await compute(trigger, observed, 30 * 60 * 1_000)).toEqual({
        occurrences: [3 * hour],
        watermark: 3 * hour
      })
      expect(await compute(trigger, observed)).toEqual({ occurrences: [], watermark: 3 * hour })
    }
    expect(await compute(hourly({ lastFiredAt: 3 * hour, catchUp: "none" }), undefined)).toEqual({
      occurrences: [],
      watermark: 3 * hour
    })
  })

  it("owes nothing and keeps the watermark until a new boundary passes", async () => {
    expect(await compute(hourly(), 3 * hour)).toEqual({ occurrences: [], watermark: 3 * hour })
    expect(await compute(hourly(), 4 * hour)).toEqual({ occurrences: [], watermark: 4 * hour })
  })

  it("owes the backlog under the catch-up policy, then the current boundary", async () => {
    expect(await compute(hourly(), hour)).toEqual({ occurrences: [2 * hour, 3 * hour], watermark: 3 * hour })
    expect(await compute(hourly({ catchUp: "none" }), hour, hour)).toEqual({
      occurrences: [3 * hour],
      watermark: 3 * hour
    })
  })

  it("abandons a backlog beyond the bound with a warning, and still owes the current boundary", async () => {
    const warnings: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
    const capture = Logger.make((entry) => {
      warnings.push({ message: entry.message, annotations: entry.fiber.getRef(References.CurrentLogAnnotations) })
    })
    const run = (observed: number | undefined) =>
      Effect.runPromise(
        DueOccurrences.compute(hourly({ lastFiredAt: 0, maxCatchUp: 1 }), now, observed, staleAfter).pipe(
          Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))
        )
      )
    // The bound limits the replayed backlog. The current occurrence fires on
    // the first poll after a restart exactly as on any later poll.
    expect(await run(undefined)).toEqual({ occurrences: [3 * hour], watermark: 3 * hour })
    expect(await run(0)).toEqual({ occurrences: [3 * hour], watermark: 3 * hour })
    expect(warnings).toHaveLength(2)
    for (const warning of warnings) {
      expect(warning.message).toEqual(["A trigger abandoned catch-up work beyond its bound", expect.anything()])
      expect(warning.annotations).toMatchObject({ triggerId: "hourly" })
    }
  })

  // Issue #4905: a weekly trigger last fired Monday 2 March and a host down
  // until Sunday 15 March 20:00. The Monday 9 March run is 6.7 days stale:
  // `none` skips it and moves the watermark past it, `one` still owes it.
  it("skips a stale missed boundary under catchUp none and owes it under one", async () => {
    const weekly = hourly({ cron: "0 3 * * 1", lastFiredAt: Date.parse("2026-03-02T03:00:00.000Z") })
    const restart = Date.parse("2026-03-15T20:00:00.000Z")
    const missed = Date.parse("2026-03-09T03:00:00.000Z")
    const due = (catchUp: Registered["catchUp"]) =>
      Effect.runPromise(DueOccurrences.compute({ ...weekly, catchUp, maxCatchUp: 1 }, restart, undefined, staleAfter))
    expect(await due("none")).toEqual({ occurrences: [], watermark: missed })
    expect(await due("one")).toEqual({ occurrences: [missed], watermark: missed })
  })

  // A scheduler that stalled in-process across boundaries and one that
  // restarted across the same boundaries missed the same occurrences, so the
  // declaration owes the same runs either way. The stalled poll used to leave
  // the current boundary out of the policy: `one` fired two runs, and a bound
  // of 2 fired three.
  it("owes the same occurrences after a stall as after a restart across the same boundaries", async () => {
    const cases: ReadonlyArray<readonly [Partial<Registered>, ReadonlyArray<number>]> = [
      [{ catchUp: "one" }, [3 * hour]],
      [{ catchUp: "none" }, []],
      [{ catchUp: "all", maxCatchUp: 3 }, [hour, 2 * hour, 3 * hour]],
      [{ catchUp: "all", maxCatchUp: 2 }, [3 * hour]]
    ]
    for (const [declaration, owed] of cases) {
      const restarted = await compute(hourly({ ...declaration, lastFiredAt: 0 }), undefined)
      const stalled = await compute(hourly(declaration), 0)
      expect(restarted).toEqual({ occurrences: owed, watermark: 3 * hour })
      expect(stalled).toEqual(restarted)
    }
  })

  // Only the boundary that just passed is due: nothing was missed, so the
  // catch-up bound has nothing to refuse and no warning is owed.
  it("owes a lone passed boundary without consulting the catch-up bound", async () => {
    const warnings: Array<unknown> = []
    const capture = Logger.make((entry) => {
      warnings.push(entry.message)
    })
    const run = (trigger: Registered, observed: number | undefined) =>
      Effect.runPromise(
        DueOccurrences.compute(trigger, now, observed, staleAfter).pipe(
          Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))
        )
      )
    for (const catchUp of ["one", "all"] as const) {
      const trigger = hourly({ catchUp, maxCatchUp: 0 })
      expect(await run(trigger, 2 * hour)).toEqual({ occurrences: [3 * hour], watermark: 3 * hour })
      expect(await run({ ...trigger, lastFiredAt: 2 * hour }, undefined)).toEqual({
        occurrences: [3 * hour],
        watermark: 3 * hour
      })
    }
    expect(warnings).toEqual([])
  })

  // Reading a zero bound as one is only for a lone boundary. Once an earlier
  // boundary was missed too, a bound of zero refuses the backlog as stated.
  it("abandons a real backlog under a bound of zero and still owes the current boundary", async () => {
    const warnings: Array<unknown> = []
    const capture = Logger.make((entry) => {
      warnings.push(entry.message)
    })
    const run = (trigger: Registered, observed: number | undefined) =>
      Effect.runPromise(
        DueOccurrences.compute(trigger, now, observed, staleAfter).pipe(
          Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))
        )
      )
    for (const catchUp of ["one", "all"] as const) {
      const trigger = hourly({ catchUp, maxCatchUp: 0 })
      expect(await run(trigger, hour)).toEqual({ occurrences: [3 * hour], watermark: 3 * hour })
      expect(await run({ ...trigger, lastFiredAt: hour }, undefined)).toEqual({
        occurrences: [3 * hour],
        watermark: 3 * hour
      })
    }
    expect(warnings).toHaveLength(4)
  })

  it("passes on every catch-up failure other than an exceeded bound", async () => {
    // One past the greatest safe bound is not a safe search limit, so the
    // occurrence search refuses it with `invalid_options` on either poll.
    const unsearchable = hourly({ lastFiredAt: 0, maxCatchUp: Number.MAX_SAFE_INTEGER })
    for (const observed of [undefined, 0]) {
      const error = await Effect.runPromise(
        Effect.flip(DueOccurrences.compute(unsearchable, now, observed, staleAfter))
      )
      expect(error).toMatchObject({ code: "invalid_options", path: "limit" })
    }
  })
})
