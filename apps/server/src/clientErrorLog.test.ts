import { describe, expect, test } from "bun:test"
import {
  appendClientError,
  bounded,
  capRecord,
  CLIENT_ERROR_LOG_LIMIT,
  CLIENT_ERROR_LOG_MAX_BYTES,
  CLIENT_ERROR_RECORD_MAX_BYTES,
  CLIENT_ERROR_SOURCE_WINDOW_MAX,
  CLIENT_ERROR_TEXT_MAX_BYTES,
  CLIENT_ERROR_WINDOW_MAX,
  CLIENT_ERROR_WINDOW_MS,
  ClientErrorLog,
  readClientErrors
} from "./clientErrorLog"
import type { ClientErrorNamespace, ClientErrorRecord, ClientErrorStorage } from "./clientErrorLog"
import worker from "./index"
import type { WorkerEnv } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

/*
 * What broke in a user's browser has to survive longer than a `wrangler tail`.
 * These tests hold the log to being readable afterwards, bounded, and never
 * able to fail the report it is recording.
 */

const memoryStorage = (): ClientErrorStorage => {
  const data = new Map<string, unknown>()
  return {
    get: async (key) => data.get(key) as never,
    put: async (key, value) => void data.set(key, value)
  }
}

/**
 * A log with an injectable clock. The throttle window is the Durable Object's,
 * so a test that wants to feed the ring more than one window's worth of
 * reports advances the clock; a test of the throttle freezes it.
 */
const memoryLog = (now: () => number = Date.now): ClientErrorNamespace & { readonly names: () => Array<string> } => {
  const logs = new Map<string, ClientErrorLog>()
  return {
    names: () => [...logs.keys()],
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let log = logs.get(name)
      if (log === undefined) {
        log = new ClientErrorLog({ storage: memoryStorage(), now })
        logs.set(name, log)
      }
      return { fetch: (request) => log.fetch(request) }
    }
  }
}

/** Every read is a new throttle window: the ring alone is under test. */
const unthrottled = (): (() => number) => {
  let tick = 0
  return () => (tick += CLIENT_ERROR_WINDOW_MS + 1)
}

const adminEnv = (logs?: ClientErrorNamespace): WorkerEnv => ({
  ...memoryDurableObjects(),
  ASSETS: { fetch: async () => new Response("<html></html>", { status: 200 }) },
  IDENTITY_UPSTREAM_URL: "https://identity.test",
  ...(logs === undefined ? {} : { CLIENT_ERRORS: logs })
})

const withIdentity = async (
  session: { readonly login: string; readonly admin: boolean } | undefined,
  run: () => Promise<void>
): Promise<void> => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = typeof input === "string" ? new Request(input, init) : (input as Request)
    if (new URL(request.url).hostname === "identity.test") {
      return session === undefined
        ? new Response("{}", { status: 401 })
        : new Response(JSON.stringify({ ...session, allowlisted: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    }
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

const report = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`https://mvp.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  })

describe("the client-error log (Durable Object state)", () => {
  test("keeps reports newest first", async () => {
    const logs = memoryLog()
    await appendClientError(logs, { at: "2026-08-18T00:00:00.000Z", report: { message: "first" } })
    await appendClientError(logs, { at: "2026-08-18T00:00:01.000Z", report: { message: "second" } })
    const read = await readClientErrors(logs)
    expect(read.total).toBe(2)
    expect(read.reports.map((row) => (row.report as { message: string }).message)).toEqual(["second", "first"])
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

  test("a limit trims the read and never exceeds what is kept", async () => {
    const logs = memoryLog()
    for (let index = 0; index < 10; index += 1) {
      await appendClientError(logs, { at: new Date(index).toISOString(), report: { index } })
    }
    expect((await readClientErrors(logs, 3)).reports).toHaveLength(3)
    expect((await readClientErrors(logs, 10_000)).reports).toHaveLength(10)
  })

  test("with no namespace bound, appending is a no-op and the read is honestly empty", async () => {
    await appendClientError(undefined, { at: "2026-08-18T00:00:00.000Z", report: {} })
    expect(await readClientErrors(undefined)).toEqual({ total: 0, reports: [] })
  })

  test("a failing log never fails the report", async () => {
    const broken: ClientErrorNamespace = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => {
          throw new Error("durable object unavailable")
        }
      })
    }
    await appendClientError(broken, { at: "2026-08-18T00:00:00.000Z", report: {} })
  })
})

describe("the client-error route and its admin read", () => {
  test("a posted error is stored with when it arrived, the page, and the agent", async () => {
    const logs = memoryLog()
    const env = adminEnv(logs)
    const response = await worker.fetch(
      report(
        "/api/client-errors",
        { message: "Cannot read properties of undefined", stack: "at App" },
        { referer: "https://canary.smithers.sh/", "user-agent": "TestBrowser/1.0" }
      ),
      env
    )
    expect(response.status).toBe(202)
    const stored = await readClientErrors(logs)
    expect(stored.total).toBe(1)
    expect(stored.reports[0]?.page).toBe("https://canary.smithers.sh/")
    expect(stored.reports[0]?.userAgent).toBe("TestBrowser/1.0")
    expect((stored.reports[0]?.report as { message: string }).message).toBe(
      "Cannot read properties of undefined"
    )
    expect(Date.parse(stored.reports[0]?.at ?? "")).toBeGreaterThan(0)
  })

  test("a report that is not JSON is kept verbatim rather than dropped", async () => {
    const logs = memoryLog()
    const response = await worker.fetch(
      new Request("https://mvp.test/api/client-errors", { method: "POST", body: "boom, not json" }),
      adminEnv(logs)
    )
    expect(response.status).toBe(202)
    expect((await readClientErrors(logs)).reports[0]?.report).toBe("boom, not json")
  })

  test("an over-cap report is refused before the whole body is read", async () => {
    const logs = memoryLog()
    // A declared content-length over the 16 KiB cap: refused up front.
    const declared = await worker.fetch(
      new Request("https://mvp.test/api/client-errors", {
        method: "POST",
        headers: { "content-length": String(17 * 1024) },
        body: "x".repeat(17 * 1024)
      }),
      adminEnv(logs)
    )
    expect(declared.status).toBe(413)
    // A chunked body declares no length: the read stops at the cap instead.
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10 * 1024))
        controller.enqueue(new Uint8Array(10 * 1024))
      },
      cancel() {
        cancelled = true
      }
    })
    const streamed = await worker.fetch(
      new Request("https://mvp.test/api/client-errors", { method: "POST", body }),
      adminEnv(logs)
    )
    expect(streamed.status).toBe(413)
    expect(cancelled).toBe(true)
    expect((await readClientErrors(logs)).total).toBe(0)
  })

  test("every deployment writes to one log, so any request finds every report", async () => {
    const logs = memoryLog()
    await worker.fetch(report("/api/client-errors", { message: "a" }), adminEnv(logs))
    await worker.fetch(report("/api/client-errors", { message: "b" }), adminEnv(logs))
    expect(logs.names()).toEqual(["client-errors"])
  })

  test("the admin read answers the log, newest first", async () => {
    const logs = memoryLog()
    const env = adminEnv(logs)
    await withIdentity({ login: "will", admin: true }, async () => {
      await worker.fetch(report("/api/client-errors", { message: "older" }), env)
      await worker.fetch(report("/api/client-errors", { message: "newer" }), env)
      const response = await worker.fetch(
        new Request("https://mvp.test/api/admin/errors", { headers: { cookie: "smithers_session=abc" } }),
        env
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        total: number
        reports: Array<{ report: { message: string } }>
      }
      expect(body.total).toBe(2)
      expect(body.reports.map((row) => row.report.message)).toEqual(["newer", "older"])
    })
  })

  test("a non-admin gets the canonical unknown-route 404, never a 403", async () => {
    const env = adminEnv(memoryLog())
    await withIdentity({ login: "someone", admin: false }, async () => {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/admin/errors", { headers: { cookie: "smithers_session=abc" } }),
        env
      )
      expect(response.status).toBe(404)
      const unknown = await worker.fetch(
        new Request("https://mvp.test/api/definitely-not-a-route", {
          headers: { cookie: "smithers_session=abc" }
        }),
        env
      )
      expect(await response.text()).toBe(await unknown.text())
    })
  })

  test("an anonymous read is the same 404", async () => {
    const env = adminEnv(memoryLog())
    await withIdentity(undefined, async () => {
      const response = await worker.fetch(new Request("https://mvp.test/api/admin/errors"), env)
      expect(response.status).toBe(404)
    })
  })

  test("with no log bound the admin read says so instead of implying nothing broke", async () => {
    const env = adminEnv()
    await withIdentity({ login: "will", admin: true }, async () => {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/admin/errors", { headers: { cookie: "smithers_session=abc" } }),
        env
      )
      const body = (await response.json()) as { total: number; note?: string }
      expect(body.total).toBe(0)
      expect(body.note).toContain("nothing is stored")
    })
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
 * flood's reach.
 */
describe("the client-error throttle is the log's, not the isolate's", () => {
  const frozen = (): (() => number) => () => 1_700_000_000_000
  const anonymous = (index: number, chars = 3_500): Request =>
    report("/api/client-errors", { message: "x".repeat(chars), index }, { "cf-connecting-ip": `203.0.113.${index}` })
  const signedIn = (message: string): Request =>
    report("/api/client-errors", { message }, { cookie: "smithers_session=abc", "cf-connecting-ip": "198.51.100.9" })

  test("one genuine report survives 40 anonymous 4 KiB reports in one window", async () => {
    const logs = memoryLog(frozen())
    const env = adminEnv(logs)
    expect((await worker.fetch(signedIn("the real crash"), env)).status).toBe(202)
    for (let index = 0; index < 40; index += 1) {
      expect((await worker.fetch(anonymous(index), env)).status).toBe(202)
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
    await appendClientError(logs, { at: "2026-08-18T00:00:00.000Z", signedIn: true, report: { message: "mine" } })
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
    const env = adminEnv(logs)
    const flood = (index: number): Request =>
      report("/api/client-errors", { index }, { "cf-connecting-ip": "203.0.113.7" })
    for (let index = 0; index < CLIENT_ERROR_SOURCE_WINDOW_MAX; index += 1) {
      expect((await worker.fetch(flood(index), env)).status).toBe(202)
    }
    const refused = await worker.fetch(flood(CLIENT_ERROR_SOURCE_WINDOW_MAX), env)
    expect(refused.status).toBe(429)
    expect((await worker.fetch(anonymous(1, 10), env)).status).toBe(202)
    expect((await readClientErrors(logs)).total).toBe(CLIENT_ERROR_SOURCE_WINDOW_MAX + 1)
  })

  test("the window ceiling is global across sources, and a new window opens it again", async () => {
    let now = 1_700_000_000_000
    const logs = memoryLog(() => now)
    const env = adminEnv(logs)
    for (let index = 0; index < CLIENT_ERROR_WINDOW_MAX; index += 1) {
      expect((await worker.fetch(anonymous(index % 250, 10), env)).status).toBe(202)
    }
    expect((await worker.fetch(anonymous(251, 10), env)).status).toBe(429)
    expect((await worker.fetch(signedIn("also refused: the ceiling is the ceiling"), env)).status).toBe(429)
    now += CLIENT_ERROR_WINDOW_MS + 1
    expect((await worker.fetch(anonymous(251, 10), env)).status).toBe(202)
  })

  test("an IPv6 visitor's /64 is one source", async () => {
    const logs = memoryLog(frozen())
    const env = adminEnv(logs)
    for (let index = 0; index < CLIENT_ERROR_SOURCE_WINDOW_MAX; index += 1) {
      const ip = `2001:db8:0:0:${index.toString(16)}::1`
      expect((await worker.fetch(report("/api/client-errors", { index }, { "cf-connecting-ip": ip }), env)).status).toBe(202)
    }
    const response = await worker.fetch(report("/api/client-errors", {}, { "cf-connecting-ip": "2001:db8::ffff" }), env)
    expect(response.status).toBe(429)
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
