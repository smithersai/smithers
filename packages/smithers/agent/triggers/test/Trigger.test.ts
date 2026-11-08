import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Schedule from "../src/Schedule.ts"
import * as Trigger from "../src/Trigger.ts"

describe("Trigger", () => {
  const declaration = (input: unknown) => ({
    id: "daily",
    flowId: "flow",
    input,
    cron: "0 0 * * *",
    maxCatchUp: 0,
    enabled: true
  })

  it("decodes policy defaults", () => {
    const trigger = Schema.decodeUnknownSync(Trigger.Trigger)({
      id: "nightly",
      flowId: "flow",
      input: { ok: true },
      cron: "0 0 * * *",
      maxCatchUp: 2,
      enabled: true
    })
    expect(trigger.overlap).toBe("skip")
    expect(trigger.catchUp).toBe("none")
  })

  it("shares policy defaults with standalone schedules", () => {
    const schedule = Schema.decodeUnknownSync(Schedule.Schedule)({
      cron: "0 0 * * *",
      maxCatchUp: 2
    })
    expect(schedule).toMatchObject({ overlap: "skip", catchUp: "none" })
  })

  it("maps public decode failures to stable trigger errors", async () => {
    const schedule = await Effect.runPromise(Effect.flip(Schedule.make({ cron: "", maxCatchUp: -1 })))
    const trigger = await Effect.runPromise(Effect.flip(Trigger.make({})))
    expect(schedule.code).toBe("invalid_schedule")
    expect(trigger.code).toBe("invalid_trigger")
  })

  it("refuses every non-JSON input at the declaration boundary", async () => {
    for (
      const input of [
        undefined,
        { n: Number.NaN },
        new Date("2026-01-01T00:00:00.000Z"),
        () => undefined,
        { nested: { value: undefined } }
      ]
    ) {
      const error = await Effect.runPromise(Effect.flip(Trigger.make(declaration(input))))
      expect(error).toMatchObject({ code: "invalid_trigger", path: "input" })
    }
  })

  // February 30 passes every field range check and never arrives. Refusing it
  // here is what keeps the scheduler's occurrence search from exhausting its
  // bound on a tick, which is a defect the supervising fiber cannot recover.
  it("refuses a declared cron the calendar never satisfies", async () => {
    const schedule = await Effect.runPromise(
      Effect.flip(Schedule.make({ cron: "0 0 30 2 *", maxCatchUp: 0 }))
    )
    const trigger = await Effect.runPromise(
      Effect.flip(
        Trigger.make({
          id: "february-30",
          flowId: "flow",
          input: {},
          cron: "0 0 30 2 *",
          maxCatchUp: 0,
          enabled: true
        })
      )
    )
    expect(schedule.code).toBe("unsatisfiable_cron")
    expect(trigger.code).toBe("unsatisfiable_cron")
  })
})
