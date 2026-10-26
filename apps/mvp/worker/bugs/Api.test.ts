// Bug reports' routes (worker/bugs/Api.ts, docs/features/bugs.md) through their real handler, over this file's
// schema of the compose Postgres and through the compose Electric. Remote flow starts are recorded by a `FlowStarter`
// unless a test injects a failing one; Postgres and sessions fail only through injected faulty layers. Every test that
// files a report also searches what was recorded for what the person wrote, the page and the login.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { ConfigProvider, Data, Effect, Layer, Logger, Metric, Schema, Tracer } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import {
  BUG_REPORT_COLUMNS,
  BUG_REPORTS_ROUTE,
  BUG_REPORTS_SHAPE_ROUTE,
  LIST_DEFAULT,
  LIST_MAX,
  MAX_REPORT_BODY_BYTES,
} from "../../src/features/bugs/contract.ts"
import { Listed } from "../../src/features/bugs/schema.ts"
import * as Actor from "../Actor.ts"
import * as Flows from "../Flows.ts"
import { recorded, signedIn, signedOut, testFile } from "../test/harness.ts"
import * as BugsApi from "./Api.ts"

const runtime = testFile("bug_reports")

beforeEach(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE bug_reports`)))

/** What a person wrote, the page and the login: sentinels no record may carry. */
const WHAT = "The deploy button ate my branch sentinel-41ab"
const ROUTE = "/app/repos/acme/web-sentinel-9d2c"
const LOGIN = "maya-sentinel-77fe"
/** The deployment's read token in these tests: a sentinel too. */
const TOKEN = "bug-read-token-sentinel-0c3e"

const member: Actor.Actor = { subject: { kind: "person", id: "person-member" }, role: "member", login: LOGIN }
const admin: Actor.Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin", login: "admin-login" }
/** Signed in with no role on the repository, and no login known. */
const roleless: Actor.Actor = { subject: { kind: "person", id: "person-roleless" }, role: null }
const agentForMember: Actor.Actor = { ...member, act: { kind: "agent", id: "agent-run-1" } }
const agentForAdmin: Actor.Actor = { ...admin, act: { kind: "agent", id: "agent-run-2" } }

/** Sessions that can't be read. */
const unreadable = Layer.succeed(
  Actor.Sessions,
  Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) }),
)

class Unreachable extends Data.TaggedError("Unreachable")<{}> {}
/** A Postgres client that can't connect. */
const down = Layer.effect(SqlClient.SqlClient, Effect.fail(new Unreachable()))

type Start = { readonly flow: string; readonly executionId: string; readonly payload: unknown }

interface Options {
  /** Who is signed in: nobody unless set. */
  readonly actor?: Actor.Actor | null
  /** Sessions in place of `actor`. */
  readonly sessions?: Layer.Layer<Actor.Sessions>
  /** Where flows start: one that records each start unless set. */
  readonly starter?: Flows.FlowStarter["Service"]
  /** The database the routes reach: the file's schema unless set. */
  readonly database?: Layer.Layer<SqlClient.SqlClient, unknown>
  /** The deployment's configuration beside Electric's URL. */
  readonly config?: Record<string, string>
}

/** The bug routes on the file's schema, recording every log line, span, metric, start and Electric request. */
const open = async (options: Options = {}) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan(spanOptions)
      spans.push(span)
      return span
    },
  })
  const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const logger = Logger.make((logOptions) => void logs.push(StructuredLogger.formatStructured.log(logOptions)))
  const registry: Metric.MetricRegistry = new Map()
  /** Every request sent to Electric, as sent, before the table is pointed at the file's schema. */
  const electric: Array<URL> = []
  const toElectric: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    electric.push(new URL(url))
    const table = url.searchParams.get("table")
    if (table !== null) url.searchParams.set("table", `${scratch.name}.${table}`)
    return globalThis.fetch(url, init)
  }
  const config = ConfigProvider.fromUnknown({
    ELECTRIC_URL: await runtime.runPromise(TestDatabase.electricUrl),
    ...options.config,
  })
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(ConfigProvider.ConfigProvider, config),
    )
  const starts: Array<Start> = []
  const starter = options.starter ?? Flows.FlowStarter.of({
    start: (flow, { executionId, payload }) => Effect.sync(() => void starts.push({ flow: flow._tag, executionId, payload })),
  })
  const sessions = options.sessions ??
    (options.actor === undefined || options.actor === null ? signedOut : signedIn(options.actor))
  const api = await runtime.runPromise(observed(BugsApi.make(options.database ?? scratch.database)))
  const handler = HttpEffect.toWebHandler(
    observed(
      api.fetch.pipe(
        Effect.provideService(Flows.FlowStarter, starter),
        Effect.provide(sessions),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, toElectric),
      ),
    ),
  )
  const snapshot = () => runtime.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)))
  const line = (message: string) => logs.filter((log) => log.message === message)
  return {
    fetch: (path: string, init?: RequestInit) => handler(new Request(`http://chat.test${path}`, init)),
    starts,
    electric,
    logs,
    spans,
    snapshot,
    line,
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count,
  }
}

type Handler = Awaited<ReturnType<typeof open>>

/** A valid report: what the person wrote, and everything their tab showed. */
const report = (overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  what: WHAT,
  route: ROUTE,
  repo: "acme/web",
  build: "b1234",
  traces: ["0123456789abcdef0123456789abcdef"],
  runs: ["8a6d2a52-3f2e-4f7e-9e0e-2f1c0e4b7a11"],
  failures: [{ flow: "chat/Answer", code: "model:rate_limited" }],
  browser: "Firefox 140",
  viewport: "1280x800",
  ...overrides,
})

const post = (h: Handler, body: unknown) =>
  h.fetch(BUG_REPORTS_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
  })

const list = (h: Handler, query = "", headers: Record<string, string> = {}) =>
  h.fetch(`${BUG_REPORTS_ROUTE}${query}`, { headers })

const json = async (response: Response) => [response.status, await response.json()] as const

/** The reports a read answered, held to the contract. */
const reportsOf = async (response: Response) => Schema.decodeUnknownSync(Listed)(await response.json()).reports

/** The reports as Postgres holds them. */
const rows = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<Record<string, unknown>>`
      SELECT id::text AS id, reporter_id AS "reporterId", reporter_login AS "reporterLogin",
        reporter_role AS "reporterRole", acted_by AS "actedBy", what, route, repo, build, traces, runs, failures, browser,
        viewport
      FROM bug_reports ORDER BY created_at, id`))

const at = (id: string, createdAt: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE bug_reports SET created_at = ${createdAt}::timestamptz WHERE id = ${id}`))

/** What a handler recorded that carries what a person wrote, a page, a login or the token: nothing, when it held. */
const leaks = (h: Handler) => [WHAT, ROUTE, LOGIN, TOKEN, "sentinel"].filter((value) => recorded(h).includes(value))

describe("POST /api/bugs", () => {
  test("a Member files a report: stored as theirs, ops/BugReport started once for it, answered with the transaction", async () => {
    const h = await open({ actor: member })
    const body = report()

    const response = await post(h, body)

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ id: body.id, txid: expect.any(Number) })
    expect(await rows()).toEqual([{
      id: body.id,
      reporterId: "person-member",
      reporterLogin: LOGIN,
      reporterRole: "member",
      actedBy: null,
      what: WHAT,
      route: ROUTE,
      repo: "acme/web",
      build: "b1234",
      traces: body.traces,
      runs: body.runs,
      failures: body.failures,
      browser: "Firefox 140",
      viewport: "1280x800",
    }])
    expect(h.starts).toEqual([{ flow: "ops/BugReport", executionId: `bug-report-${body.id}`, payload: { id: body.id } }])
    expect(h.line("bug.request")).toMatchObject([{
      level: "INFO",
      annotations: { op: "file", outcome: "filed", status: 200, reportId: body.id, bytes: expect.any(Number) },
    }])
    expect(h.count(BugsApi.requests, { op: "file", outcome: "filed" })).toBe(1)
    const [span] = h.spans.filter((each) => each.name === "bug.request")
    expect(span!.attributes.get("http.response.status_code")).toBe(200)
    expect(leaks(h)).toEqual([])
  })

  test.each([
    ["an Admin", admin, { reporterId: "person-admin", reporterLogin: "admin-login", reporterRole: "admin", actedBy: null }],
    ["a person with no role and no login", roleless, {
      reporterId: "person-roleless",
      reporterLogin: null,
      reporterRole: null,
      actedBy: null,
    }],
    ["the agent acting for a Member", agentForMember, {
      reporterId: "person-member",
      reporterLogin: LOGIN,
      reporterRole: "member",
      actedBy: "agent",
    }],
  ] as const)("%s files one too, as who they are", async (_, actor, reporter) => {
    const h = await open({ actor })
    const body = report({ route: null, repo: null, traces: [], runs: [], failures: [] })

    expect(await json(await post(h, body))).toEqual([200, { id: body.id, txid: expect.any(Number) }])

    expect(await rows()).toMatchObject([{ ...reporter, route: null, repo: null, traces: [], runs: [], failures: [] }])
    expect(h.starts).toHaveLength(1)
    if (actor.act !== undefined) expect(h.line("bug.request")[0]!.annotations).toMatchObject({ by: "agent" })
    expect(leaks(h)).toEqual([])
  })

  test("who filed it comes from the actor alone: fields the body adds are ignored", async () => {
    const h = await open({ actor: member })
    const body = report({
      reporterId: "person-admin",
      reporter_id: "person-admin",
      reporterLogin: "admin-login",
      reporterRole: "admin",
      actedBy: "flow",
      createdAt: "2001-01-01T00:00:00.000Z",
    })

    expect((await post(h, body)).status).toBe(200)

    expect(await rows()).toMatchObject([{ reporterId: "person-member", reporterLogin: LOGIN, reporterRole: "member", actedBy: null }])
  })

  test("filing the same report again is one row, answered as filed with no transaction, and starts the same execution", async () => {
    const h = await open({ actor: member })
    const body = report()

    expect((await post(h, body)).status).toBe(200)
    expect(await json(await post(h, { ...body, what: "Changed my mind." }))).toEqual([200, { id: body.id, txid: null }])

    expect(await rows()).toMatchObject([{ id: body.id, what: WHAT }])
    expect(h.starts.map((start) => start.executionId)).toEqual([`bug-report-${body.id}`, `bug-report-${body.id}`])
    expect(h.line("bug.request")[1]!.annotations).toMatchObject({ existing: true, outcome: "filed" })
  })

  test("a report id someone else filed is refused 409, changing nothing and starting nothing", async () => {
    const body = report()
    expect((await post(await open({ actor: admin }), body)).status).toBe(200)
    const h = await open({ actor: member })

    expect(await json(await post(h, { ...body, what: "Mine now." }))).toEqual([409, { code: "conflict" }])

    expect(await rows()).toMatchObject([{ id: body.id, reporterId: "person-admin", what: WHAT }])
    expect(h.starts).toEqual([])
    expect(h.line("bug.request")).toMatchObject([{ level: "WARN", annotations: { code: "conflict", status: 409 } }])
  })

  test("a start the host can't record is 503 with the row kept; the browser's retry starts it and answers as filed", async () => {
    let calls = 0
    const starts: Array<string> = []
    const starter = Flows.FlowStarter.of({
      start: (_, { executionId }) =>
        calls++ === 0
          ? Effect.fail(new Flows.StartUnavailable({ errorCode: "object_unreachable" }))
          : Effect.sync(() => void starts.push(executionId)),
    })
    const h = await open({ actor: member, starter })
    const body = report()

    const refused = await post(h, body)
    expect([refused.status, refused.headers.get("cache-control"), await refused.json()]).toEqual([
      503,
      "no-store",
      { code: "unavailable" },
    ])
    expect(await rows()).toHaveLength(1)
    expect(h.line("bug.request")[0]).toMatchObject({
      level: "ERROR",
      annotations: { code: "unavailable", errorCode: "object_unreachable", status: 503 },
    })

    expect(await json(await post(h, body))).toEqual([200, { id: body.id, txid: null }])
    expect(starts).toEqual([`bug-report-${body.id}`])
    expect(await rows()).toHaveLength(1)
  })

  test("a start that finds the execution started already counts as started", async () => {
    const starter = Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartConflict()) })
    const h = await open({ actor: member, starter })
    const body = report()

    expect(await json(await post(h, body))).toEqual([200, { id: body.id, txid: expect.any(Number) }])
  })

  test.each([
    ["Postgres fails", { actor: member, database: down }, "Unreachable"],
    ["sessions can't be read", { sessions: unreadable }, "@smthrs/mvp/auth/SessionsUnavailable"],
  ] as const)("503 when %s, as an Error line with its code", async (_, options, errorCode) => {
    const h = await open(options)

    expect(await json(await post(h, report()))).toEqual([503, { code: "unavailable" }])

    expect(h.starts).toEqual([])
    expect(h.line("bug.request")).toMatchObject([{ level: "ERROR", annotations: { status: 503, errorCode } }])
    expect(leaks(h)).toEqual([])
  })

  test("signed out is refused 401, storing and starting nothing", async () => {
    const h = await open()

    const response = await post(h, report())

    expect([response.status, response.headers.get("cache-control"), await response.json()]).toEqual([
      401,
      "no-store",
      { code: "authentication" },
    ])
    expect(await rows()).toEqual([])
    expect(h.starts).toEqual([])
    expect(h.count(BugsApi.requests, { op: "file", outcome: "authentication" })).toBe(1)
  })

  test.each([
    ["nothing written", report({ what: "" }), 400, "invalid"],
    ["only spaces", report({ what: "  \n\t " }), 400, "invalid"],
    ["more than 4,000 characters", report({ what: `${WHAT} ${"x".repeat(4_000)}` }), 400, "invalid"],
    ["an id that isn't a UUID", report({ id: "report-1" }), 400, "invalid"],
    ["a trace id that isn't one", report({ traces: ["XYZ"] }), 400, "invalid"],
    ["21 trace ids", report({ traces: Array.from({ length: 21 }, () => "0123456789abcdef0123456789abcdef") }), 400, "invalid"],
    ["a failure's message in place of its code", report({ failures: [{ flow: "chat/Answer", code: WHAT }] }), 400, "invalid"],
    ["no build", (() => {
      const { build: _, ...rest } = report()
      return rest
    })(), 400, "invalid"],
    ["a NUL in what was written", report({ what: `${WHAT}\u0000` }), 400, "invalid"],
    ["a NUL in the page", report({ route: `${ROUTE}\u0000` }), 400, "invalid"],
    ["a NUL with no page", report({ route: null, browser: "Firefox\u0000" }), 400, "invalid"],
    ["a body that isn't JSON", `{"what":"${WHAT}"`, 400, "invalid"],
    ["a body that isn't UTF-8", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), 400, "invalid"],
    ["a body over 32 KiB", report({ what: `${WHAT}${"x".repeat(MAX_REPORT_BODY_BYTES)}` }), 413, "too_large"],
  ] as const)("refuses %s, storing, starting and recording nothing of it", async (_, body, status, code) => {
    const h = await open({ actor: member })

    const response = await post(h, body)

    expect([response.status, response.headers.get("cache-control"), await response.json()]).toEqual([
      status,
      "no-store",
      { code },
    ])
    expect(await rows()).toEqual([])
    expect(h.starts).toEqual([])
    expect(h.line("bug.request")).toMatchObject([{ level: "WARN", annotations: { op: "file", code, status } }])
    expect(leaks(h)).toEqual([])
  })

  test("405 for another method", async () => {
    const h = await open({ actor: admin })

    const response = await h.fetch(BUG_REPORTS_ROUTE, { method: "PUT", body: JSON.stringify(report()) })

    expect([response.status, response.headers.get("allow"), response.headers.get("cache-control")]).toEqual([
      405,
      "GET, POST",
      "no-store",
    ])
    expect(await rows()).toEqual([])
    expect(h.count(BugsApi.requests, { op: "file", outcome: "refused" })).toBe(1)
  })
})

describe("GET /api/bugs", () => {
  /** Three reports filed through the route at known times: a Member's, their agent's with no context, an Admin's. */
  const filed = async () => {
    const first = report()
    const second = report({ route: null, repo: null, traces: [], runs: [], failures: [] })
    const third = report({ what: "Admin's own." })
    expect((await post(await open({ actor: member }), first)).status).toBe(200)
    expect((await post(await open({ actor: agentForMember }), second)).status).toBe(200)
    expect((await post(await open({ actor: admin }), third)).status).toBe(200)
    await at(first.id, "2026-10-25T10:00:00.123Z")
    await at(second.id, "2026-10-25T11:00:00Z")
    await at(third.id, "2026-10-25T09:00:00Z")
    return { first, second, third }
  }

  test("an Admin reads every report, newest first, in camelCase with ISO times and arrays", async () => {
    const { first, second, third } = await filed()
    const h = await open({ actor: admin })

    const response = await list(h)

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = Schema.decodeUnknownSync(Listed)(await response.json())
    expect(body.reports.map((each) => each.id)).toEqual([second.id, first.id, third.id])
    expect(body.reports[1]).toEqual({
      id: first.id,
      reporterId: "person-member",
      reporterLogin: LOGIN,
      reporterRole: "member",
      actedBy: null,
      what: WHAT,
      route: ROUTE,
      repo: "acme/web",
      build: "b1234",
      traces: first.traces,
      runs: first.runs,
      failures: first.failures,
      browser: "Firefox 140",
      viewport: "1280x800",
      createdAt: "2026-10-25T10:00:00.123Z",
    })
    expect(body.reports[0]).toMatchObject({ actedBy: "agent", route: null, repo: null, traces: [], createdAt: "2026-10-25T11:00:00.000Z" })
    expect(h.line("bug.request")).toMatchObject([{
      level: "INFO",
      annotations: { op: "list", door: "session", outcome: "listed", count: 3, status: 200 },
    }])
    expect(h.count(BugsApi.requests, { op: "list", outcome: "listed" })).toBe(1)
    expect(leaks(h)).toEqual([])
  })

  test("the agent acting for an Admin reads them too", async () => {
    await filed()
    const h = await open({ actor: agentForAdmin })

    const response = await list(h)

    expect([response.status, (await reportsOf(response)).length]).toEqual([200, 3])
  })

  test("a bearer of the deployment's read token reads them without a session; the token is never recorded", async () => {
    await filed()
    const h = await open({ config: { BUG_REPORTS_READ_TOKEN: TOKEN } })

    const response = await list(h, "?limit=2", { authorization: `Bearer ${TOKEN}` })

    expect([response.status, (await reportsOf(response)).length]).toEqual([200, 2])
    expect(h.line("bug.request")).toMatchObject([{ annotations: { op: "list", door: "token", count: 2 } }])
    expect(leaks(h)).toEqual([])
  })

  test.each([
    ["signed out", { actor: null }, {}, 401, "authentication"],
    ["a wrong token", { config: { BUG_REPORTS_READ_TOKEN: TOKEN } }, { authorization: `Bearer ${TOKEN}x` }, 401, "authentication"],
    ["a wrong token, even from an Admin's browser", { actor: admin, config: { BUG_REPORTS_READ_TOKEN: TOKEN } }, {
      authorization: "Bearer guess",
    }, 401, "authentication"],
    ["a bearer while no token is configured", {}, { authorization: `Bearer ${TOKEN}` }, 401, "authentication"],
    ["a bearer while the token is blank", { config: { BUG_REPORTS_READ_TOKEN: "   " } }, { authorization: "Bearer x" }, 401, "authentication"],
    ["a Member", { actor: member }, {}, 403, "forbidden"],
    ["the agent acting for a Member", { actor: agentForMember }, {}, 403, "forbidden"],
    ["a person with no role", { actor: roleless }, {}, 403, "forbidden"],
  ] as const)("refuses %s", async (_, options, headers, status, code) => {
    await filed()
    const h = await open(options)

    const response = await list(h, "", headers)

    expect([response.status, response.headers.get("cache-control"), await response.json()]).toEqual([
      status,
      "no-store",
      { code },
    ])
    expect(h.line("bug.request")).toMatchObject([{ level: "WARN", annotations: { op: "list", code, status } }])
    expect(leaks(h)).toEqual([])
  })

  test(`answers ${LIST_DEFAULT} by default and up to ${LIST_MAX} when asked; a limit outside 1 to ${LIST_MAX} is invalid`, async () => {
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`
        INSERT INTO bug_reports (id, reporter_id, what, build, browser, viewport, created_at)
        SELECT gen_random_uuid(), 'person-member', 'It broke.', 'b1', 'Firefox', '1280x800',
          now() - make_interval(secs => n)
        FROM generate_series(1, ${LIST_DEFAULT + 1}) AS n`))
    const h = await open({ actor: admin })
    const count = async (query: string) => {
      const response = await list(h, query)
      return response.status === 200 ? (await reportsOf(response)).length : await response.json()
    }

    expect(await count("")).toBe(LIST_DEFAULT)
    expect(await count("?limit=1")).toBe(1)
    expect(await count(`?limit=${LIST_MAX}`)).toBe(LIST_DEFAULT + 1)
    expect(await count("?limit=0007")).toBe(7)
    for (const limit of ["0", String(LIST_MAX + 1), "-1", "1.5", "ten", "", "99999"]) {
      expect(await count(`?limit=${limit}`), limit).toEqual({ code: "invalid" })
    }
    expect(BugsApi.limitOf(null)).toBe(LIST_DEFAULT)
  })

  test("503 when Postgres fails, as an Error line with its code", async () => {
    const h = await open({ actor: admin, database: down })

    expect(await json(await list(h))).toEqual([503, { code: "unavailable" }])

    expect(h.line("bug.request")).toMatchObject([{ level: "ERROR", annotations: { op: "list", errorCode: "Unreachable" } }])
  })
})

describe("GET /api/shapes/bug-reports", () => {
  /** The rows a shape response carries. */
  const values = async (response: Response) =>
    ((await response.json()) as Array<{ readonly value?: Record<string, unknown> }>).flatMap((row) =>
      row.value === undefined ? [] : [row.value]
    )

  /** One report filed by a Member and one by an Admin, through the route. */
  const filed = async () => {
    const mine = report()
    const theirs = report({ what: "Admin's own." })
    expect((await post(await open({ actor: member }), mine)).status).toBe(200)
    expect((await post(await open({ actor: admin }), theirs)).status).toBe(200)
    return { mine, theirs }
  }

  const shape = (h: Handler) => h.fetch(`${BUG_REPORTS_SHAPE_ROUTE}?offset=-1`)

  test("an Admin in person syncs every report, with every column", async () => {
    const { mine, theirs } = await filed()
    const h = await open({ actor: admin })

    const synced = await values(await shape(h))

    expect(synced.map((row) => row.id).sort()).toEqual([mine.id, theirs.id].sort())
    expect(Object.keys(synced[0]!).sort()).toEqual([...BUG_REPORT_COLUMNS].sort())
    expect(h.electric.map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { offset: "-1", table: "bug_reports", columns: BUG_REPORT_COLUMNS.join(",") },
    ])
    expect(h.count(BugsApi.shapes, { status: "200", live: "false" })).toBe(1)
  })

  const own: ReadonlyArray<readonly [string, Actor.Actor | null, string, ReadonlyArray<"mine" | "theirs">]> = [
    ["a Member syncs their own reports only", member, "person-member", ["mine"]],
    ["the agent acting for an Admin syncs the Admin's own only", agentForAdmin, "person-admin", ["theirs"]],
    ["a person with no role syncs their own: none", roleless, "person-roleless", []],
    ["signed out syncs nothing", null, "", []],
  ]
  test.each(own)("%s", async (_, actor, reporter, expected) => {
    const reports = await filed()
    const h = await open({ actor })

    const synced = await values(await shape(h))

    expect(synced.map((row) => row.id)).toEqual(expected.map((which) => reports[which].id))
    expect(h.electric.map((url) => Object.fromEntries(url.searchParams))).toEqual([{
      offset: "-1",
      table: "bug_reports",
      where: "reporter_id = $1",
      "params[1]": reporter,
      columns: BUG_REPORT_COLUMNS.join(","),
    }])
    expect(recorded(h)).not.toContain(WHAT)
  })

  test("sessions that can't be read are 503 with a retry, without calling Electric", async () => {
    const h = await open({ sessions: unreadable })

    const response = await shape(h)

    expect([response.status, response.headers.get("retry-after")]).toEqual([503, "5"])
    expect(h.electric).toEqual([])
    expect(h.count(BugsApi.shapes, { status: "503", live: "false" })).toBe(1)
  })
})

describe("routing", () => {
  test("handles the reports' route and their shape, and nothing else", () => {
    expect(BugsApi.handles(BUG_REPORTS_ROUTE)).toBe(true)
    expect(BugsApi.handles(BUG_REPORTS_SHAPE_ROUTE)).toBe(true)
    expect(BugsApi.handles(`${BUG_REPORTS_ROUTE}/1`)).toBe(false)
    expect(BugsApi.handles("/api/shapes/bug-reports-2")).toBe(false)
  })
})
