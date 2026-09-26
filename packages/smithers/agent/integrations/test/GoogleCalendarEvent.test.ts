/**
 * The Google Calendar resource schemas and the pure comparisons the actions
 * rely on: what a caller may write, whether an existing event is the one asked
 * for, which instance of a series an original start names, and the
 * deterministic event ids that make an insert idempotent.
 */
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  CalendarDate,
  DateTime,
  differences,
  type Event,
  EventInput,
  EventPatch,
  EventTimeInput,
  isCalendarDate,
  isCalendarId,
  isCancelled,
  isDateTime,
  isOccurrence,
  isTimeZone,
  TimeZone
} from "../src/googlecalendar/Event.ts"
import {
  base32hex,
  EVENT_ID_PATTERN,
  EventId,
  EventReference,
  fromKey,
  isEventId,
  isEventReference
} from "../src/googlecalendar/EventId.ts"

const accepts = <S extends Schema.Top>(schema: S, value: unknown): boolean =>
  Schema.is(schema as unknown as Schema.Codec<unknown>)(value)

const decodeError = (schema: Schema.Top, value: unknown): string => {
  try {
    Schema.decodeUnknownSync(schema as unknown as Schema.Codec<unknown>)(value)
  } catch (error) {
    return String(error)
  }
  throw new Error("expected a decode failure")
}

const timed = (dateTime: string, timeZone?: string) => timeZone === undefined ? { dateTime } : { dateTime, timeZone }

const WEEKLY: EventInput = {
  summary: "Weekly sync",
  description: "Agenda in the doc",
  location: "Room 1",
  start: timed("2026-10-02T09:00:00-07:00", "America/Los_Angeles"),
  end: timed("2026-10-02T09:30:00-07:00", "America/Los_Angeles"),
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR"],
  attendees: [{ email: "Lead@Example.test" }, { email: "builder@example.test", optional: true }],
  visibility: "private",
  transparency: "transparent",
  extendedProperties: { private: { smithers: "weekly" }, shared: { series: "sync" } }
}

/** The event Google answers for {@link WEEKLY}: a `Z` instant, lowercased mail, extra fields. */
const STORED: Event = {
  id: "weeklysync0",
  status: "confirmed",
  summary: "Weekly sync",
  description: "Agenda in the doc",
  location: "Room 1",
  start: timed("2026-10-02T16:00:00Z", "America/Los_Angeles"),
  end: timed("2026-10-02T16:30:00.000Z", "America/Los_Angeles"),
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR"],
  attendees: [{ email: "builder@example.test" }, { email: "lead@example.test" }, { displayName: "Room" }],
  visibility: "private",
  transparency: "transparent",
  extendedProperties: {
    private: { smithers: "weekly", addedByOwner: "yes" },
    shared: { series: "sync" }
  }
}

describe("Google Calendar time values", () => {
  it("accepts an RFC 3339 instant only with an explicit offset and real fields", () => {
    for (const value of ["2026-10-02T09:00:00Z", "2026-10-02T09:00:00.123456789+05:30", "2024-02-29T23:59:59-00:00"]) {
      expect(isDateTime(value), value).toBe(true)
      expect(accepts(DateTime, value), value).toBe(true)
    }
    for (
      const value of [
        42,
        "2026-10-02T09:00:00",
        "2026-10-02 09:00:00Z",
        "2026-02-30T09:00:00Z",
        "2026-10-02T24:00:00Z",
        "2026-10-02T09:60:00Z",
        "2026-10-02T09:00:60Z",
        "2026-10-02T09:00:00+99:99"
      ]
    ) {
      expect(isDateTime(value), String(value)).toBe(false)
    }
    expect(decodeError(DateTime, "tomorrow")).toContain("an RFC 3339 date-time with an explicit offset")
  })

  it("accepts a calendar date only when that day exists", () => {
    expect(isCalendarDate("2024-02-29")).toBe(true)
    expect(accepts(CalendarDate, "2026-12-31")).toBe(true)
    for (const value of [null, "2026-02-29", "2026-13-01", "2026-1-01", "2026-10-02T00:00:00Z"]) {
      expect(isCalendarDate(value), String(value)).toBe(false)
    }
    expect(decodeError(CalendarDate, "2026-02-30")).toContain("a YYYY-MM-DD calendar date")
  })

  it("accepts a named IANA zone and refuses offsets and unknown names", () => {
    expect(isTimeZone("America/Los_Angeles")).toBe(true)
    expect(isTimeZone("UTC")).toBe(true)
    expect(accepts(TimeZone, "Etc/GMT+8")).toBe(true)
    for (const value of [undefined, "+02:00", "", "Not/A_Zone", "America/../Etc"]) {
      expect(isTimeZone(value), String(value)).toBe(false)
    }
    expect(decodeError(TimeZone, "Mars/Olympus_Mons")).toContain("an IANA time zone name")
  })

  it("names exactly one of date and dateTime", () => {
    expect(accepts(EventTimeInput, { date: "2026-10-02" })).toBe(true)
    expect(accepts(EventTimeInput, { dateTime: "2026-10-02T09:00:00Z", timeZone: "UTC" })).toBe(true)
    expect(decodeError(EventTimeInput, { date: "2026-10-02", dateTime: "2026-10-02T09:00:00Z" })).toContain(
      "exactly one of date and dateTime"
    )
    expect(decodeError(EventTimeInput, {})).toContain("exactly one of date and dateTime")
  })

  it("checks calendar ids the way a request path needs them", () => {
    expect(isCalendarId("primary")).toBe(true)
    expect(isCalendarId("team@group.calendar.google.com")).toBe(true)
    for (const value of [".", "..", "a/b", "", 7]) expect(isCalendarId(value), String(value)).toBe(false)
  })
})

describe("Google Calendar event inputs", () => {
  it("accepts a recurring event that names its zone, and an all-day event", () => {
    expect(accepts(EventInput, WEEKLY)).toBe(true)
    expect(accepts(EventInput, { start: { date: "2026-10-02" }, end: { date: "2026-10-03" } })).toBe(true)
  })

  it("refuses a span Google would refuse or read differently", () => {
    expect(decodeError(EventInput, { start: { date: "2026-10-02" }, end: timed("2026-10-03T00:00:00Z") }))
      .toContain("start and end must both be dates or both be date-times")
    expect(decodeError(EventInput, { start: timed("2026-10-02T09:00:00Z"), end: timed("2026-10-02T09:00:00Z") }))
      .toContain("end must be after start")
    expect(decodeError(EventInput, { start: { date: "2026-10-03" }, end: { date: "2026-10-02" } }))
      .toContain("end must be after start")
    expect(
      decodeError(EventInput, {
        start: timed("2026-10-02T09:00:00-07:00", "America/Los_Angeles"),
        end: timed("2026-10-02T09:30:00-07:00"),
        recurrence: ["RRULE:FREQ=WEEKLY"]
      })
    ).toContain("a recurring event must name the time zone of its start and end")
    // An empty recurrence is not a recurring event.
    expect(accepts(EventInput, { ...WEEKLY, start: timed("2026-10-02T16:00:00Z"), recurrence: [] })).toBe(true)
  })

  it("refuses recurrence lines, attendees and fields outside the closed input", () => {
    expect(accepts(EventInput, { ...WEEKLY, recurrence: ["FREQ=WEEKLY"] })).toBe(false)
    expect(accepts(EventInput, { ...WEEKLY, recurrence: ["RRULE:FREQ=WEEKLY\r\nATTENDEE:x"] })).toBe(false)
    expect(accepts(EventInput, { ...WEEKLY, attendees: [{ email: "not an address" }] })).toBe(false)
    expect(accepts(EventInput, { ...WEEKLY, visibility: "secret" })).toBe(false)
  })

  it("requires a patch to change something and to move start and end together", () => {
    expect(accepts(EventPatch, { status: "cancelled" })).toBe(true)
    expect(accepts(EventPatch, { start: { date: "2026-10-02" }, end: { date: "2026-10-03" } })).toBe(true)
    expect(decodeError(EventPatch, {})).toContain("a patch changes at least one field")
    expect(decodeError(EventPatch, { start: { date: "2026-10-02" } })).toContain("moves start and end together")
    expect(decodeError(EventPatch, { end: { date: "2026-10-02" } })).toContain("moves start and end together")
    expect(decodeError(EventPatch, { start: { date: "2026-10-03" }, end: { date: "2026-10-02" } }))
      .toContain("end must be after start")
  })
})

describe("differences", () => {
  it("reports nothing for the event Google stored for the same input", () => {
    expect(differences(WEEKLY, STORED)).toEqual([])
  })

  it("compares only what the caller set", () => {
    const minimal: EventInput = { start: WEEKLY.start, end: WEEKLY.end }
    expect(differences(minimal, { ...STORED, description: "The owner's notes", summary: "Renamed" })).toEqual([])
    // Google names a zone the caller left out; that is not a difference.
    expect(differences({ start: timed("2026-10-02T16:00:00Z"), end: timed("2026-10-02T16:30:00Z") }, STORED))
      .toEqual([])
  })

  it("names each field that differs", () => {
    const moved: Event = {
      id: "weeklysync0",
      status: "cancelled",
      summary: "Other",
      start: timed("2026-10-02T17:00:00Z", "America/Los_Angeles"),
      end: timed("2026-10-02T16:30:00Z", "Europe/Paris"),
      recurrence: ["RRULE:FREQ=DAILY"],
      attendees: [{ email: "lead@example.test" }],
      extendedProperties: { shared: { series: "sync" } }
    }
    expect(differences(WEEKLY, moved)).toEqual([
      "status",
      "summary",
      "description",
      "location",
      "start",
      "end",
      "recurrence",
      "attendees",
      "visibility",
      "transparency",
      "extendedProperties"
    ])
  })

  it("defaults the fields Google leaves out and treats a missing time as different", () => {
    const bare: Event = { id: "weeklysync0" }
    expect(
      differences(
        {
          start: timed("2026-10-02T16:00:00Z"),
          end: timed("2026-10-02T16:30:00Z"),
          recurrence: [],
          attendees: [],
          visibility: "default",
          transparency: "opaque",
          extendedProperties: {}
        },
        bare
      )
    ).toEqual(["start", "end"])
    expect(differences({ ...WEEKLY, extendedProperties: { shared: { series: "other" } } }, STORED)).toEqual([
      "extendedProperties"
    ])
    // A timed input against an all-day event, and dates that disagree.
    expect(differences(WEEKLY, { ...STORED, start: { date: "2026-10-02" } })).toEqual(["start"])
    expect(
      differences(
        { start: { date: "2026-10-02" }, end: { date: "2026-10-03" } },
        { id: "x", start: { date: "2026-10-02" }, end: { date: "2026-10-04" } }
      )
    ).toEqual(["end"])
  })

  it("reports a cancelled event as different whatever else matches", () => {
    expect(isCancelled({ id: "x", status: "cancelled" })).toBe(true)
    expect(isCancelled({ id: "x" })).toBe(false)
    expect(differences(WEEKLY, { ...STORED, status: "cancelled" })).toEqual(["status"])
  })
})

describe("isOccurrence", () => {
  const instance: Event = {
    id: "series_20261009T160000Z",
    recurringEventId: "series",
    originalStartTime: timed("2026-10-09T09:00:00-07:00", "America/Los_Angeles")
  }

  it("matches a timed original start as an instant", () => {
    expect(isOccurrence(instance, timed("2026-10-09T16:00:00Z"))).toBe(true)
    expect(isOccurrence(instance, timed("2026-10-16T16:00:00Z"))).toBe(false)
  })

  it("matches an all-day original start as a date", () => {
    const allDay: Event = { id: "series_20261009", originalStartTime: { date: "2026-10-09" } }
    expect(isOccurrence(allDay, { date: "2026-10-09" })).toBe(true)
    expect(isOccurrence(allDay, { date: "2026-10-10" })).toBe(false)
    expect(isOccurrence(allDay, timed("2026-10-09T00:00:00Z"))).toBe(false)
  })

  it("is false for an event that is not an instance", () => {
    expect(isOccurrence({ id: "series" }, timed("2026-10-09T16:00:00Z"))).toBe(false)
  })
})

describe("EventId", () => {
  it("encodes RFC 4648 base32hex without padding, in lowercase", () => {
    const bytes = (text: string) => new TextEncoder().encode(text)
    // The RFC 4648 section 10 vectors, unpadded and lowercased.
    expect(base32hex(bytes(""))).toBe("")
    expect(base32hex(bytes("f"))).toBe("co")
    expect(base32hex(bytes("fo"))).toBe("cpng")
    expect(base32hex(bytes("foo"))).toBe("cpnmu")
    expect(base32hex(bytes("foob"))).toBe("cpnmuog")
    expect(base32hex(bytes("fooba"))).toBe("cpnmuoj1")
    expect(base32hex(bytes("foobar"))).toBe("cpnmuoj1e8")
  })

  it("derives a stable, valid, 52-character id from a key", () => {
    const id = fromKey("weekly-one-on-one/lead")
    expect(id).toBe(fromKey("weekly-one-on-one/lead"))
    expect(id).not.toBe(fromKey("weekly-one-on-one/builder"))
    expect(id).toHaveLength(52)
    expect(EVENT_ID_PATTERN.test(id)).toBe(true)
    expect(isEventId(id)).toBe(true)
    expect(accepts(EventId, fromKey(""))).toBe(true)
  })

  it("accepts only Google's alphabet for a chosen id and a path-safe shape for any reference", () => {
    for (const value of ["abcd", "ABCDE", "wxyz0", "abc_de", 12345]) expect(isEventId(value), String(value)).toBe(false)
    expect(isEventReference("series_20261009T160000Z")).toBe(true)
    expect(accepts(EventReference, "Generated-Id_1")).toBe(true)
    for (const value of ["", "..", "a/b", "a.b", "x".repeat(1025), null]) {
      expect(isEventReference(value), String(value)).toBe(false)
    }
  })
})
