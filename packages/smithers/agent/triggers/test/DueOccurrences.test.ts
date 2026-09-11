import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import { describe, expect, it } from "vitest"
import * as DueOccurrences from "../src/internal/DueOccurrences.ts"
import type { Registered } from "../src/TriggerStore.ts"

const hour = 60 * 60 * 1_000
const now = 3.5 * hour

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

const compute = (trigger: Registered, observed: number | undefined) =>
  Effect.runPromise(DueOccurrences.compute(trigger, now, observed))

describe("DueOccurrences", () => {
  it("owes nothing on first sight of a trigger that never fired, and starts the watermark at the current boundary", async () => {
    expect(await compute(hourly(), undefined)).toEqual({ occurrences: [], watermark: 3 * hour })
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

  it("owes nothing and keeps the watermark until a new boundary passes", async () => {
    expect(await compute(hourly(), 3 * hour)).toEqual({ occurrences: [], watermark: 3 * hour })
    expect(await compute(hourly(), 4 * hour)).toEqual({ occurrences: [], watermark: 4 * hour })
  })

  it("owes the backlog under the catch-up policy, then the current boundary", async () => {
    expect(await compute(hourly(), hour)).toEqual({ occurrences: [2 * hour, 3 * hour], watermark: 3 * hour })
    expect(await compute(hourly({ catchUp: "none" }), hour)).toEqual({ occurrences: [3 * hour], watermark: 3 * hour })
  })

  it("abandons a backlog beyond the bound with a warning, and still owes the current boundary after the first poll", async () => {
    const warnings: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
    const capture = Logger.make((entry) => {
      warnings.push({ message: entry.message, annotations: entry.fiber.getRef(References.CurrentLogAnnotations) })
    })
    const run = (observed: number | undefined) =>
      Effect.runPromise(
        DueOccurrences.compute(hourly({ lastFiredAt: 0, maxCatchUp: 1 }), now, observed).pipe(
          Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))
        )
      )
    // The first poll's owed list includes the current occurrence, so the
    // abandoned list takes it too; a subsequent poll owes the boundary alone.
    expect(await run(undefined)).toEqual({ occurrences: [], watermark: 3 * hour })
    expect(await run(0)).toEqual({ occurrences: [3 * hour], watermark: 3 * hour })
    expect(warnings).toHaveLength(2)
    for (const warning of warnings) {
      expect(warning.message).toEqual(["A trigger abandoned catch-up work beyond its bound", expect.anything()])
      expect(warning.annotations).toMatchObject({ triggerId: "hourly" })
    }
  })

  it("passes on every catch-up failure other than an exceeded bound", async () => {
    // One past the greatest safe bound is not a safe search limit, so the
    // occurrence search refuses it with `invalid_options` on either poll.
    const unsearchable = hourly({ lastFiredAt: 0, maxCatchUp: Number.MAX_SAFE_INTEGER })
    for (const observed of [undefined, 0]) {
      const error = await Effect.runPromise(Effect.flip(DueOccurrences.compute(unsearchable, now, observed)))
      expect(error).toMatchObject({ code: "invalid_options", path: "limit" })
    }
  })
})
