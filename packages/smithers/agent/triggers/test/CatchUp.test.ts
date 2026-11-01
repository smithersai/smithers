import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as CatchUp from "../src/CatchUp.vibe"
import * as Cron from "../src/Cron.ts"

describe("CatchUp", () => {
  const from = new Date("2026-01-01T00:00:00.000Z")
  const now = new Date("2026-01-01T03:00:00.000Z")

  it("implements none, one, and all chronologically", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    expect(await Effect.runPromise(CatchUp.occurrences("none", 3, from, now, cron))).toEqual([])
    expect(await Effect.runPromise(CatchUp.occurrences("one", 3, from, now, cron))).toEqual([
      new Date("2026-01-01T03:00:00.000Z")
    ])
    expect(await Effect.runPromise(CatchUp.occurrences("all", 3, from, now, cron))).toEqual([
      new Date("2026-01-01T01:00:00.000Z"),
      new Date("2026-01-01T02:00:00.000Z"),
      new Date("2026-01-01T03:00:00.000Z")
    ])
  })

  it("bounds all catch-up work", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    const exit = await Effect.runPromiseExit(CatchUp.occurrences("all", 2, from, now, cron))
    expect(exit._tag).toBe("Failure")
  })

  // The bound is a statement about the declaration, so it is checked before any
  // policy branch. It used to sit after the `none` and never-fired early
  // returns, which silently accepted an unusable bound on both paths.
  it("refuses an unusable bound before any policy branch", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    for (const bound of [Number.NaN, 1.5, -1]) {
      for (const [policy, lastFired] of [["none", from], ["all", undefined], ["one", from]] as const) {
        const error = await Effect.runPromise(
          Effect.flip(CatchUp.occurrences(policy, bound, lastFired, now, cron))
        )
        expect(error).toMatchObject({ code: "catch_up_bound_exceeded", path: "maxCatchUp" })
      }
    }
  })

  // `one` answers to `maxCatchUp` exactly as `all` does: a bound of zero says
  // no occurrence may be caught up, so owing one is over the bound.
  it("bounds the one policy by maxCatchUp", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    const error = await Effect.runPromise(Effect.flip(CatchUp.occurrences("one", 0, from, now, cron)))
    expect(error).toMatchObject({ code: "catch_up_bound_exceeded" })
    expect(error.message).toContain("missed 1 occurrence")
    expect(await Effect.runPromise(CatchUp.occurrences("one", 1, from, now, cron))).toEqual([now])
  })

  it("owes nothing when the latest occurrence is the one already fired", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    expect(await Effect.runPromise(CatchUp.occurrences("one", 0, now, now, cron))).toEqual([])
    expect(await Effect.runPromise(CatchUp.occurrences("all", 0, now, now, cron))).toEqual([])
  })

  it("owes nothing for a trigger that has never fired", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    expect(await Effect.runPromise(CatchUp.occurrences("all", 3, undefined, now, cron))).toEqual([])
    expect(await Effect.runPromise(CatchUp.occurrences("one", 3, undefined, now, cron))).toEqual([])
  })

  it("names the bound it exceeded", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    const error = await Effect.runPromise(Effect.flip(CatchUp.occurrences("all", 2, from, now, cron)))
    expect(error).toMatchObject({ code: "catch_up_bound_exceeded" })
    expect(error.message).toBe("missed 3 occurrences; maxCatchUp is 2")
  })
})
