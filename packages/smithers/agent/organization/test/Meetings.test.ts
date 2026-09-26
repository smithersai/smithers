import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as Meetings from "../src/Meetings.ts"
import { err, ok } from "./support.ts"

const utc = (text: string): number => Date.parse(text)
const iso = (ms: number): string => new Date(ms).toISOString()

const weekly = (patch: Partial<Meetings.WeeklyRequest> = {}): Meetings.WeeklyRequest => ({
  seriesId: "weekly-one-on-ones",
  timezone: "America/Los_Angeles",
  weekday: 5,
  start: "09:00",
  slotMinutes: 30,
  order: ["assistant", "lead", "builder", "checker"],
  firstDate: "2026-09-25",
  ...patch
})

const code = (request: Meetings.WeeklyRequest) => err(Meetings.planWeekly(request)).code

describe("Meetings.planWeekly", () => {
  it("plans one contiguous block with one weekly event per principal", () => {
    const plan = ok(Meetings.planWeekly(weekly()))
    expect(plan).toMatchObject({
      seriesId: "weekly-one-on-ones",
      timezone: "America/Los_Angeles",
      weekday: 5,
      firstDate: "2026-09-25",
      slotMinutes: 30,
      blockStart: "09:00",
      blockEnd: "11:00"
    })
    expect(plan.slots[1]).toEqual({
      principal: "lead",
      startLocal: "09:30",
      endLocal: "10:00",
      eventKey: "weekly-one-on-ones/lead",
      rrule: "FREQ=WEEKLY;BYDAY=FR",
      dtstartLocal: "2026-09-25T09:30:00",
      timezone: "America/Los_Angeles"
    })
    expect(plan.slots.map((slot) => slot.startLocal)).toEqual(["09:00", "09:30", "10:00", "10:30"])
    const days = [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
      ok(Meetings.planWeekly(weekly({ weekday, firstDate: `2026-09-${String(20 + weekday).padStart(2, "0")}` })))
        .slots[0]!.rrule
    )
    expect(days).toEqual(["MO", "TU", "WE", "TH", "FR", "SA", "SU"].map((day) => `FREQ=WEEKLY;BYDAY=${day}`))
  })

  it("requires the first date to fall on the weekday", () => {
    expect(code(weekly({ firstDate: "2026-09-24" }))).toBe("wrong-weekday")
    expect(code(weekly({ weekday: 7 }))).toBe("wrong-weekday")
  })

  it("refuses malformed requests, unknown zones, and empty or repeated orders", () => {
    expect(code(weekly({ firstDate: "2026-02-30" }))).toBe("invalid-request")
    expect(code(weekly({ firstDate: "2026-9-25" }))).toBe("invalid-request")
    expect(code(weekly({ start: "24:00" }))).toBe("invalid-request")
    expect(code(weekly({ weekday: 8 }))).toBe("invalid-request")
    expect(code(weekly({ slotMinutes: 0 }))).toBe("invalid-request")
    expect(code(weekly({ seriesId: "a/b" }))).toBe("invalid-request")
    expect(code({ ...weekly(), extra: true } as Meetings.WeeklyRequest)).toBe("invalid-request")
    expect(code(weekly({ order: [] }))).toBe("invalid-request")
    expect(err(Meetings.planWeekly(weekly({ order: ["lead", "builder", "lead"] })))).toMatchObject({
      code: "duplicate-principal",
      message: "lead appears twice"
    })
    expect(code(weekly({ timezone: "Mars/Olympus_Mons" }))).toBe("unknown-timezone")
    expect(err(Meetings.planWeekly(weekly({ timezone: "Mars/Olympus_Mons" })))).toBeInstanceOf(Meetings.MeetingError)
  })

  it("refuses blocks longer than a day or ending at or after midnight", () => {
    expect(code(weekly({ slotMinutes: 600, order: ["a", "b", "c"] }))).toBe("too-long")
    expect(code(weekly({ start: "23:00", slotMinutes: 30, order: ["a", "b"] }))).toBe("crosses-midnight")
    expect(code(weekly({ start: "00:00", slotMinutes: 1440, order: ["a"] }))).toBe("crosses-midnight")
    expect(code(weekly({ start: "22:30", slotMinutes: 45, order: ["a", "b"] }))).toBe("crosses-midnight")
    const late = ok(Meetings.planWeekly(weekly({ start: "23:00", slotMinutes: 59, order: ["a"] })))
    expect(late.blockEnd).toBe("23:59")
  })

  it("refuses a slot boundary in a daylight-saving gap within the horizon", () => {
    // 2027-03-14 02:00-02:59 does not exist in Los Angeles or New York.
    for (const timezone of ["America/Los_Angeles", "America/New_York"]) {
      const inGap = err(Meetings.planWeekly(weekly({ timezone, weekday: 7, firstDate: "2026-09-27", start: "02:30" })))
      expect(inGap).toMatchObject({ code: "nonexistent-local-time" })
      expect(inGap.message).toBe(`2027-03-14 02:30 does not exist in ${timezone}`)
    }
    // Only the end boundary lands in the gap.
    expect(
      err(Meetings.planWeekly(weekly({ weekday: 7, firstDate: "2026-09-27", start: "01:00", order: ["a", "b"] })))
        .message
    ).toBe("2027-03-14 02:00 does not exist in America/Los_Angeles")
    // Ending exactly as the gap starts is refused too (the end is a boundary); ending before it is fine.
    expect(
      ok(
        Meetings.planWeekly(
          weekly({ weekday: 7, firstDate: "2026-09-27", start: "01:00", slotMinutes: 59, order: ["a"] })
        )
      )
        .blockEnd
    ).toBe("01:59")
    // A zone without daylight saving never refuses.
    expect(
      ok(Meetings.planWeekly(weekly({ timezone: "Asia/Tokyo", weekday: 7, firstDate: "2026-09-27", start: "02:30" })))
        .timezone
    ).toBe("Asia/Tokyo")
    // The gap is checked from the first date forward, a whole year ahead.
    expect(code(weekly({ weekday: 7, firstDate: "2026-03-15", start: "02:30" }))).toBe("nonexistent-local-time")
  })
})

describe("Meetings.occurrences", () => {
  const range = (plan: Meetings.WeeklyPlan, from: string, to: string) =>
    ok(Meetings.occurrences(plan, utc(from), utc(to)))

  it("keeps Friday 09:00 local across both 2026 transitions in Los Angeles and New York", () => {
    const cases = [
      { timezone: "America/Los_Angeles", standard: 17, daylight: 16 },
      { timezone: "America/New_York", standard: 14, daylight: 13 }
    ]
    for (const { daylight, standard, timezone } of cases) {
      const plan = ok(Meetings.planWeekly(weekly({ timezone, firstDate: "2026-02-27", order: ["lead"] })))
      const found = range(plan, "2026-02-27T00:00:00Z", "2026-11-14T00:00:00Z")
      const byDate = new Map(found.map((occurrence) => [occurrence.localDate, occurrence]))
      const hour = (date: string) => new Date(byDate.get(date)!.startMs).getUTCHours()
      // Spring forward on Sunday 2026-03-08; fall back on Sunday 2026-11-01.
      expect([hour("2026-03-06"), hour("2026-03-13"), hour("2026-10-30"), hour("2026-11-06")], timezone).toEqual([
        standard,
        daylight,
        daylight,
        standard
      ])
      expect(found.every((occurrence) => occurrence.startLocal === "09:00")).toBe(true)
      expect(found.every((occurrence) => occurrence.endMs - occurrence.startMs === 30 * 60_000)).toBe(true)
      expect(found).toHaveLength(38)
    }
  })

  it("resolves a repeated fall-back time to the earlier instant and keeps real slot length", () => {
    const plan = ok(Meetings.planWeekly(weekly({
      weekday: 7,
      firstDate: "2026-10-25",
      start: "01:00",
      slotMinutes: 29,
      order: ["a", "b"],
      timezone: "America/New_York"
    })))
    // Every boundary (01:00, 01:29, 01:58) exists on the spring-forward Sunday too.
    expect(plan.blockEnd).toBe("01:58")
    const found = range(plan, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z")
    expect(found.map((occurrence) => [occurrence.principal, iso(occurrence.startMs), iso(occurrence.endMs)])).toEqual([
      // 01:00 happens twice; the EDT one (UTC-4) is chosen.
      ["a", "2026-11-01T05:00:00.000Z", "2026-11-01T05:29:00.000Z"],
      // 01:29 also happens twice; the EDT one is chosen and the slot lasts 29 real minutes.
      ["b", "2026-11-01T05:29:00.000Z", "2026-11-01T05:58:00.000Z"]
    ])
  })

  it("gives the same occurrence keys for the same meetings over any range", () => {
    const plan = ok(Meetings.planWeekly(weekly()))
    const whole = range(plan, "2026-09-01T00:00:00Z", "2026-11-01T00:00:00Z")
    const first = range(plan, "2026-09-01T00:00:00Z", "2026-10-10T00:00:00Z")
    const second = range(plan, "2026-10-10T00:00:00Z", "2026-11-01T00:00:00Z")
    expect([...first, ...second].map((occurrence) => occurrence.occurrenceKey)).toEqual(
      whole.map((occurrence) => occurrence.occurrenceKey)
    )
    expect(whole[0]).toEqual({
      principal: "assistant",
      eventKey: "weekly-one-on-ones/assistant",
      occurrenceKey: "weekly-one-on-ones/assistant@2026-09-25",
      localDate: "2026-09-25",
      startLocal: "09:00",
      startMs: utc("2026-09-25T16:00:00Z"),
      endMs: utc("2026-09-25T16:30:00Z")
    })
    expect(Meetings.occurrenceKey("s/p", "2026-01-02")).toBe("s/p@2026-01-02")
    // The range is half-open and ordered by start.
    const exact = range(plan, "2026-09-25T16:30:00Z", "2026-09-25T17:30:00Z")
    expect(exact.map((occurrence) => occurrence.principal)).toEqual(["lead", "builder"])
    // Starting long after the first date skips straight to the range.
    expect(range(plan, "2036-09-01T00:00:00Z", "2036-09-06T00:00:00Z")).toHaveLength(4)
    expect(range(plan, "2026-09-26T00:00:00Z", "2026-10-02T00:00:00Z")).toEqual([])
  })

  it("refuses invalid ranges, unknown zones, and a gap reached during expansion", () => {
    const plan = ok(Meetings.planWeekly(weekly()))
    for (const [from, to] of [[1, 1], [2, 1], [Number.NaN, 1], [0, Number.POSITIVE_INFINITY]]) {
      expect(err(Meetings.occurrences(plan, from!, to!)).code).toBe("invalid-range")
    }
    expect(err(Meetings.occurrences(plan, 0, (Meetings.maxExpansionWeeks + 1) * 7 * 86_400_000)).code).toBe(
      "invalid-range"
    )
    expect(err(Meetings.occurrences({ ...plan, timezone: "Nowhere/None" }, 0, 1)).code).toBe("unknown-timezone")
    // A plan built by hand (or by an older runtime) can still reach a gap.
    const handmade: Meetings.WeeklyPlan = {
      ...ok(
        Meetings.planWeekly(
          weekly({ timezone: "Asia/Tokyo", weekday: 7, firstDate: "2026-09-27", start: "02:30", order: ["a"] })
        )
      ),
      timezone: "America/Los_Angeles"
    }
    expect(err(Meetings.occurrences(handmade, utc("2027-03-01T00:00:00Z"), utc("2027-03-20T00:00:00Z")))).toMatchObject(
      {
        code: "nonexistent-local-time",
        message: "2027-03-14 02:30 does not exist in America/Los_Angeles"
      }
    )
  })
})

describe("Meetings.conflicts", () => {
  it("pairs overlapping intervals and ignores touching ones", () => {
    const a = { startMs: 0, endMs: 10, id: "a" }
    const b = { startMs: 10, endMs: 20, id: "b" }
    const busy = [{ startMs: 5, endMs: 10, id: "x" }, { startMs: 20, endMs: 30, id: "y" }, {
      startMs: 0,
      endMs: 30,
      id: "z"
    }]
    expect(Meetings.conflicts([a, b], busy).map(({ busy, interval }) => `${interval.id}:${busy.id}`)).toEqual([
      "a:x",
      "a:z",
      "b:z"
    ])
    expect(Meetings.conflicts([a], [])).toEqual([])
  })
})

describe("Meetings.findSlot", () => {
  const request = (patch: Partial<Meetings.FindSlotRequest> = {}): Meetings.FindSlotRequest => ({
    busy: [],
    durationMinutes: 30,
    timezone: "America/Los_Angeles",
    window: { weekdays: [1, 2, 3, 4, 5], startLocal: "09:00", endLocal: "17:00" },
    afterMs: utc("2026-09-25T15:00:00Z"),
    horizonDays: 14,
    granularityMinutes: 15,
    ...patch
  })
  const found = (patch: Partial<Meetings.FindSlotRequest> = {}) =>
    Option.getOrThrow(ok(Meetings.findSlot(request(patch))))

  it("returns the first free grid slot after afterMs", () => {
    expect(found()).toEqual({
      startMs: utc("2026-09-25T16:00:00Z"),
      endMs: utc("2026-09-25T16:30:00Z"),
      localDate: "2026-09-25",
      startLocal: "09:00"
    })
    // 09:05 local rounds up to the next grid start.
    expect(found({ afterMs: utc("2026-09-25T16:05:00Z") }).startLocal).toBe("09:15")
  })

  it("skips busy intervals, weekends, and the end of the window", () => {
    const busy = [
      { startMs: utc("2026-09-25T16:00:00Z"), endMs: utc("2026-09-25T20:00:00Z") },
      { startMs: utc("2026-09-25T20:15:00Z"), endMs: utc("2026-09-26T00:00:00Z") }
    ]
    // Friday 13:00-13:15 is free but too short; 16:45 would run past 17:00; the weekend is outside the window.
    expect(found({ busy })).toMatchObject({ localDate: "2026-09-28", startLocal: "09:00" })
    expect(found({ busy, durationMinutes: 15 })).toMatchObject({ localDate: "2026-09-25", startLocal: "13:00" })
    expect(found({ window: { weekdays: [6], startLocal: "10:00", endLocal: "10:30" } })).toMatchObject({
      localDate: "2026-09-26",
      startLocal: "10:00"
    })
  })

  it("returns none when nothing fits within the horizon", () => {
    const busy = [{ startMs: 0, endMs: utc("2027-01-01T00:00:00Z") }]
    expect(Option.isNone(ok(Meetings.findSlot(request({ busy }))))).toBe(true)
    expect(Option.isNone(ok(Meetings.findSlot(request({ durationMinutes: 481 }))))).toBe(true)
  })

  it("skips starts in a daylight-saving gap and never runs past a closing time in one", () => {
    const sunday = { weekdays: [7], startLocal: "01:00", endLocal: "04:00" }
    const afterMs = utc("2026-03-08T08:00:00Z") // 00:00 PST
    const busy = [{ startMs: utc("2026-03-08T09:00:00Z"), endMs: utc("2026-03-08T10:00:00Z") }]
    // 01:00 and 01:30 PST are busy; 02:00 and 02:30 do not exist; 03:00 PDT is the next start.
    expect(found({ busy, afterMs, window: sunday, horizonDays: 1, granularityMinutes: 30, durationMinutes: 60 }))
      .toEqual({
        startMs: utc("2026-03-08T10:00:00Z"),
        endMs: utc("2026-03-08T11:00:00Z"),
        localDate: "2026-03-08",
        startLocal: "03:00"
      })
    // A 02:30 close does not exist that day; it resolves conservatively to 01:30 PST, one gap length early.
    const closingInGap = { weekdays: [7], startLocal: "01:00", endLocal: "02:30" }
    const inGap = { afterMs, window: closingInGap, horizonDays: 1, granularityMinutes: 30 }
    expect(found({ ...inGap, durationMinutes: 30 })).toMatchObject({
      startLocal: "01:00",
      endMs: utc("2026-03-08T09:30:00Z")
    })
    expect(Option.isNone(ok(Meetings.findSlot(request({ ...inGap, durationMinutes: 60 }))))).toBe(true)
  })

  it("refuses invalid requests and unknown zones", () => {
    const invalid: ReadonlyArray<Partial<Meetings.FindSlotRequest>> = [
      { durationMinutes: 0 },
      { durationMinutes: 1441 },
      { durationMinutes: 1.5 },
      { granularityMinutes: 0 },
      { horizonDays: Meetings.maxHorizonDays + 1 },
      { afterMs: Number.NaN },
      { window: { weekdays: [1], startLocal: "9:00", endLocal: "17:00" } },
      { window: { weekdays: [1], startLocal: "09:00", endLocal: "25:00" } },
      { window: { weekdays: [1], startLocal: "17:00", endLocal: "09:00" } },
      { window: { weekdays: [], startLocal: "09:00", endLocal: "17:00" } },
      { window: { weekdays: [0], startLocal: "09:00", endLocal: "17:00" } }
    ]
    for (const patch of invalid) {
      expect(err(Meetings.findSlot(request(patch))).code, JSON.stringify(patch)).toBe("invalid-request")
    }
    expect(err(Meetings.findSlot(request({ timezone: "Nowhere/None" }))).code).toBe("unknown-timezone")
  })
})
