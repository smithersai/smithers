import * as Effect from "effect/Effect"
import { describe, test } from "vitest"
import * as Cron from "../src/Cron.ts"
import * as Overlap from "../src/Overlap.ts"

const parsedHourly = Effect.runSync(Cron.parse("0 * * * *", "America/New_York"))
const parsedQuarterHour = Effect.runSync(Cron.parse("*/15 9-17 * * 1-5", "America/New_York"))

const windowStart = new Date("2026-03-07T00:00:00.000Z")
const windowEnd = new Date("2026-03-10T00:00:00.000Z")

const overlapStates: ReadonlyArray<Overlap.State> = [
  { running: false, due: 1_000 },
  { running: true, due: 2_000 },
  { running: true, pending: 1_500, due: 2_500 }
]

describe("triggers hot paths", () => {
  test("Cron.parse timezone-aware expressions", async ({ bench }) => {
    await bench("parse 2 timezone-aware cron expressions", () => {
      Effect.runSync(Cron.parse("0 9 * * 1-5", "America/New_York"))
      Effect.runSync(Cron.parse("*/15 * * * *", "UTC"))
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Cron.occurrencesBetween across DST window", async ({ bench }) => {
    await bench("compute 72 hourly occurrences across US DST boundary", () => {
      Effect.runSync(Cron.occurrencesBetween(parsedHourly, windowStart, windowEnd))
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Cron.next + Overlap.decide", async ({ bench }) => {
    await bench("compute next weekday business-hour occurrence + overlap policies", () => {
      Effect.runSync(Cron.next(parsedQuarterHour, windowStart))
      for (const state of overlapStates) {
        Overlap.decide("skip", state)
        Overlap.decide("buffer-one", state)
        Overlap.decide("supersede", state)
      }
    }).run({ time: 120, warmupTime: 30 })
  })
})
