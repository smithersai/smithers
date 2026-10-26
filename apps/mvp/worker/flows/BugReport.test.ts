// `ops/BugReport` (worker/flows/BugReport.ts, docs/features/bugs.md) on the Node host (worker/test/flowHost.ts)
// and its steps alone, over this file's schema of the compose Postgres. Reports are real rows; Admins are real
// sessions; alerts go to the local providers (worker/test/alertProviders.ts). Faults are injected services: a Postgres
// client that fails, and channels whose provider is down.
import { Action, Interpreter } from "@smthrs/flow"
import { Channels } from "@smthrs/notifications"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Cause, Effect, Exit, Layer, Logger, Metric, Redacted, Tracer } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { bugAlertId } from "../../src/features/bugs/contract.ts"
import { type AlertProviders, startAlertProviders } from "../test/alertProviders.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as AlertDelivery from "./AlertDelivery.ts"
import * as BugReport from "./BugReport.ts"

const runtime = testFile("bug_report_flow")

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`TRUNCATE bug_reports, alert_channels, alert_deliveries, notifications, sessions, people CASCADE`))
)

const sql = <A extends object = Record<string, unknown>>(statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe<A>(statement))))

const database = () => runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))

/** What a person wrote, the page and the login: sentinels no record may carry. */
const WHAT = "The deploy button ate my branch sentinel-5b1f"
const ROUTE = "/app/repos/acme/web-sentinel-77e2"
const LOGIN = "maya-sentinel-3c9d"

const BOT_TOKEN = "123456:SYNTHETIC_BUG_BOT"
const API_KEY = "re_SYNTHETIC_BUG_KEY"
const ADDRESSES = ["will@example.com"]
const CHAT = "-1001234500000"
const APP_URL = "https://smithers.test/app"

let providers: AlertProviders
beforeAll(async () => {
  providers = await startAlertProviders()
})
afterAll(() => providers.close())
beforeEach(() => void providers.received.splice(0))

const channels = () =>
  Channels.layer({
    email: { apiKey: Redacted.make(API_KEY), from: "Smithers <alerts@example.com>", url: providers.url },
    telegram: { token: Redacted.make(BOT_TOKEN), url: providers.url },
  })

/** Channels whose provider is down: every send fails, for the engine to retry. */
const down = Layer.succeed(
  Channels.Channels,
  Channels.Channels.of({
    available: ["email", "telegram"],
    send: (destination) => Effect.fail(new Channels.DeliveryFailed({ channel: destination._tag, code: "unavailable", status: 503 })),
  }),
)

/** A Postgres client that can't connect. */
const unreachable = Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("connection refused")))

const setChannel = (channel: "email" | "telegram", destinations: ReadonlyArray<string>) =>
  sql(`
    INSERT INTO alert_channels (channel, destinations, app_url, updated_by)
    VALUES ('${channel}', '${JSON.stringify(destinations)}'::jsonb, '${APP_URL}', 'person-admin')`)

/** A person with a session of `role`: live unless `ended` says how it ended. */
const person = async (role: string, ended?: "revoked" | "expired") => {
  const id = crypto.randomUUID()
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ('${id}', ${Math.floor(Math.random() * 1e9)}, 'p')`)
  await sql(`
    INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, expires_at, revoked_at)
    VALUES ('${crypto.randomUUID()}', '${crypto.randomUUID()}', '${id}', '${role}', now(),
      now() + interval '${ended === "expired" ? "-1 hour" : "1 day"}', ${ended === "revoked" ? "now()" : "NULL"})`)
  return id
}

/** A filed report by `login` on `route`; its id. */
const filed = async (login: string | null = LOGIN, route: string | null = ROUTE) => {
  const id = crypto.randomUUID()
  const quoted = (value: string | null) => (value === null ? "NULL" : `'${value}'`)
  await sql(`
    INSERT INTO bug_reports (id, reporter_id, reporter_login, reporter_role, what, route, build, browser, viewport)
    VALUES ('${id}', 'person-member', ${quoted(login)}, 'member', '${WHAT}', ${quoted(route)}, 'b1', 'Firefox', '1280x800')`)
  return id
}

const bellRows = () =>
  sql<{ recipient: string; subject: string; kind: string; state: string; title: string; href: string }>(
    `SELECT recipient, subject, kind, state, title, href FROM notifications ORDER BY recipient`,
  )

const receipts = () =>
  sql<{ alertId: string; channel: string; status: string; code: string | null }>(
    `SELECT alert_id AS "alertId", channel, status, code FROM alert_deliveries ORDER BY channel`,
  )

/** Runs `effect`, keeping every log line, metric and span it records. */
const observed = async <A, E>(effect: Effect.Effect<A, E>) => {
  const lines: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const logger = Logger.make((options) => void lines.push(StructuredLogger.formatStructured.log(options)))
  const registry: Metric.MetricRegistry = new Map()
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  const exit = await Effect.runPromiseExit(
    effect.pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  )
  const count = (attributes: Record<string, string>) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(BugReport.deliveries, attributes)).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    ).count
  const recorded = JSON.stringify({
    lines,
    spans: spans.map((span) => ({ name: span.name, attributes: [...span.attributes] })),
    metrics: Effect.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry))).map(
      (metric) => metric.attributes,
    ),
  })
  return { exit, lines, spans, count, recorded }
}

/** Whether `text` carries what the person wrote, the page or the login. */
const leaks = (text: string) => [WHAT, ROUTE, LOGIN, "sentinel"].filter((value) => text.includes(value))

describe("ops/BugReport on the Node host", () => {
  test("every live Admin's bell, never a Member's or an ended session's; one email and one Telegram message; once a report", async () => {
    await setChannel("email", ADDRESSES)
    await setChannel("telegram", [CHAT])
    const maya = await person("admin")
    const ben = await person("admin")
    await person("member")
    await person("admin", "revoked")
    await person("admin", "expired")
    const id = await filed()
    const registration = BugReport.registration(await database(), channels())

    const ran = await runFlow(BugReport.BugReport, { id }, registration, { executionId: bugAlertId(id) })

    expect(ran.status).toBe("completed")
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toEqual({
      bell: { admins: 2 },
      email: { outcome: "sent" },
      telegram: { outcome: "sent" },
    })
    const row = { subject: `bug:${id}`, kind: "bug", state: "update", title: `@${LOGIN} · ${ROUTE}`, href: "/app/bugs" }
    expect(await bellRows()).toEqual(
      [{ recipient: maya, ...row }, { recipient: ben, ...row }].sort((a, b) => a.recipient.localeCompare(b.recipient)),
    )
    const words = `Bug report · @${LOGIN} · ${ROUTE}`
    const email = providers.received.find((request) => request.provider === "email")
    const telegram = providers.received.find((request) => request.provider === "telegram")
    expect(email!.headers["idempotency-key"]).toBe(`bug-report-${id}`)
    expect(email!.body).toEqual({
      from: "Smithers <alerts@example.com>",
      to: ADDRESSES,
      subject: words,
      text: "https://smithers.test/app/bugs",
    })
    expect(telegram!.body).toMatchObject({ chat_id: CHAT, text: `${words}\n\nhttps://smithers.test/app/bugs` })
    // What the person wrote reaches neither a bell nor a message.
    expect(JSON.stringify([await bellRows(), providers.received])).not.toContain(WHAT)

    // Run again: no second bell, no second message.
    const again = await runFlow(BugReport.BugReport, { id }, registration)
    expect(Exit.isSuccess(again.exit) && again.exit.value).toEqual({
      bell: { admins: 0 },
      email: { outcome: "existing" },
      telegram: { outcome: "existing" },
    })
    expect(providers.received).toHaveLength(2)
    expect(await bellRows()).toHaveLength(2)
    expect(await receipts()).toEqual([
      { alertId: `bug-report-${id}`, channel: "email", status: "sent", code: null },
      { alertId: `bug-report-${id}`, channel: "telegram", status: "sent", code: null },
    ])
  })

  test("a report that isn't there rings no bell and sends nothing; a channel no Admin set is off", async () => {
    await setChannel("email", ADDRESSES)
    await person("admin")

    const ran = await runFlow(BugReport.BugReport, { id: crypto.randomUUID() }, BugReport.registration(await database(), channels()))

    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toEqual({
      bell: { admins: 0 },
      email: { outcome: "none" },
      telegram: { outcome: "off" },
    })
    expect(await bellRows()).toEqual([])
    expect(providers.received).toEqual([])
    expect(await receipts()).toEqual([])
  })

  test("with no channels set, the bell alone; a channel the deployment has no provider for is refused and recorded", async () => {
    await person("admin")
    const quiet = await filed(null, null)
    const rang = await runFlow(BugReport.BugReport, { id: quiet }, BugReport.registration(await database(), channels()))
    expect(Exit.isSuccess(rang.exit) && rang.exit.value).toEqual({
      bell: { admins: 1 },
      email: { outcome: "off" },
      telegram: { outcome: "off" },
    })
    expect((await bellRows())[0]).toMatchObject({ title: "someone" })

    await setChannel("telegram", [CHAT])
    const id = await filed(LOGIN, null)
    // The default channels: none, so every send is refused `unconfigured`.
    const refused = await runFlow(BugReport.BugReport, { id }, BugReport.registration(await database()))
    expect(Exit.isSuccess(refused.exit) && refused.exit.value).toEqual({
      bell: { admins: 1 },
      email: { outcome: "off" },
      telegram: { outcome: "refused" },
    })
    expect((await bellRows()).map((row) => row.title).sort()).toEqual([`@${LOGIN}`, "someone"])
    expect(await receipts()).toEqual([
      { alertId: `bug-report-${id}`, channel: "telegram", status: "refused", code: "unconfigured" },
    ])
    expect(providers.received).toEqual([])
  })

  test("Postgres failing the bell is retried by the engine until it rings", async () => {
    await person("admin")
    const id = await filed()
    const db = await database()
    let attempts = 0
    // Fails the bell's first attempt, then reaches the file's schema.
    const flaky = Layer.unwrap(Effect.sync((): Layer.Layer<SqlClient.SqlClient, unknown> => (attempts++ === 0 ? unreachable : db)))
    const registration = Interpreter.layerWithImplementations(
      BugReport.BugReport,
      Layer.mergeAll(
        BugReport.Bell.toLayer((report) => BugReport.observedBell(report, flaky)),
        BugReport.Deliver.toLayer((request) => BugReport.observedDeliver(request, db)),
      ),
    ).pipe(Layer.provide(channels()), Layer.provideMerge(Action.layerImplementations))

    const ran = await runFlow(BugReport.BugReport, { id }, registration)

    expect(ran.status).toBe("completed")
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toMatchObject({ bell: { admins: 1 } })
    expect(attempts).toBe(2)
  })
})

describe("the bell and the delivery steps", () => {
  test("the bell logs the alert and how many Admins it reached; Postgres down is BugReportUnavailable; never who or where", async () => {
    await person("admin")
    const id = await filed()
    const rang = await observed(BugReport.observedBell({ id }, await database()))
    expect(rang.exit).toEqual(Exit.succeed({ admins: 1 }))
    expect(rang.lines).toMatchObject([{
      message: "bug.report.bell",
      level: "INFO",
      annotations: { alertId: `bug-report-${id}`, admins: 1 },
    }])
    const [span] = rang.spans.filter((each) => each.name === "bug.report.bell")
    expect(span!.attributes.get("smithers.bug_report.id")).toBe(`bug-report-${id}`)

    const failed = await observed(BugReport.observedBell({ id }, unreachable))
    expect(Exit.isFailure(failed.exit) && Cause.squash(failed.exit.cause)).toEqual(
      new BugReport.BugReportUnavailable({ reason: "database" }),
    )
    expect(failed.lines).toMatchObject([{ message: "bug.report.bell", level: "WARN", annotations: { errorCode: "unknown" } }])
    expect(leaks(rang.recorded + failed.recorded)).toEqual([])
  })

  test("a provider that is down fails the step to retry, recording the failure; up again, it sends", async () => {
    await setChannel("email", ADDRESSES)
    const id = await filed()
    const request = { id, channel: "email" as const }

    const failing = await observed(BugReport.observedDeliver(request, await database()).pipe(Effect.provide(down)))
    expect(Exit.isFailure(failing.exit) && Cause.squash(failing.exit.cause)).toBeInstanceOf(Channels.DeliveryFailed)
    expect(failing.lines).toMatchObject([{
      message: "bug.report.delivery",
      level: "WARN",
      annotations: { channel: "email", outcome: "failed", errorCode: "unavailable", status: 503 },
    }])
    expect(await receipts()).toMatchObject([{ channel: "email", status: "failed", code: "unavailable" }])

    const sent = await observed(BugReport.observedDeliver(request, await database()).pipe(Effect.provide(channels())))
    expect(sent.exit).toEqual(Exit.succeed({ outcome: "sent" }))
    expect(sent.count({ channel: "email", outcome: "sent" })).toBe(1)
    expect(await receipts()).toMatchObject([{ channel: "email", status: "sent", code: null }])
    expect(providers.received).toHaveLength(1)
    expect(JSON.stringify(providers.received)).not.toContain(WHAT)
    expect(leaks(failing.recorded + sent.recorded)).toEqual([])
    expect(failing.recorded + sent.recorded).not.toContain("will@example.com")
  })

  test("Postgres failing a delivery is DeliverUnavailable, for the engine to retry", async () => {
    const failed = await observed(
      BugReport.observedDeliver({ id: crypto.randomUUID(), channel: "telegram" }, unreachable).pipe(Effect.provide(channels())),
    )
    expect(Exit.isFailure(failed.exit) && Cause.squash(failed.exit.cause)).toEqual(
      new AlertDelivery.DeliverUnavailable({ reason: "database" }),
    )
    expect(failed.count({ channel: "telegram", outcome: "failed" })).toBe(1)
  })

  test("is irreversible and at least once: keyed by the report's alert and the channel", () => {
    expect(BugReport.Deliver.tier).toBe("irreversible")
    const key = BugReport.Deliver.idempotencyKey as (payload: BugReport.DeliverRequest) => unknown
    const id = "00000000-0000-4000-8000-000000000001"
    expect(key({ id, channel: "telegram" })).toEqual({ alert: `bug-report-${id}`, channel: "telegram" })
  })
})

describe("the words", () => {
  test("who and where: the login and the page, the login alone with no page, someone with no login", () => {
    expect(BugReport.titleOf({ login: "maya", route: "/app/repos/acme/web" })).toBe("@maya · /app/repos/acme/web")
    expect(BugReport.titleOf({ login: "maya", route: null })).toBe("@maya")
    expect(BugReport.titleOf({ login: null, route: "/app" })).toBe("someone · /app")
    expect(BugReport.alertWords({ login: "maya", route: "/app" }, "https://smithers.sh/app")).toEqual({
      subject: "Bug report · @maya · /app",
      text: "https://smithers.sh/app/bugs",
    })
  })

  test("a long page is cut to what a bell row and a subject hold, with an ellipsis, never splitting a character", () => {
    const route = `/app/${"r".repeat(2_000)}`
    const title = BugReport.titleOf({ login: "maya", route })
    expect(title).toHaveLength(BugReport.MAX_TITLE)
    expect(title.endsWith("r…")).toBe(true)
    const words = BugReport.alertWords({ login: "maya", route }, "https://smithers.sh/app")
    expect(words.subject).toHaveLength(BugReport.MAX_TITLE)
    expect(words.subject.startsWith("Bug report · @maya · /app/r")).toBe(true)
    expect(BugReport.clip("abcdef", 4)).toBe("abc…")
    expect(BugReport.clip("ab\u{1F600}cd", 4)).toBe("ab…")
    expect(BugReport.clip("abcd", 4)).toBe("abcd")
  })

  test("a bell row that long fits Postgres' title", async () => {
    await person("admin")
    const id = await filed(LOGIN, `/app/${"x".repeat(2_000)}`)
    expect(await runtime.runPromise(BugReport.bell({ id }))).toEqual({ admins: 1 })
    expect((await bellRows())[0]!.title).toHaveLength(BugReport.MAX_TITLE)
  })
})
