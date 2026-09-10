import { describe, expect, spyOn, test } from "bun:test"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  bounded,
  capRecord,
  CLIENT_ERROR_LOG_LIMIT,
  CLIENT_ERROR_LOG_MAX_BYTES,
  CLIENT_ERROR_LOG_NAME,
  CLIENT_ERROR_LOG_UNAVAILABLE_NOTE,
  CLIENT_ERROR_RECORD_MAX_BYTES,
  CLIENT_ERROR_SOURCE_HEADER,
  CLIENT_ERROR_SOURCE_WINDOW_MAX,
  CLIENT_ERROR_TEXT_MAX_BYTES,
  CLIENT_ERROR_UNKNOWN_SOURCE,
  CLIENT_ERROR_WINDOW_MAX,
  CLIENT_ERROR_WINDOW_MS,
  ClientErrorLog,
  clientErrorLogRequest,
  ClientErrors,
  clientErrorsLayer,
  clientErrorThrottleLayer,
  makeClientErrorThrottle
} from "./clientErrorLog"
import type { ClientErrorAppendOutcome, ClientErrorPage, ClientErrorRecord } from "./clientErrorLog"
import { memoryStorage, storageLayer } from "./DurableStorage"
import type { NativeNamespace } from "./DurableStorage"

/*
 * What broke in a user's browser has to survive longer than a `wrangler tail`.
 * These tests hold the log to being readable afterwards, bounded, and never
 * able to fail the report it is recording.
 */

/** A clock that answers `now()`; the throttle window is the only thing that reads it. */
const clockOf = (now: () => number): Clock.Clock => ({
  currentTimeMillisUnsafe: now,
  currentTimeMillis: Effect.sync(now),
  currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  sleep: () => Effect.void
})

/**
 * A log with an injectable clock. The throttle window is the Durable Object's,
 * so a test that wants to feed the ring more than one window's worth of
 * reports advances the clock; a test of the throttle freezes it. Without a
 * clock the native class (and the live clock) answers, as in production.
 */
const memoryLog = (now?: () => number): NativeNamespace & { readonly names: () => Array<string> } => {
  const logs = new Map<string, (request: Request) => Promise<Response>>()
  return {
    names: () => [...logs.keys()],
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let log = logs.get(name)
      if (log === undefined) {
        if (now === undefined) {
          const object = new ClientErrorLog({ storage: memoryStorage() })
          log = (request) => object.fetch(request)
        } else {
          const layers = Layer.mergeAll(storageLayer(memoryStorage()), clientErrorThrottleLayer(makeClientErrorThrottle()))
          log = (request) =>
            Effect.runPromise(
              clientErrorLogRequest(request).pipe(Effect.provide(layers), Effect.provideService(Clock.Clock, clockOf(now)))
            )
        }
        logs.set(name, log)
      }
      return { fetch: log }
    }
  }
}

/** Every append is a new throttle window: the ring alone is under test. */
const unthrottled = (): (() => number) => {
  let tick = 0
  return () => (tick += CLIENT_ERROR_WINDOW_MS + 1)
}

const appendClientError = (logs: NativeNamespace | undefined, record: ClientErrorRecord, source?: string): Promise<ClientErrorAppendOutcome> =>
  Effect.runPromise(ClientErrors.use((service) => service.append(record, source)).pipe(Effect.provide(clientErrorsLayer(logs))))

const readClientErrors = (logs: NativeNamespace | undefined, limit?: number): Promise<ClientErrorPage> =>
  Effect.runPromise(ClientErrors.use((service) => service.page(limit)).pipe(Effect.provide(clientErrorsLayer(logs))))

describe("the client-error log (Durable Object state)", () => {
  test("keeps reports newest first", async () => {
    const logs = memoryLog()
    await appendClientError(logs, { at: "2026-08-18T00:00:00.000Z", report: { message: "first" } })
    await appendClientError(logs, { at: "2026-08-18T00:00:01.000Z", report: { message: "second" } })
    const read = await readClientErrors(logs)
    expect(read.total).toBe(2)
    expect(read.reports.map((row) => (row.report as { message: string }).message)).toEqual(["second", "first"])
    // `read` is the same list without the total.
    const reports = await Effect.runPromise(ClientErrors.use((service) => service.read()).pipe(Effect.provide(clientErrorsLayer(logs))))
    expect(reports).toEqual(read.reports)
  })

  test("is bounded: an error storm evicts the oldest, never the newest", async () => {
    const logs = memoryLog(unthrottled())
    for (let index = 0; index < CLIENT_ERROR_LOG_LIMIT + 25; index += 1) {
      await appendClientError(logs, { at: new Date(index).toISOString(), report: { index } })
    }
    const read = await readClientErrors(logs)
    expect(read.total).toBe(CLIENT_ERROR_LOG_LIMIT)
    expect((read.reports[0]?.report as { index: number }).index).toBe(CLIENT_ERROR_LOG_LIMIT + 24)
  })

  test("a second append during a slow body does not overwrite the first", async () => {
    // A Durable Object defers concurrent events only while a storage operation
    // is pending, so awaiting the request body between the read and the write
    // used to let two appends load the same snapshot and clobber each other.
    // This schedule never overlaps two storage calls: the second append is
    // dispatched after the first read completes and finishes before the first
    // body is released.
    const trace: Array<string> = []
    const data = new Map<string, unknown>()
    const log = new ClientErrorLog({
      storage: {
        get: async (key) => {
          trace.push("get")
          return structuredClone(data.get(key)) as never
        },
        put: async (key, value) => {
          data.set(key, structuredClone(value))
          trace.push("put")
        }
      }
    })
    let release = (): void => {}
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ at: "2026-08-18T00:00:00.000Z", report: { message: "slow" } }))
          )
          controller.close()
        }
      }
    })
    const slow = log.fetch(new Request("https://client-errors.internal/append", { method: "POST", body: slowBody }))
    // Let the slow append reach its body await before the second one starts.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const prompt = await log.fetch(
      new Request("https://client-errors.internal/append", {
        method: "POST",
        body: JSON.stringify({ at: "2026-08-18T00:00:01.000Z", report: { message: "prompt" } })
      })
    )
    expect(prompt.status).toBe(200)
    release()
    expect((await slow).status).toBe(200)
    const read = (await (await log.fetch(new Request("https://client-errors.internal/read"))).json()) as {
      total: number
      reports: Array<{ report: { message: string } }>
    }
    expect(read.total).toBe(2)
    expect(read.reports.map((row) => row.report.message).sort()).toEqual(["prompt", "slow"])
    // Every read is followed by its own write: no snapshot is read twice.
    expect(trace.slice(0, 4)).toEqual(["get", "put", "get", "put"])
  })

  test("a body that is not a record is 400 and an unknown path 404", async () => {
    const log = new ClientErrorLog({ storage: memoryStorage() })
    const bad = await log.fetch(new Request("https://client-errors.internal/append", { method: "POST", body: "not json" }))
    expect(bad.status).toBe(400)
    const shapeless = await log.fetch(new Request("https://client-errors.internal/append", { method: "POST", body: "null" }))
    expect(shapeless.status).toBe(400)
    expect((await log.fetch(new Request("https://client-errors.internal/nope"))).status).toBe(404)
  })

  test("a limit trims the read and never exceeds what is kept", async () => {
    const logs = memoryLog()
    for (let index = 0; index < 10; index += 1) {
      await appendClientError(logs, { at: new Date(index).toISOString(), report: { index } })
    }
    expect((await readClientErrors(logs, 3)).reports).toHaveLength(3)
    expect((await readClientErrors(logs, 3)).total).toBe(10)
    expect((await readClientErrors(logs, 10_000)).reports).toHaveLength(10)
  })

  test("with no namespace bound, appending is a no-op and the read is honestly empty", async () => {
    expect(await appendClientError(undefined, { at: "2026-08-18T00:00:00.000Z", report: {} })).toBe("unbound")
    expect(await readClientErrors(undefined)).toEqual({ total: 0, reports: [] })
  })

  test("a failing log never fails the report, and a rejected read is an empty log with an unavailable note", async () => {
    const cause = new Error("durable object unavailable")
    const broken: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => {
          throw cause
        }
      })
    }
    expect(await appendClientError(broken, { at: "2026-08-18T00:00:00.000Z", report: {} })).toBe("failed")
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await readClientErrors(broken)).toEqual({ total: 0, reports: [], note: CLIENT_ERROR_LOG_UNAVAILABLE_NOTE })
      expect(CLIENT_ERROR_LOG_UNAVAILABLE_NOTE).toBe("The client-error log is unavailable right now. Try again in a moment.")
      expect(logged).toHaveBeenCalledWith("client-error log read failed:", cause)
    } finally {
      logged.mockRestore()
    }
  })

  test("a log that refuses a read is logged with its status and body, and the read is honestly unavailable", async () => {
    const refusing: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response("storage is sealed", { status: 500 }) })
    }
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await readClientErrors(refusing)).toEqual({ total: 0, reports: [], note: CLIENT_ERROR_LOG_UNAVAILABLE_NOTE })
      expect(logged).toHaveBeenCalledTimes(1)
      expect((logged.mock.calls[0]![1] as Error).message).toBe("The client-error log answered HTTP 500: storage is sealed")
    } finally {
      logged.mockRestore()
    }
  })

  test("a storage failure inside the object is its own 500, which the report survives", async () => {
    const log = new ClientErrorLog({
      storage: {
        get: async () => {
          throw new Error("storage unavailable")
        },
        put: async () => {}
      }
    })
    const response = await log.fetch(
      new Request("https://client-errors.internal/append", {
        method: "POST",
        body: JSON.stringify({ at: "2026-08-18T00:00:00.000Z", report: {} })
      })
    )
    expect(response.status).toBe(500)
    const failing: NativeNamespace = { idFromName: (name) => name, get: () => ({ fetch: (request) => log.fetch(request) }) }
    expect(await appendClientError(failing, { at: "2026-08-18T00:00:00.000Z", report: {} })).toBe("failed")
  })

  test("a stored report answers \"stored\"", async () => {
    expect(await appendClientError(memoryLog(), { at: "2026-08-18T00:00:00.000Z", report: {} })).toBe("stored")
  })

  test("every deployment writes to one log, so any request finds every report", async () => {
    const logs = memoryLog()
    await appendClientError(logs, { at: "2026-08-18T00:00:00.000Z", report: { message: "a" } })
    await appendClientError(logs, { at: "2026-08-18T00:00:01.000Z", report: { message: "b" } })
    expect(logs.names()).toEqual([CLIENT_ERROR_LOG_NAME])
    expect(CLIENT_ERROR_LOG_NAME).toBe("client-errors")
  })

  test("a record keeps when it arrived, the page, and the agent", async () => {
    const logs = memoryLog()
    await appendClientError(logs, {
      at: "2026-08-18T00:00:00.000Z",
      page: "https://canary.smithers.sh/",
      userAgent: "TestBrowser/1.0",
      report: { message: "Cannot read properties of undefined", stack: "at App" }
    })
    const stored = await readClientErrors(logs)
    expect(stored.total).toBe(1)
    expect(stored.reports[0]?.page).toBe("https://canary.smithers.sh/")
    expect(stored.reports[0]?.userAgent).toBe("TestBrowser/1.0")
    expect((stored.reports[0]?.report as { message: string }).message).toBe("Cannot read properties of undefined")
    expect(Date.parse(stored.reports[0]?.at ?? "")).toBeGreaterThan(0)
  })

  test("a report that is not JSON is kept verbatim as text", async () => {
    const logs = memoryLog()
    await appendClientError(logs, { at: "2026-08-18T00:00:00.000Z", report: "boom, not json" })
    expect((await readClientErrors(logs)).reports[0]?.report).toBe("boom, not json")
  })
})

/*
 * The log lives under one storage key with a 128 KiB ceiling, and the route
 * accepts reports of up to 16 KiB. A count-only bound would let the value grow
 * past the limit, the put would throw, and — since appending must never fail
 * the report — the throw would be swallowed and the log would quietly stop
 * recording. These hold the byte bound that prevents exactly that.
 */
describe("the log stays inside one storage value", () => {
  const bigReport = (chars: number, at: string): ClientErrorRecord => ({
    at,
    report: { message: "x".repeat(chars) }
  })

  test("a single oversized report is truncated, and says so", () => {
    const capped = capRecord(bigReport(20_000, "2026-08-18T00:00:00.000Z"))
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(CLIENT_ERROR_RECORD_MAX_BYTES)
    expect(String(capped.report)).toContain("truncated from")
    // The head of the report survives — what broke is usually in the first lines.
    expect(String(capped.report)).toContain("xxxxx")
    expect(capped.at).toBe("2026-08-18T00:00:00.000Z")
  })

  test("a small report is left exactly as it was", () => {
    const small: ClientErrorRecord = { at: "2026-08-18T00:00:00.000Z", report: { message: "boom" } }
    expect(capRecord(small)).toEqual(small)
  })

  test("the log never exceeds its byte budget, whatever it is fed", async () => {
    const logs = memoryLog(unthrottled())
    for (let index = 0; index < CLIENT_ERROR_LOG_LIMIT + 20; index += 1) {
      await appendClientError(logs, bigReport(16_000, new Date(index).toISOString()))
    }
    const read = await readClientErrors(logs)
    expect(JSON.stringify(read.reports).length).toBeLessThanOrEqual(CLIENT_ERROR_LOG_MAX_BYTES)
    // Still a useful log, not one record.
    expect(read.reports.length).toBeGreaterThan(10)
    // And the newest survived: eviction takes from the old end.
    expect(read.reports[0]?.at).toBe(new Date(CLIENT_ERROR_LOG_LIMIT + 19).toISOString())
  })

  test("both bounds hold together: small reports are capped by count, large ones by bytes", () => {
    const small = Array.from({ length: 400 }, (_, index) => ({
      at: new Date(index).toISOString(),
      report: { i: index }
    }))
    expect(bounded(small)).toHaveLength(CLIENT_ERROR_LOG_LIMIT)
    const large = Array.from({ length: 400 }, (_, index) => capRecord(bigReport(16_000, new Date(index).toISOString())))
    const boundedLarge = bounded(large)
    expect(boundedLarge.length).toBeLessThan(CLIENT_ERROR_LOG_LIMIT)
    expect(JSON.stringify(boundedLarge).length).toBeLessThanOrEqual(CLIENT_ERROR_LOG_MAX_BYTES)
  })

  test("one report that alone exceeds the budget is still kept, not dropped into silence", () => {
    const huge: ClientErrorRecord = { at: "2026-08-18T00:00:00.000Z", report: "y".repeat(200_000) }
    expect(bounded([huge])).toHaveLength(1)
  })
})

/*
 * The store's limit is in bytes and JSON.stringify leaves non-ASCII literal,
 * so counting characters would under-measure exactly the reports written by
 * the users hardest to support.
 */
describe("the byte bound counts bytes, not characters", () => {
  test("a report in a non-ASCII language is measured at its real size", async () => {
    const logs = memoryLog()
    // Three bytes per character in UTF-8: 20k characters is ~60 KB.
    for (let index = 0; index < 20; index += 1) {
      await appendClientError(logs, {
        at: new Date(index).toISOString(),
        report: { message: "文".repeat(20_000) }
      })
    }
    const read = await readClientErrors(logs)
    const bytes = new TextEncoder().encode(JSON.stringify(read.reports)).length
    expect(bytes).toBeLessThanOrEqual(CLIENT_ERROR_LOG_MAX_BYTES)
  })

  test("a single non-ASCII report is truncated to its byte budget", () => {
    const capped = capRecord({ at: "2026-08-18T00:00:00.000Z", report: "文".repeat(20_000) })
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(
      CLIENT_ERROR_RECORD_MAX_BYTES
    )
  })
})

/*
 * The route is unauthenticated by design: it must record a crash that happens
 * before or during sign-in. So the only thing standing between an anonymous
 * flood and the log is the throttle, and a per-isolate counter is no throttle
 * at all — workerd runs many isolates. The log's own Durable Object is the one
 * authority, and it keeps a signed-in user's report out of an anonymous
 * flood's reach. The source a report counts against is the router's to name
 * (the client address, one IPv6 /64 per bucket); here it is the header.
 */
describe("the client-error throttle is the log's, not the isolate's", () => {
  const frozen = (): (() => number) => () => 1_700_000_000_000
  const anonymous = (index: number, chars = 3_500): ClientErrorRecord => ({
    at: new Date(index).toISOString(),
    report: { message: "x".repeat(chars), index }
  })
  const signedIn = (message: string): ClientErrorRecord => ({ at: "2026-08-18T00:00:00.000Z", signedIn: true, report: { message } })

  test("one genuine report survives 40 anonymous 4 KiB reports in one window", async () => {
    const logs = memoryLog(frozen())
    expect(await appendClientError(logs, signedIn("the real crash"), "198.51.100.9")).toBe("stored")
    for (let index = 0; index < 40; index += 1) {
      expect(await appendClientError(logs, anonymous(index), `203.0.113.${index}`)).toBe("stored")
    }
    const read = await readClientErrors(logs)
    expect(new TextEncoder().encode(JSON.stringify(read.reports)).length).toBeLessThanOrEqual(CLIENT_ERROR_LOG_MAX_BYTES)
    const genuine = read.reports.find((row) => (row.report as { message: string }).message === "the real crash")
    expect(genuine?.signedIn).toBe(true)
    // The flood still fills what is left: the noise is recorded, the report survives.
    expect(read.reports.length).toBeGreaterThan(10)
  })

  test("a signed-in report is never evicted by anonymous noise, however much arrives", async () => {
    const logs = memoryLog(unthrottled())
    await appendClientError(logs, signedIn("mine"))
    for (let index = 0; index < CLIENT_ERROR_LOG_LIMIT + 50; index += 1) {
      await appendClientError(logs, { at: new Date(index + 1).toISOString(), report: { message: "x".repeat(3_500) } })
    }
    const read = await readClientErrors(logs)
    expect(read.reports.some((row) => (row.report as { message: string }).message === "mine")).toBe(true)
    // Still newest first: the genuine report is the oldest in the log.
    expect(read.reports.at(-1)?.signedIn).toBe(true)
  })

  test("one source is capped inside the window, and other sources are not", async () => {
    const logs = memoryLog(frozen())
    for (let index = 0; index < CLIENT_ERROR_SOURCE_WINDOW_MAX; index += 1) {
      expect(await appendClientError(logs, anonymous(index, 10), "203.0.113.7")).toBe("stored")
    }
    expect(await appendClientError(logs, anonymous(CLIENT_ERROR_SOURCE_WINDOW_MAX, 10), "203.0.113.7")).toBe("throttled")
    expect(await appendClientError(logs, anonymous(1, 10), "203.0.113.1")).toBe("stored")
    expect((await readClientErrors(logs)).total).toBe(CLIENT_ERROR_SOURCE_WINDOW_MAX + 1)
  })

  test("a report with no source counts against the unknown source", async () => {
    const logs = memoryLog(frozen())
    for (let index = 0; index < CLIENT_ERROR_SOURCE_WINDOW_MAX; index += 1) {
      expect(await appendClientError(logs, anonymous(index, 10))).toBe("stored")
    }
    expect(await appendClientError(logs, anonymous(0, 10))).toBe("throttled")
    expect(await appendClientError(logs, anonymous(0, 10), CLIENT_ERROR_UNKNOWN_SOURCE)).toBe("throttled")
    expect(CLIENT_ERROR_SOURCE_HEADER).toBe("x-client-error-source")
  })

  test("the window ceiling is global across sources, and a new window opens it again", async () => {
    let now = 1_700_000_000_000
    const logs = memoryLog(() => now)
    for (let index = 0; index < CLIENT_ERROR_WINDOW_MAX; index += 1) {
      expect(await appendClientError(logs, anonymous(index, 10), `203.0.113.${index % 250}`)).toBe("stored")
    }
    expect(await appendClientError(logs, anonymous(251, 10), "203.0.113.251")).toBe("throttled")
    expect(await appendClientError(logs, signedIn("also refused: the ceiling is the ceiling"), "198.51.100.9")).toBe("throttled")
    now += CLIENT_ERROR_WINDOW_MS + 1
    expect(await appendClientError(logs, anonymous(251, 10), "203.0.113.251")).toBe("stored")
  })

  test("the object answers a throttled append with 429 in its own words", async () => {
    const logs = memoryLog(frozen())
    const stub = logs.get(logs.idFromName(CLIENT_ERROR_LOG_NAME))
    const append = () =>
      stub.fetch(
        new Request("https://client-errors.internal/append", {
          method: "POST",
          headers: { [CLIENT_ERROR_SOURCE_HEADER]: "203.0.113.7" },
          body: JSON.stringify(anonymous(0, 10))
        })
      )
    for (let index = 0; index < CLIENT_ERROR_SOURCE_WINDOW_MAX; index += 1) expect((await append()).status).toBe(200)
    const refused = await append()
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ status: "throttled" })
  })

  test("the page and the user agent are capped, so a record cannot outgrow its budget through its headers", () => {
    const capped = capRecord({
      at: "2026-08-18T00:00:00.000Z",
      page: `https://smithers.sh/#${"p".repeat(10_000)}`,
      userAgent: "u".repeat(10_000),
      report: { message: "boom" }
    })
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(CLIENT_ERROR_RECORD_MAX_BYTES)
    expect(new TextEncoder().encode(capped.page ?? "").length).toBeLessThanOrEqual(CLIENT_ERROR_TEXT_MAX_BYTES)
    expect(new TextEncoder().encode(capped.userAgent ?? "").length).toBeLessThanOrEqual(CLIENT_ERROR_TEXT_MAX_BYTES)
    expect(capped.page).toStartWith("https://smithers.sh/#ppp")
    expect(capped.report).toEqual({ message: "boom" })
  })
})
