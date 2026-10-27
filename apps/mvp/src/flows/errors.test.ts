// What went wrong in a tab lately (src/flows/errors.ts): the records a log event or an ended span becomes, as pure
// functions; then the ring itself, fed by its logger and tracer as the tab installs them, over Effect's real HTTP client
// whose `fetch` is a failing service a test injects (TEST-7): a server error, no network, an answer that is fine. None
// of it keeps a message, an annotation that isn't a code, or a query.
import { Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { ERRORS_KEPT, type ErrorRecord, fromLog, fromSpan, TabErrors } from "./errors"

const SECRET = `what someone wrote ${crypto.randomUUID()}`
const TRACE = "0123456789abcdef0123456789abcdef"
const DATE = new Date("2026-10-25T20:00:00.000Z")
const RECORDS: ReadonlySet<string> = new Set(["flow.dispatch", "bug.report", "page error", "unhandled rejection"])

describe("a log event", () => {
  const event = (overrides: Partial<Parameters<typeof fromLog>[0]> = {}) => ({
    message: "flow.dispatch",
    level: "Error",
    annotations: { flow: "app/bug/report", reason: "refused", note: SECRET },
    traceId: TRACE,
    date: DATE,
    ...overrides,
  })

  test("an error or a warning a relayed record names, by its name, its first code field and its trace", () => {
    expect(fromLog(event(), RECORDS)).toEqual({
      at: "2026-10-25T20:00:00.000Z",
      kind: "log",
      name: "flow.dispatch",
      code: "refused",
      traceId: TRACE,
    })
    expect(fromLog(event({ level: "Warn", annotations: { errorCode: "unavailable", code: "x", reason: "y" } }), RECORDS))
      .toMatchObject({ code: "unavailable" })
    expect(fromLog(event({ level: "Fatal", message: ["bug.report"], annotations: { "error.type": "503" } }), RECORDS))
      .toMatchObject({ name: "bug.report", code: "503" })
    // A short trace id is padded as OTLP pads it; anything else is none.
    expect(fromLog(event({ traceId: "abc" }), RECORDS)?.traceId).toBe(`${"0".repeat(29)}abc`)
    expect(fromLog(event({ traceId: undefined }), RECORDS)?.traceId).toBeNull()
    expect(fromLog(event({ traceId: "not hex" }), RECORDS)?.traceId).toBeNull()
  })

  test("an uncaught error or rejection is the page's, coded by the error's name", () => {
    expect(fromLog(event({ message: "page error", annotations: { name: "TypeError", source: "app.js:1:2" } }), RECORDS))
      .toMatchObject({ kind: "page", name: "page error", code: "TypeError" })
    expect(fromLog(event({ message: "unhandled rejection", annotations: { name: "string" } }), RECORDS))
      .toMatchObject({ kind: "page", code: "string" })
  })

  test("a code with spaces is prose, so none; no code field is none", () => {
    expect(fromLog(event({ annotations: { reason: SECRET } }), RECORDS)?.code).toBeNull()
    expect(fromLog(event({ annotations: {} }), RECORDS)?.code).toBeNull()
    expect(fromLog(event({ message: "page error", annotations: { name: SECRET } }), RECORDS)?.code).toBeNull()
  })

  test("nothing below a warning, and nothing the relay doesn't keep", () => {
    expect(fromLog(event({ level: "Info" }), RECORDS)).toBeUndefined()
    expect(fromLog(event({ message: SECRET }), RECORDS)).toBeUndefined()
    expect(fromLog(event({ message: 42 }), RECORDS)).toBeUndefined()
  })
})

describe("an ended span", () => {
  const span = (attributes: Record<string, unknown>, overrides: Partial<Parameters<typeof fromSpan>[0]> = {}) => ({
    name: "GET",
    kind: "client",
    attributes: new Map(Object.entries(attributes)),
    failed: false,
    traceId: TRACE,
    date: DATE,
    ...overrides,
  })

  test("a client request to /api/ answered 400 or more, by its method, path and status", () => {
    expect(fromSpan(span({ "http.request.method": "POST", "url.path": "/api/bugs", "http.response.status_code": 503 })))
      .toEqual({ at: "2026-10-25T20:00:00.000Z", kind: "http", name: "POST /api/bugs", code: "503", traceId: TRACE })
    expect(fromSpan(span({ "url.path": "/api/runs", "http.response.status_code": 401 }))).toMatchObject({ name: "GET /api/runs" })
    expect(fromSpan(span({ "url.path": `/api/${"x".repeat(300)}`, "http.response.status_code": 500 }))!.name)
      .toBe("GET /api/:id")
  })

  test("private repositories, file paths and queries never enter HTTP records", () => {
    const record = fromSpan(span({
      "http.request.method": "GET",
      "url.path": "/api/repos/private-owner/payroll-private/contents/config/keys.env?token=private-query",
      "http.response.status_code": 500,
    }))!
    expect(record.name).toBe("GET /api/repos/:owner/:repo/:id/:id/:id")
    expect(JSON.stringify(record)).not.toMatch(/private|keys\.env/)
  })

  test("one with no answer is network; one answered under 400, another kind or path is none", () => {
    expect(fromSpan(span({ "url.path": "/api/runs" }, { failed: true }))).toMatchObject({ code: "network" })
    expect(fromSpan(span({ "url.path": "/api/runs" }))).toBeUndefined()
    expect(fromSpan(span({ "url.path": "/api/runs", "http.response.status_code": 304 }, { failed: true }))).toBeUndefined()
    expect(fromSpan(span({ "url.path": "/api/runs", "http.response.status_code": 500 }, { kind: "server" }))).toBeUndefined()
    expect(fromSpan(span({ "url.path": "/assets/app.js", "http.response.status_code": 404 }))).toBeUndefined()
    expect(fromSpan(span({ "http.response.status_code": 500 }))).toBeUndefined()
  })
})

/** The browser's `fetch`, injected: each path answers as `answers` says. */
const fetchAnswering = (answers: Readonly<Record<string, () => Promise<Response>>>): typeof globalThis.fetch =>
  async (input, init) => {
    const url = new URL(new Request(input, init).url)
    return answers[url.pathname]!()
  }

/** Runs `effect` in a tab whose ring, of `kept`, observes its logs and spans, and answers the ring's records. */
const observed = (effect: Effect.Effect<unknown, unknown, HttpClient.HttpClient>, fetch: typeof globalThis.fetch, kept?: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.exit(effect)
      return yield* (yield* TabErrors).recent
    }).pipe(
      Effect.provide(Layer.mergeAll(
        TabErrors.observing(RECORDS, kept),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      )),
    ),
  )

describe("the tab's ring", () => {
  test("keeps failed /api/ requests and error logs as the tab records them, newest first, never what anyone wrote", async () => {
    const records = await observed(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* Effect.exit(client.get(`http://chat.test/api/runs?q=${encodeURIComponent(SECRET)}`))
        yield* Effect.exit(client.post("http://chat.test/api/bugs"))
        yield* Effect.exit(client.get("http://chat.test/api/ok"))
        yield* Effect.exit(client.get("http://chat.test/elsewhere"))
        yield* Effect.logError("flow.dispatch").pipe(
          Effect.annotateLogs({ reason: "refused", note: SECRET }),
          Effect.withSpan("flow.dispatch"),
        )
        yield* Effect.logError("page error").pipe(Effect.annotateLogs({ name: "TypeError" }))
        yield* Effect.logWarning("chat ready")
        yield* Effect.logInfo("bug.report")
      }),
      fetchAnswering({
        "/api/runs": () => Promise.resolve(new Response(SECRET, { status: 503 })),
        "/api/bugs": () => Promise.reject(new TypeError(SECRET)),
        "/api/ok": () => Promise.resolve(new Response("{}", { status: 200 })),
        "/elsewhere": () => Promise.resolve(new Response("", { status: 500 })),
      }),
    )
    expect(records.map(({ kind, name, code }) => ({ kind, name, code }))).toEqual([
      { kind: "page", name: "page error", code: "TypeError" },
      { kind: "log", name: "flow.dispatch", code: "refused" },
      { kind: "http", name: "POST /api/bugs", code: "network" },
      { kind: "http", name: "GET /api/runs", code: "503" },
    ])
    // The log in a span carries its trace; each record its time.
    expect(records[1]!.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(records.every((record) => !Number.isNaN(Date.parse(record.at)))).toBe(true)
    expect(JSON.stringify(records)).not.toContain(SECRET)
    expect(JSON.stringify(records)).not.toContain("q=")
  })

  test("keeps only its latest records: thirty unless told", async () => {
    expect(ERRORS_KEPT).toBe(30)
    const logs = Effect.forEach(["a", "b", "c", "d"], (reason) =>
      Effect.logError("flow.dispatch").pipe(Effect.annotateLogs({ reason })), { discard: true })
    const records: ReadonlyArray<ErrorRecord> = await observed(logs, fetchAnswering({}), 2)
    expect(records.map(({ code }) => code)).toEqual(["d", "c"])
    const all = await observed(
      Effect.forEach(Array.from({ length: 35 }, (_, index) => `r${index}`), (reason) =>
        Effect.logError("flow.dispatch").pipe(Effect.annotateLogs({ reason })), { discard: true }),
      fetchAnswering({}),
    )
    expect(all).toHaveLength(ERRORS_KEPT)
    expect(all[0]!.code).toBe("r34")
  })

  test("a span the tracer ends keeps ending as the tracer underneath ends it", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.succeed("done").pipe(Effect.withSpan("plain"), Effect.provide(TabErrors.observing(RECORDS))),
    )
    expect(exit).toEqual(Exit.succeed("done"))
  })
})
