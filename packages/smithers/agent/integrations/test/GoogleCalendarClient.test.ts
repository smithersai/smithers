/**
 * The Google Calendar client against a real `node:http` server.
 *
 * The server stands in for both Google endpoints the client reaches, the
 * Calendar API under `/calendars` and `/freeBusy` and the OAuth token endpoint
 * under `/token`, so token refresh, a 401 and its retry run over real sockets.
 * Nothing is mocked; the fixture answers what Google documents for each case.
 */
import * as Credential from "@smthrs/control/Credential"
import * as SqlCredentialStore from "@smthrs/control/SqlCredentialStore"
import * as WebCryptoCipher from "@smthrs/control/WebCryptoCipher"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Cause, Effect, Exit, Layer, Redacted } from "effect"
import type { ServerResponse } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { fixed } from "../src/core/AccessToken.ts"
import type { Connection } from "../src/core/Connection.ts"
import { personalPolicy } from "../src/core/Connection.ts"
import { type IntegrationError, isIntegrationError } from "../src/core/IntegrationError.ts"
import * as CalendarClient from "../src/googlecalendar/CalendarClient.ts"
import * as Config from "../src/googlecalendar/Config.ts"
import type { EventInput } from "../src/googlecalendar/Event.ts"
import { type Fixture, json, type Recorded, startFixture } from "./Fixture.ts"

const TOKEN = "ya29.fixture-access-token"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const origin = (): string => (fixture as Fixture).origin

const client = (extra: Config.GoogleCalendarConfig = {}) =>
  CalendarClient.make({ accessToken: TOKEN, apiBaseUrl: origin(), ...extra }, {})

const api = (): ReadonlyArray<Recorded> => (fixture as Fixture).requests.filter((r) => !r.url.startsWith("/token"))

const failure = async <A>(effect: Effect.Effect<A, IntegrationError>): Promise<IntegrationError> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a typed failure")
  const error = Cause.squash(exit.cause)
  if (!isIntegrationError(error)) throw error
  return error
}

const thrown = (build: () => unknown): IntegrationError => {
  try {
    build()
  } catch (error) {
    if (isIntegrationError(error)) return error
    throw error
  }
  throw new Error("expected a thrown IntegrationError")
}

const googleError = (response: ServerResponse, status: number, reason: string, message = reason) =>
  json(response, status, { error: { code: status, message, errors: [{ domain: "calendar", reason, message }] } })

const EVENT: EventInput = {
  summary: "Weekly sync",
  start: { dateTime: "2026-10-02T09:00:00-07:00", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2026-10-02T09:30:00-07:00", timeZone: "America/Los_Angeles" },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR"]
}

const EVENT_ID = "0123456789abcdefghijklmnopqrstuv"

describe("Google Calendar config", () => {
  it("prefers explicit values, then the SMITHERS_GOOGLE_* environment, then Google's endpoints", () => {
    const env = {
      SMITHERS_GOOGLE_ACCESS_TOKEN: "env-access",
      SMITHERS_GOOGLE_CLIENT_ID: "env-client",
      SMITHERS_GOOGLE_CLIENT_SECRET: "env-secret",
      SMITHERS_GOOGLE_REFRESH_TOKEN: "env-refresh",
      SMITHERS_GOOGLE_TOKEN_URL: "https://token.example.test/token",
      SMITHERS_GOOGLE_CALENDAR_API_BASE_URL: "https://calendar.example.test/v3"
    }
    const fromEnv = Config.resolve({}, env)
    expect(fromEnv).toMatchObject({
      accessToken: "env-access",
      clientId: "env-client",
      clientSecret: "env-secret",
      refreshToken: "env-refresh",
      tokenUrl: "https://token.example.test/token",
      apiBaseUrl: "https://calendar.example.test/v3",
      maxRetries: 3
    })
    expect(Config.resolve({ accessToken: " explicit ", clientId: "c" }, env)).toMatchObject({
      accessToken: "explicit",
      clientId: "c"
    })
    const defaults = Config.resolve({ accessToken: "   " }, {})
    expect(defaults.accessToken).toBeUndefined()
    expect(defaults.tokenUrl).toBe(Config.DEFAULT_TOKEN_URL)
    expect(defaults.apiBaseUrl).toBe(Config.DEFAULT_API_BASE_URL)
    expect(defaults.requestTimeout).toBe(Config.DEFAULT_REQUEST_TIMEOUT)
    expect(Config.SCOPES.events).toBe("https://www.googleapis.com/auth/calendar.events")
  })

  it("refuses a malformed base URL, retry budget or timeout as invalid-config", async () => {
    for (
      const config of [
        { apiBaseUrl: "not a url" },
        { apiBaseUrl: "ftp://calendar.example.test" },
        { maxRetries: -1 },
        { maxRetries: 11 },
        { requestTimeout: "0 millis" }
      ] satisfies ReadonlyArray<Config.GoogleCalendarConfig>
    ) {
      expect(thrown(() => CalendarClient.make(config, {})).reason, JSON.stringify(config)).toBe("invalid-config")
    }
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function*() {
          return yield* CalendarClient.CalendarClient
        }),
        CalendarClient.layer({ apiBaseUrl: "nope" }, {})
      )
    )
    expect(Exit.isFailure(exit) && isIntegrationError(Cause.squash(exit.cause))).toBe(true)
  })

  it("keeps an error that is not a config error a defect of the layer", async () => {
    const boom = new Error("config getter failed")
    const config = Object.defineProperty({}, "maxRetries", {
      get: () => {
        throw boom
      }
    }) as Config.GoogleCalendarConfig
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function*() {
          return yield* CalendarClient.CalendarClient
        }),
        CalendarClient.layer(config, {})
      )
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(boom)
  })

  it("provides a working client through its layer", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { id: EVENT_ID }))
    const event = await Effect.runPromise(
      Effect.gen(function*() {
        const calendar = yield* CalendarClient.CalendarClient
        return yield* calendar.getEvent("primary", EVENT_ID)
      }).pipe(Effect.provide(CalendarClient.layer({ accessToken: TOKEN, apiBaseUrl: origin() }, {})))
    )
    expect(event.id).toBe(EVENT_ID)
  })
})

describe("Google Calendar requests", () => {
  it("lists events with the query it was given and the bearer token", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        kind: "calendar#events",
        items: [{ id: "abcde", status: "confirmed", summary: "One", conferenceData: { kept: true } }],
        nextPageToken: "page-2"
      })
    )
    const page = await Effect.runPromise(
      client().listEvents("team@group.calendar.example.test", {
        maxResults: 50,
        syncToken: "sync-1",
        pageToken: "page-1",
        showDeleted: true,
        singleEvents: false
      })
    )
    expect(page.items.map((event) => event.id)).toEqual(["abcde"])
    // Fields the schema does not name pass through for the synchronized payload.
    expect((page.items[0] as Record<string, unknown>)["conferenceData"]).toEqual({ kept: true })
    expect(page.nextPageToken).toBe("page-2")
    expect(page.nextSyncToken).toBeNull()
    const request = api()[0] as Recorded
    const url = new URL(request.url, origin())
    expect(url.pathname).toBe("/calendars/team%40group.calendar.example.test/events")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      maxResults: "50",
      syncToken: "sync-1",
      pageToken: "page-1",
      showDeleted: "true",
      singleEvents: "false"
    })
    expect(request.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
    expect(request.headers["accept"]).toBe("application/json")
  })

  it("answers an empty listing with no items and the sync token", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { nextSyncToken: "sync-2" }))
    const page = await Effect.runPromise(client().listEvents("primary"))
    expect(page).toEqual({ items: [], nextPageToken: null, nextSyncToken: "sync-2" })
  })

  it("reads, inserts, patches and deletes at the documented paths, emailing nobody by default", async () => {
    fixture = await startFixture((request, response) => {
      if (request.method === "DELETE") {
        response.writeHead(204)
        response.end()
        return
      }
      const body = request.body.length === 0 ? {} : JSON.parse(request.body)
      json(response, 200, { id: body.id ?? EVENT_ID, status: "confirmed", ...body })
    })
    const calendar = client()
    const got = await Effect.runPromise(calendar.getEvent("primary", EVENT_ID))
    const inserted = await Effect.runPromise(calendar.insertEvent("primary", EVENT, { id: EVENT_ID }))
    const insertedWithoutId = await Effect.runPromise(calendar.insertEvent("primary", EVENT))
    const patched = await Effect.runPromise(
      calendar.patchEvent("primary", `${EVENT_ID}_20261009T160000Z`, { summary: "Moved" }, { sendUpdates: "all" })
    )
    await Effect.runPromise(calendar.deleteEvent("primary", EVENT_ID))
    await Effect.runPromise(calendar.deleteEvent("primary", EVENT_ID, { sendUpdates: "externalOnly" }))
    const listed = await Effect.runPromise(
      calendar.instances("primary", EVENT_ID, { timeMin: "2026-10-01T00:00:00Z", maxResults: 10 })
    )
    expect(got.id).toBe(EVENT_ID)
    expect(inserted.summary).toBe("Weekly sync")
    expect(insertedWithoutId.id).toBe(EVENT_ID)
    expect(patched.summary).toBe("Moved")
    expect(listed.items).toEqual([])
    const requests = api().map((request) => `${request.method} ${request.url}`)
    expect(requests).toEqual([
      `GET /calendars/primary/events/${EVENT_ID}`,
      "POST /calendars/primary/events?sendUpdates=none",
      "POST /calendars/primary/events?sendUpdates=none",
      `PATCH /calendars/primary/events/${EVENT_ID}_20261009T160000Z?sendUpdates=all`,
      `DELETE /calendars/primary/events/${EVENT_ID}?sendUpdates=none`,
      `DELETE /calendars/primary/events/${EVENT_ID}?sendUpdates=externalOnly`,
      `GET /calendars/primary/events/${EVENT_ID}/instances?timeMin=2026-10-01T00%3A00%3A00Z&maxResults=10`
    ])
    const insert = JSON.parse((api()[1] as Recorded).body)
    expect(insert).toEqual({ ...EVENT, id: EVENT_ID })
    expect(JSON.parse((api()[2] as Recorded).body).id).toBeUndefined()
    expect((api()[1] as Recorded).headers["content-type"]).toBe("application/json")
  })

  it("refuses ids and bounds it cannot send before any request", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    const calendar = client()
    for (
      const effect of [
        calendar.listEvents(".."),
        calendar.listEvents("a/b"),
        calendar.listEvents("primary", { maxResults: 0 }),
        calendar.listEvents("primary", { maxResults: 2501 }),
        calendar.instances("primary", EVENT_ID, { maxResults: 1.5 }),
        calendar.getEvent("primary", "../x"),
        calendar.insertEvent("primary", EVENT, { id: "UPPERCASE-IS-NOT-BASE32HEX" }),
        calendar.insertEvent("primary", EVENT, { id: "abcd" })
      ] as ReadonlyArray<Effect.Effect<unknown, IntegrationError>>
    ) {
      expect((await failure(effect)).reason).toBe("invalid-config")
    }
    const cyclic: Record<string, unknown> = { ...EVENT }
    cyclic["self"] = cyclic
    const unserializable = await failure(calendar.insertEvent("primary", cyclic as unknown as EventInput))
    expect(unserializable.reason).toBe("invalid-config")
    expect(unserializable.details?.["outcomeUnknown"]).toBe(false)
    expect(api()).toHaveLength(0)
  })

  it("reports a response that does not fit the resource as decode-failed", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { summary: "no id" }))
    const error = await failure(client().getEvent("primary", EVENT_ID))
    expect(error.reason).toBe("decode-failed")
  })

  it("does not follow a redirect", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(302, { location: "https://elsewhere.example.test/" })
      response.end()
    })
    const error = await failure(client().getEvent("primary", EVENT_ID))
    expect(error.details?.["status"]).toBe(302)
    expect(api()).toHaveLength(1)
  })

  it("fails credentials-missing without sending when no token source can be formed", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    const error = await failure(CalendarClient.make({ apiBaseUrl: origin() }, {}).listEvents("primary"))
    expect(error.reason).toBe("credentials-missing")
    expect(api()).toHaveLength(0)
  })

  it("uses a token source when one is given", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { items: [] }))
    await Effect.runPromise(
      CalendarClient.make({ tokens: fixed(Redacted.make("from-source")), apiBaseUrl: origin() }, {}).listEvents(
        "primary"
      )
    )
    expect((api()[0] as Recorded).headers["authorization"]).toBe("Bearer from-source")
  })
})

describe("Google Calendar allowlist", () => {
  it("refuses a calendar outside the allowlist before sending, and an empty list allows none", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { items: [] }))
    const denied = await failure(client({ allowedCalendars: ["work@example.test"] }).listEvents("primary"))
    expect(denied.reason).toBe("permission-denied")
    const none = await failure(client({ allowedCalendars: [] }).getEvent("work@example.test", EVENT_ID))
    expect(none.reason).toBe("permission-denied")
    const freeBusy = await failure(
      client({ allowedCalendars: ["work@example.test"] }).freeBusy({
        timeMin: "2026-10-02T00:00:00Z",
        timeMax: "2026-10-03T00:00:00Z",
        calendarIds: ["work@example.test", "primary"]
      })
    )
    expect(freeBusy.reason).toBe("permission-denied")
    expect(api()).toHaveLength(0)
    await Effect.runPromise(client({ allowedCalendars: ["work@example.test"] }).listEvents("work@example.test"))
    await Effect.runPromise(client({ allowedCalendars: ["*"] }).listEvents("primary"))
    expect(api()).toHaveLength(2)
  })
})

/** One server for the token endpoint and the API: `/token` mints `access-<n>`. */
const withTokenEndpoint = async (
  onApi: (request: Recorded, response: ServerResponse, bearer: string | undefined) => void
): Promise<void> => {
  let minted = 0
  fixture = await startFixture((request, response) => {
    if (request.url.startsWith("/token")) {
      minted += 1
      json(response, 200, { access_token: `access-${minted}`, expires_in: 3600, token_type: "Bearer" })
      return
    }
    onApi(request, response, request.headers["authorization"])
  })
}

const refreshingClient = () =>
  CalendarClient.make({ apiBaseUrl: origin() }, {
    SMITHERS_GOOGLE_CLIENT_ID: "client-id",
    SMITHERS_GOOGLE_CLIENT_SECRET: "client-secret-fixture",
    SMITHERS_GOOGLE_REFRESH_TOKEN: "refresh-fixture",
    SMITHERS_GOOGLE_TOKEN_URL: `${origin()}/token`
  })

describe("Google Calendar token refresh", () => {
  it("refreshes as a public client when the environment names no client secret", async () => {
    await withTokenEndpoint((_request, response) => json(response, 200, { items: [] }))
    const calendar = CalendarClient.make({ apiBaseUrl: origin() }, {
      SMITHERS_GOOGLE_CLIENT_ID: "public-client",
      SMITHERS_GOOGLE_REFRESH_TOKEN: "refresh-fixture",
      SMITHERS_GOOGLE_TOKEN_URL: `${origin()}/token`
    })
    await Effect.runPromise(calendar.listEvents("primary"))
    const token = (fixture as Fixture).requests.find((r) => r.url.startsWith("/token")) as Recorded
    const form = new URLSearchParams(token.body)
    expect(form.get("client_id")).toBe("public-client")
    expect(form.get("refresh_token")).toBe("refresh-fixture")
    expect(form.has("client_secret")).toBe(false)
    expect(token.headers["authorization"]).toBeUndefined()
    expect((api()[0] as Recorded).headers["authorization"]).toBe("Bearer access-1")
  })

  it("refreshes through the OAuth endpoint and resends once after a 401", async () => {
    await withTokenEndpoint((_request, response, bearer) => {
      if (bearer === "Bearer access-1") return googleError(response, 401, "authError", "Invalid Credentials")
      json(response, 200, { items: [], nextSyncToken: "sync" })
    })
    const page = await Effect.runPromise(refreshingClient().listEvents("primary"))
    expect(page.nextSyncToken).toBe("sync")
    expect(api().map((request) => request.headers["authorization"])).toEqual(["Bearer access-1", "Bearer access-2"])
    const tokenForms = (fixture as Fixture).requests.filter((r) => r.url.startsWith("/token"))
      .map((r) => new URLSearchParams(r.body).get("grant_type"))
    expect(tokenForms).toEqual(["refresh_token", "refresh_token"])
  })

  it("reports a second 401 as permission-denied without a third attempt", async () => {
    await withTokenEndpoint((_request, response) => googleError(response, 401, "authError", "Invalid Credentials"))
    const error = await failure(refreshingClient().insertEvent("primary", EVENT, { id: EVENT_ID }))
    expect(error.reason).toBe("permission-denied")
    expect(error.details?.["retryable"]).toBe(false)
    expect(error.details?.["outcomeUnknown"]).toBe(false)
    expect(api()).toHaveLength(2)
  })

  it("removes the token in use from an error that echoes it", async () => {
    fixture = await startFixture((request, response) =>
      json(response, 400, { error: { code: 400, message: `bad header ${request.headers["authorization"]}` } })
    )
    const error = await failure(client().getEvent("primary", EVENT_ID))
    expect(error.summary).not.toContain(TOKEN)
    expect(error.summary).toContain("[REDACTED]")
    expect(error.reason).toBe("delivery-failed")
  })
})

describe("Google Calendar rate limits and ambiguity", () => {
  it("retries a 403 rateLimitExceeded and a 429 for every method", async () => {
    let calls = 0
    fixture = await startFixture((request, response) => {
      calls += 1
      if (calls === 1) return googleError(response, 403, "rateLimitExceeded", "Rate Limit Exceeded")
      if (calls === 2) {
        return json(response, 429, { error: { code: 429, message: "slow" } }, { "retry-after": "0" })
      }
      if (calls === 3) return googleError(response, 403, "userRateLimitExceeded")
      json(response, 200, { id: EVENT_ID, ...JSON.parse(request.body) })
    })
    const event = await Effect.runPromise(client().insertEvent("primary", EVENT, { id: EVENT_ID }))
    expect(event.id).toBe(EVENT_ID)
    expect(api()).toHaveLength(4)
  })

  it("waits the Retry-After Google asks for before the retry", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) return json(response, 429, { error: { code: 429, message: "slow" } }, { "retry-after": "1" })
      json(response, 200, { items: [] })
    })
    await Effect.runPromise(client().listEvents("primary"))
    const [first, second] = api() as [Recorded, Recorded]
    expect(second.receivedAt - first.receivedAt).toBeGreaterThanOrEqual(900)
  })

  it("stops after the retry budget and says the refusal was a rate limit", async () => {
    fixture = await startFixture((_request, response) => googleError(response, 429, "rateLimitExceeded"))
    const error = await failure(client({ maxRetries: 1 }).listEvents("primary"))
    expect(error.details).toMatchObject({ status: 429, rateLimited: true, retryable: true })
    expect(api()).toHaveLength(2)
  })

  it("does not retry a forbidden request or an exhausted daily quota", async () => {
    fixture = await startFixture((request, response) =>
      request.url.includes("quota")
        ? googleError(response, 403, "dailyLimitExceeded", "Daily Limit Exceeded")
        : googleError(response, 403, "forbidden", "Forbidden")
    )
    const forbidden = await failure(client().getEvent("primary", EVENT_ID))
    expect(forbidden.reason).toBe("permission-denied")
    expect(forbidden.details?.["googleReason"]).toBe("forbidden")
    const quota = await failure(client().getEvent("quota@example.test", EVENT_ID))
    expect(quota.reason).toBe("delivery-failed")
    expect(quota.details?.["retryable"]).toBe(false)
    expect(api()).toHaveLength(2)
  })

  it("retries a read after a 5xx", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) return json(response, 503, { error: { code: 503, message: "Backend Error" } })
      json(response, 200, { id: EVENT_ID })
    })
    const event = await Effect.runPromise(client().getEvent("primary", EVENT_ID))
    expect(event.id).toBe(EVENT_ID)
    expect(api()).toHaveLength(2)
  })

  it("reports a write's 5xx as an unknown outcome and does not repeat it", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" })
      response.end("Internal error")
    })
    const error = await failure(client().insertEvent("primary", EVENT, { id: EVENT_ID }))
    expect(error.details).toMatchObject({ status: 500, outcomeUnknown: true, retryable: false })
    expect(error.summary).toContain("Internal error")
    expect(error.summary).toContain("outcome unknown")
    expect(api()).toHaveLength(1)
  })

  it("reports a dropped write as an unknown outcome", async () => {
    fixture = await startFixture((_request, response) => {
      response.socket?.destroy()
    })
    const error = await failure(client().deleteEvent("primary", EVENT_ID))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details).toMatchObject({ outcomeUnknown: true, retryable: false })
    expect(api()).toHaveLength(1)
  })

  it("times out a stalled write as an unknown outcome and a stalled read as retryable", async () => {
    fixture = await startFixture(() => {
      // Never answers.
    })
    const write = await failure(
      client({ requestTimeout: "100 millis" }).patchEvent("primary", EVENT_ID, { summary: "x" })
    )
    expect(write.details).toMatchObject({ timedOut: true, outcomeUnknown: true, retryable: false })
    const read = await failure(client({ requestTimeout: "100 millis", maxRetries: 0 }).getEvent("primary", EVENT_ID))
    expect(read.details).toMatchObject({ timedOut: true, outcomeUnknown: false, retryable: true })
  })

  it("reads the rate-limit signals the way Google sends them", () => {
    const body = (reason: string) => ({ error: { errors: [{ reason }] } })
    expect(CalendarClient.isRateLimitResponse(429, null)).toBe(true)
    expect(CalendarClient.isRateLimitResponse(403, body("rateLimitExceeded"))).toBe(true)
    expect(CalendarClient.isRateLimitResponse(403, body("forbidden"))).toBe(false)
    expect(CalendarClient.isRateLimitResponse(403, "Forbidden")).toBe(false)
    expect(CalendarClient.isRateLimitResponse(500, body("rateLimitExceeded"))).toBe(false)
    expect(CalendarClient.errorReason({ error: {} })).toBeNull()
    expect(CalendarClient.errorReason({ error: { errors: [] } })).toBeNull()
    expect(CalendarClient.retryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2000)
    expect(CalendarClient.retryAfterMs(new Headers({ "retry-after": "600" }))).toBe(60_000)
    expect(CalendarClient.retryAfterMs(new Headers({ "retry-after": "later" }))).toBeNull()
    expect(CalendarClient.retryAfterMs(new Headers())).toBeNull()
  })
})

describe("Google Calendar free/busy", () => {
  const window = { timeMin: "2026-10-02T15:00:00Z", timeMax: "2026-10-02T23:00:00Z" }

  it("posts the query and parses each calendar's busy intervals and errors in request order", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        kind: "calendar#freeBusy",
        ...window,
        calendars: {
          "primary": {
            busy: [
              { start: "2026-10-02T16:00:00Z", end: "2026-10-02T16:30:00Z" },
              { start: "2026-10-02T20:00:00Z", end: "2026-10-02T21:00:00Z" }
            ]
          },
          "missing@example.test": { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
          "odd@example.test": { errors: [{ domain: "global" }] }
        }
      })
    )
    const answer = await Effect.runPromise(
      client().freeBusy({
        ...window,
        calendarIds: ["missing@example.test", "primary", "dropped@example.test", "odd@example.test"],
        timeZone: "America/Los_Angeles"
      })
    )
    expect(answer.calendars).toEqual([
      { calendarId: "missing@example.test", busy: [], errors: ["notFound"] },
      {
        calendarId: "primary",
        busy: [
          {
            start: "2026-10-02T16:00:00Z",
            end: "2026-10-02T16:30:00Z",
            startMs: Date.parse("2026-10-02T16:00:00Z"),
            endMs: Date.parse("2026-10-02T16:30:00Z")
          },
          {
            start: "2026-10-02T20:00:00Z",
            end: "2026-10-02T21:00:00Z",
            startMs: Date.parse("2026-10-02T20:00:00Z"),
            endMs: Date.parse("2026-10-02T21:00:00Z")
          }
        ],
        errors: []
      },
      { calendarId: "dropped@example.test", busy: [], errors: ["notReturned"] },
      { calendarId: "odd@example.test", busy: [], errors: ["unknown"] }
    ])
    const request = api()[0] as Recorded
    expect(request.method).toBe("POST")
    expect(request.url).toBe("/freeBusy")
    expect(JSON.parse(request.body)).toEqual({
      ...window,
      timeZone: "America/Los_Angeles",
      items: [
        { id: "missing@example.test" },
        { id: "primary" },
        { id: "dropped@example.test" },
        { id: "odd@example.test" }
      ]
    })
  })

  it("retries the query after a 5xx because it is a read", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) return json(response, 502, {})
      json(response, 200, { calendars: { primary: {} } })
    })
    const answer = await Effect.runPromise(client().freeBusy({ ...window, calendarIds: ["primary"] }))
    expect(answer.calendars).toEqual([{ calendarId: "primary", busy: [], errors: [] }])
    expect(api()).toHaveLength(2)
  })

  it("rejects a busy interval that is not a pair of instants", async () => {
    for (
      const busy of [{ start: "soon", end: "2026-10-02T16:00:00Z" }, { start: window.timeMax, end: window.timeMin }]
    ) {
      fixture = await startFixture((_request, response) =>
        json(response, 200, { calendars: { primary: { busy: [busy] } } })
      )
      const error = await failure(client().freeBusy({ ...window, calendarIds: ["primary"] }))
      expect(error.reason).toBe("decode-failed")
      await fixture.close()
      fixture = undefined
    }
  })

  it("validates the query before sending it", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    const calendar = client()
    for (
      const query of [
        { ...window, timeMin: "2026-10-02 15:00", calendarIds: ["primary"] },
        { ...window, timeMax: "2026-10-02T23:00:00", calendarIds: ["primary"] },
        { timeMin: window.timeMax, timeMax: window.timeMin, calendarIds: ["primary"] },
        { ...window, calendarIds: [] },
        { ...window, calendarIds: Array.from({ length: 51 }, (_, i) => `c${i}@example.test`) },
        { ...window, calendarIds: ["primary"], timeZone: "+02:00" },
        { ...window, calendarIds: [".."] }
      ]
    ) {
      expect((await failure(calendar.freeBusy(query))).reason, JSON.stringify(query).slice(0, 80)).toBe(
        "invalid-config"
      )
    }
    expect(api()).toHaveLength(0)
  })
})

const HOST_KEY = Redacted.make(btoa("0123456789abcdef0123456789abcdef"))

const connection: Connection = {
  id: "personal-calendar",
  provider: "googlecalendar",
  label: "Personal calendar",
  credential: { id: "personal-calendar-refresh", name: "Personal calendar refresh token" },
  scopes: [Config.SCOPES.events],
  personal: true,
  containers: ["primary"]
}

/** Runs `use` with a client built from `connection` over a real credential boundary. */
const throughConnection = <A>(
  principal: string,
  use: (calendar: CalendarClient.CalendarClient) => Effect.Effect<A, IntegrationError>,
  target: Connection = connection,
  oauthClient: { readonly clientId: string; readonly clientSecret?: string } = {
    clientId: "client-id",
    clientSecret: "client-secret-fixture"
  },
  observeStored: (refreshToken: string) => void = () => {}
): Promise<Exit.Exit<A, IntegrationError>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const store = yield* SqlCredentialStore.make
      const cipher = yield* WebCryptoCipher.make({ key: HOST_KEY })
      const credentials = Credential.make({ store, cipher })
      yield* credentials.create({ ...target.credential, secret: Redacted.make("stored-refresh") })
      const layer = CalendarClient.layerFromConnection(
        { ...target, apiBaseUrl: origin() },
        { principal, authorize: personalPolicy({ personalPrincipals: ["assistant"] }) },
        { ...oauthClient, tokenUrl: `${origin()}/token` },
        {}
      ).pipe(Layer.provide(Layer.succeed(Credential.Credential, credentials)))
      const program = Effect.gen(function*() {
        return yield* use(yield* CalendarClient.CalendarClient)
      })
      const exit = yield* Effect.exit(program.pipe(Effect.provide(layer)))
      observeStored(Redacted.value(yield* credentials.resolve(target.credential)))
      return exit
    }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped, Effect.orDie)
  )

describe("Google Calendar through a connection", () => {
  it("lets the personal principal use a personal connection, refreshing from the stored credential", async () => {
    await withTokenEndpoint((_request, response) => json(response, 200, { items: [] }))
    const exit = await throughConnection("assistant", (calendar) => calendar.listEvents("primary"))
    expect(Exit.isSuccess(exit)).toBe(true)
    const token = (fixture as Fixture).requests.find((r) => r.url.startsWith("/token")) as Recorded
    expect(new URLSearchParams(token.body).get("refresh_token")).toBe("stored-refresh")
    expect((api()[0] as Recorded).headers["authorization"]).toBe("Bearer access-1")
  })

  it("refuses any other principal before the credential or the provider is reached", async () => {
    await withTokenEndpoint((_request, response) => json(response, 200, { items: [] }))
    const exit = await throughConnection("builder", (calendar) => calendar.listEvents("primary"))
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) as IntegrationError : undefined
    expect(error?.reason).toBe("permission-denied")
    expect((fixture as Fixture).requests).toHaveLength(0)
  })

  it("limits the client to the connection's containers", async () => {
    await withTokenEndpoint((_request, response) => json(response, 200, { items: [] }))
    const exit = await throughConnection("assistant", (calendar) => calendar.listEvents("other@example.test"))
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) as IntegrationError : undefined
    expect(error?.reason).toBe("permission-denied")
    expect((fixture as Fixture).requests).toHaveLength(0)
  })

  it("refreshes as a public OAuth client when no client secret is configured", async () => {
    await withTokenEndpoint((_request, response) => json(response, 200, { items: [] }))
    const exit = await throughConnection("assistant", (calendar) => calendar.listEvents("primary"), connection, {
      clientId: "public-client"
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    const token = (fixture as Fixture).requests.find((r) => r.url.startsWith("/token")) as Recorded
    const form = new URLSearchParams(token.body)
    expect(form.get("client_id") ?? token.headers["authorization"]).toBeTruthy()
    expect(form.has("client_secret")).toBe(false)
    expect(token.body).not.toContain("client-secret-fixture")
  })

  it("writes a refresh token Google rotated back to the stored credential", async () => {
    fixture = await startFixture((request, response) =>
      request.url.startsWith("/token")
        ? json(response, 200, { access_token: "access-1", expires_in: 3600, refresh_token: "rotated-refresh" })
        : json(response, 200, { items: [] })
    )
    let stored: string | undefined
    const exit = await throughConnection(
      "assistant",
      (calendar) => calendar.listEvents("primary"),
      connection,
      undefined,
      (value) => {
        stored = value
      }
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(stored).toBe("rotated-refresh")
  })

  it("uses the configured API root for a connection that names none, and needs an OAuth client id", async () => {
    await withTokenEndpoint((_request, response) => json(response, 200, { items: [] }))
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const credentials = Credential.make({
          store: yield* SqlCredentialStore.make,
          cipher: yield* WebCryptoCipher.make({ key: HOST_KEY })
        })
        yield* credentials.create({ ...connection.credential, secret: Redacted.make("stored-refresh") })
        const layer = CalendarClient.layerFromConnection(
          connection,
          { principal: "assistant", authorize: personalPolicy({ personalPrincipals: ["assistant"] }) },
          { apiBaseUrl: origin(), tokenUrl: `${origin()}/token` },
          {}
        ).pipe(Layer.provide(Layer.succeed(Credential.Credential, credentials)))
        return yield* Effect.exit(Effect.provide(
          Effect.gen(function*() {
            return yield* CalendarClient.CalendarClient
          }),
          layer
        ))
      }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped, Effect.orDie)
    )
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) as IntegrationError : undefined
    expect(error?.reason).toBe("credentials-missing")
    expect(error?.message).toContain("client id")
    expect((fixture as Fixture).requests).toHaveLength(0)
  })

  it("refuses a connection to another provider as invalid-config", async () => {
    await withTokenEndpoint((_request, response) => json(response, 200, { items: [] }))
    const exit = await throughConnection(
      "assistant",
      (calendar) => calendar.listEvents("primary"),
      { ...connection, provider: "slack" }
    )
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) as IntegrationError : undefined
    expect(error?.reason).toBe("invalid-config")
  })
})
