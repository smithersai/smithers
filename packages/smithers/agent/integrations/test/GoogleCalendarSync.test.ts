/**
 * A calendar as a change feed, against a real `node:http` server speaking
 * Google's incremental synchronization.
 *
 * The adapter is driven both directly, page by page, and through `runSync`
 * into the memory source store, so the cursor it writes is the cursor it is
 * next asked with. The cases that matter: a full listing is marked `reset`, an
 * expired sync token (410) restarts the listing rather than failing or
 * skipping, a cancelled occurrence removes only itself, and a cursor this
 * module did not write is refused rather than replaying the calendar.
 */
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { type IntegrationError, isIntegrationError } from "../src/core/IntegrationError.ts"
import { layerMemory, SourceStore } from "../src/core/SourceStore.ts"
import { runSync } from "../src/core/Sync.ts"
import * as CalendarClient from "../src/googlecalendar/CalendarClient.ts"
import type { Event } from "../src/googlecalendar/Event.ts"
import * as Sync from "../src/googlecalendar/Sync.ts"
import { type Fixture, json, type Recorded, startFixture } from "./Fixture.ts"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const clientLayer = () =>
  CalendarClient.layer({ accessToken: "ya29.fixture", apiBaseUrl: (fixture as Fixture).origin, maxRetries: 0 }, {})

const run = <A>(effect: Effect.Effect<A, IntegrationError, CalendarClient.CalendarClient | SourceStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(clientLayer(), layerMemory))))

const failure = async (effect: Effect.Effect<unknown, IntegrationError, CalendarClient.CalendarClient>) => {
  const error = await Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(clientLayer())))
  if (!isIntegrationError(error)) throw error
  return error
}

const query = (request: Recorded) => Object.fromEntries(new URL(request.url, "http://fixture").searchParams)

const SERIES: Event = {
  id: "series0001",
  status: "confirmed",
  etag: "\"7\"",
  htmlLink: "https://calendar.example.test/event?eid=series",
  created: "2026-09-01T10:00:00Z",
  updated: "2026-09-20T10:00:00Z",
  summary: "Weekly sync",
  description: "Agenda in the doc",
  location: "Room 1",
  start: { dateTime: "2026-10-02T09:00:00-07:00", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2026-10-02T09:30:00-07:00", timeZone: "America/Los_Angeles" },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR", "EXDATE;TZID=America/Los_Angeles:20261225T090000"],
  creator: { email: "owner@example.test", displayName: "Owner" }
}

const CANCELLED_FRIDAY: Event = {
  id: "series0001_20261009T160000Z",
  status: "cancelled",
  recurringEventId: "series0001",
  originalStartTime: { dateTime: "2026-10-09T09:00:00-07:00" },
  updated: "2026-09-21T10:00:00Z"
}

describe("render", () => {
  it("writes title, time, place, repetition and description, one per line", () => {
    expect(Sync.render(SERIES)).toBe([
      "Weekly sync",
      "When: 2026-10-02T09:00:00-07:00 (America/Los_Angeles) to 2026-10-02T09:30:00-07:00 (America/Los_Angeles)",
      "Where: Room 1",
      "Repeats: RRULE:FREQ=WEEKLY;BYDAY=FR; EXDATE;TZID=America/Los_Angeles:20261225T090000",
      "Agenda in the doc"
    ].join("\n"))
  })

  it("leaves out what the event does not have", () => {
    expect(Sync.render({ id: "x" })).toBe("")
    expect(Sync.render({ id: "x", summary: "", location: "", description: "", recurrence: [] })).toBe("")
    expect(Sync.render({ id: "x", start: { date: "2026-10-02" } })).toBe("When: 2026-10-02")
    expect(Sync.render({ id: "x", start: {}, end: { date: "2026-10-03" } })).toBe("When:  to 2026-10-03")
  })
})

describe("toRecord", () => {
  const options = { connectionId: "assistant-calendar", calendarId: "primary" }

  it("scopes a live event to its calendar, privately by default", () => {
    const record = Sync.toRecord(options, SERIES, 1_000)
    expect(record).toMatchObject({
      provider: "googlecalendar",
      connectionId: "assistant-calendar",
      externalId: "primary/series0001",
      kind: "event",
      access: { scope: "private", containerId: "primary" },
      thread: { containerId: "primary", threadId: null, parentId: null },
      createdAtMs: Date.parse("2026-09-01T10:00:00Z"),
      updatedAtMs: Date.parse("2026-09-20T10:00:00Z"),
      version: "\"7\"",
      url: "https://calendar.example.test/event?eid=series",
      author: { id: "owner@example.test", label: "Owner" },
      retrievedAtMs: 1_000,
      deleted: false
    })
    expect(record.text).toBe(Sync.render(SERIES))
    expect(record.payload).toEqual(SERIES)
  })

  it("falls back to the organizer, its id, the update time, and a wider scope when asked", () => {
    const record = Sync.toRecord(
      { ...options, access: "workspace" },
      { id: "e1", organizer: { id: "org-id" }, updated: "2026-09-20T10:00:00Z", created: "not a time" },
      1_000
    )
    expect(record).toMatchObject({
      access: { scope: "workspace" },
      author: { id: "org-id", label: null },
      version: "2026-09-20T10:00:00Z",
      createdAtMs: null,
      url: null
    })
    expect(Sync.toRecord(options, { id: "e2" }, 1_000)).toMatchObject({ author: null, version: null })
  })

  it("turns a cancelled occurrence into a tombstone threaded under its series", () => {
    const record = Sync.toRecord(options, CANCELLED_FRIDAY, 5_000)
    expect(record).toMatchObject({
      externalId: "primary/series0001_20261009T160000Z",
      thread: { containerId: "primary", threadId: "primary/series0001", parentId: "primary/series0001" },
      deleted: true,
      retrievedAtMs: 5_000
    })
    // With no update time the deletion is dated when it was seen.
    const unseen = Sync.toRecord(options, { id: "gone", status: "cancelled" }, 5_000)
    expect(unseen.deleted).toBe(true)
    expect(unseen.updatedAtMs).toBe(5_000)
  })
})

describe("Sync.make", () => {
  it("refuses a connection, calendar or page size it cannot use", async () => {
    for (
      const options of [
        { connectionId: "", calendarId: "primary" },
        { connectionId: "c", calendarId: ".." },
        { connectionId: "c", calendarId: "primary", pageSize: 0 },
        { connectionId: "c", calendarId: "primary", pageSize: 2501 },
        { connectionId: "c", calendarId: "primary", pageSize: 1.5 }
      ]
    ) {
      fixture ??= await startFixture((_request, response) => json(response, 200, {}))
      expect((await failure(Sync.make(options))).reason, JSON.stringify(options)).toBe("invalid-config")
    }
    expect(fixture?.requests).toHaveLength(0)
  })

  it("lists the calendar in full, marks it reset, then asks only for what changed", async () => {
    fixture = await startFixture((request, response) => {
      const asked = query(request)
      if (asked["syncToken"] === "sync-1") {
        return json(response, 200, { items: [CANCELLED_FRIDAY], nextSyncToken: "sync-2" })
      }
      return asked["pageToken"] === undefined
        ? json(response, 200, { items: [SERIES], nextPageToken: "page-2" })
        : json(response, 200, { items: [{ id: "oneoff01", summary: "Lunch" }], nextSyncToken: "sync-1" })
    })
    const reports = await run(Effect.gen(function*() {
      const adapter = yield* Sync.make({ connectionId: "assistant-calendar", calendarId: "primary", pageSize: 2 })
      expect(adapter).toMatchObject({
        provider: "googlecalendar",
        connectionId: "assistant-calendar",
        stream: "primary"
      })
      const first = yield* runSync({ adapter })
      const second = yield* runSync({ adapter })
      return [first, second]
    }))
    expect(reports[0]).toMatchObject({ pages: 2, inserted: 2 })
    expect(reports[1]).toMatchObject({ pages: 1 })
    const asked = (fixture.requests as ReadonlyArray<Recorded>).map(query)
    expect(asked).toEqual([
      { maxResults: "2" },
      { maxResults: "2", pageToken: "page-2" },
      { maxResults: "2", syncToken: "sync-1" }
    ])
  })

  it("reports each page with its cursor, and a listing without a sync token starts over next time", async () => {
    fixture = await startFixture((request, response) =>
      query(request)["pageToken"] === undefined
        ? json(response, 200, { items: [SERIES], nextPageToken: "page-2" })
        : json(response, 200, { items: [] })
    )
    const pages = await run(Effect.gen(function*() {
      const adapter = yield* Sync.make({ connectionId: "assistant-calendar", calendarId: "primary" })
      const first = yield* adapter.changes(null)
      const second = yield* adapter.changes(first.cursor)
      return [first, second]
    }))
    expect(pages[0]).toMatchObject({ reset: true, done: false })
    expect(JSON.parse(pages[0]?.cursor as string)).toEqual({ v: 1, sync: null, page: "page-2" })
    expect(pages[0]?.records.map((record) => record.externalId)).toEqual(["primary/series0001"])
    expect(pages[1]).toEqual({ records: [], cursor: null, reset: false, done: true })
    expect(query(fixture.requests[0] as Recorded)["maxResults"]).toBe(String(Sync.DEFAULT_PAGE_SIZE))
  })

  it("keeps the sync token across the pages of an incremental listing", async () => {
    fixture = await startFixture((request, response) =>
      query(request)["pageToken"] === undefined
        ? json(response, 200, { items: [], nextPageToken: "delta-2" })
        : json(response, 200, { items: [], nextSyncToken: "sync-9" })
    )
    const cursors = await run(Effect.gen(function*() {
      const adapter = yield* Sync.make({ connectionId: "assistant-calendar", calendarId: "primary" })
      const first = yield* adapter.changes(JSON.stringify({ v: 1, sync: "sync-1", page: null }))
      const second = yield* adapter.changes(first.cursor)
      return [first.cursor, second.cursor]
    }))
    expect(JSON.parse(cursors[0] as string)).toEqual({ v: 1, sync: "sync-1", page: "delta-2" })
    expect(JSON.parse(cursors[1] as string)).toEqual({ v: 1, sync: "sync-9", page: null })
    expect(query(fixture.requests[1] as Recorded)).toMatchObject({ syncToken: "sync-1", pageToken: "delta-2" })
  })

  it("starts a fresh full listing when Google says the sync token expired", async () => {
    fixture = await startFixture((request, response) =>
      query(request)["syncToken"] === undefined
        ? json(response, 200, { items: [SERIES], nextSyncToken: "sync-fresh" })
        : json(response, 410, { error: { code: 410, message: "Sync token is no longer valid" } })
    )
    const changes = await run(Effect.gen(function*() {
      const adapter = yield* Sync.make({ connectionId: "assistant-calendar", calendarId: "primary" })
      return yield* adapter.changes(JSON.stringify({ v: 1, sync: "sync-old", page: null }))
    }))
    expect(changes).toMatchObject({ reset: true, done: true })
    expect(JSON.parse(changes.cursor as string)).toEqual({ v: 1, sync: "sync-fresh", page: null })
    expect(fixture.requests.map(query)).toEqual([
      { maxResults: "250", syncToken: "sync-old" },
      { maxResults: "250" }
    ])
  })

  it("passes any other failure through", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 403, { error: { code: 403, message: "forbidden", errors: [{ reason: "forbidden" }] } })
    )
    const error = await failure(Effect.gen(function*() {
      const adapter = yield* Sync.make({ connectionId: "assistant-calendar", calendarId: "primary" })
      return yield* adapter.changes(JSON.stringify({ v: 1, sync: "sync-1", page: null }))
    }))
    expect(error.reason).toBe("permission-denied")
    expect(fixture.requests).toHaveLength(1)
  })

  it("refuses a stored cursor it did not write rather than replaying the calendar", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    for (const stored of ["not json", JSON.stringify({ v: 2, sync: "s", page: null }), "{\"syncToken\":\"s\"}"]) {
      const error = await failure(Effect.gen(function*() {
        const adapter = yield* Sync.make({ connectionId: "assistant-calendar", calendarId: "primary" })
        return yield* adapter.changes(stored)
      }))
      expect(error.reason, stored).toBe("invalid-config")
      expect(error.message).toContain("did not write")
    }
    expect(fixture.requests).toHaveLength(0)
  })
})
