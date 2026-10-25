// `ops/SandboxSpend` (worker/flows/SandboxSpend.ts, docs/features/sandbox-budgets.md#the-spend-alert) on the Node host
// (worker/test/flowHost.ts), its steps alone, and its start once a window, over this file's schema of the compose
// Postgres. Spend comes from real ledger rows; Admins are real sessions; alerts go to the local providers
// (worker/test/alertProviders.ts).
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Channels } from "@smthrs/notifications"
import { Cause, Effect, Exit, Layer, Logger, Metric, Redacted, Tracer } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as Budget from "../branch/Budget.ts"
import * as Flows from "../Flows.ts"
import { type AlertProviders, startAlertProviders } from "../test/alertProviders.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as SandboxSpend from "./SandboxSpend.ts"

const runtime = testFile("sandbox_spend")

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`TRUNCATE sandbox_generations, sandbox_limits, alert_channels, alert_deliveries, notifications, sessions, people CASCADE`))
)

const sql = <A extends object = Record<string, unknown>>(statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe<A>(statement))))

const database = () => runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))

const BOT_TOKEN = "123456:SYNTHETIC_SPEND_BOT"
const API_KEY = "re_SYNTHETIC_SPEND_KEY"
const ADDRESSES = ["will@example.com"]
const CHAT = "-1009876543210"
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

/** `hours` of machine time on `instance`, ended now. */
const spent = (hours: number, instance = "standard-4") =>
  sql(`
    INSERT INTO sandbox_generations (branch_id, generation, kind, instance, started_at, seen_at, ended_at)
    VALUES ('${crypto.randomUUID()}', 1, 'branch', '${instance}', now() - make_interval(secs => ${hours * 3600}),
      now(), now())`)

const bellRows = () =>
  sql<{ recipient: string; subject: string; kind: string; state: string; title: string; href: string }>(
    `SELECT recipient, subject, kind, state, title, href FROM notifications ORDER BY recipient`,
  )

const receipts = () =>
  sql<{ alertId: string; channel: string; status: string }>(
    `SELECT alert_id AS "alertId", channel, status FROM alert_deliveries ORDER BY channel`,
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
  const read = <S>(metric: Metric.Metric<number, S>) =>
    Effect.runSync(Metric.value(metric).pipe(Effect.provideService(Metric.MetricRegistry, registry)))
  const count = (outcome: string) => read(Metric.withAttributes(SandboxSpend.samples, { outcome })).count
  return { exit, lines, spans, read, count }
}

const window = () => Flows.windowAt(Date.now(), SandboxSpend.WINDOW)

/** Hours on standard-4 that cost `usd`. */
const hoursFor = (usd: number) => usd / (Budget.pricePerSecond("standard-4") * 3600)

const month = () => Budget.monthOf(Date.now()).label

describe("the sample", () => {
  test("prices the month's machine time against the Admins' alert: under it, at it, and off at 0", async () => {
    await runtime.runPromise(Budget.setLimits({ awake: 20, perPerson: 2, monthlyAlertUsd: 10 }, "a"))
    await spent(hoursFor(4))
    const under = await runtime.runPromise(SandboxSpend.sample(Date.now()))
    expect(under).toMatchObject({ month: month(), limitUsd: 10, over: false, awake: 0, alertId: `sandbox-spend-${month()}-10` })
    expect(under.usd).toBeCloseTo(4, 2)

    await spent(hoursFor(7))
    expect(await runtime.runPromise(SandboxSpend.sample(Date.now()))).toMatchObject({ over: true })

    await runtime.runPromise(Budget.setLimits({ awake: 20, perPerson: 2, monthlyAlertUsd: 0 }, "a"))
    expect(await runtime.runPromise(SandboxSpend.sample(Date.now()))).toMatchObject({ over: false, limitUsd: 0 })
  })

  test("it records each sample: Info under, Warn over, the spend and awake gauges, a count and a span", async () => {
    const db = await database()
    await runtime.runPromise(Budget.setLimits({ awake: 20, perPerson: 2, monthlyAlertUsd: 10 }, "a"))
    await runtime.runPromise(Budget.started({ branchId: "awake", personId: null, kind: "job", generation: 1, instance: "basic" }))
    const current = window()
    const under = await observed(SandboxSpend.observedSample(current, db))
    await spent(hoursFor(12))
    const over = await observed(SandboxSpend.observedSample(current, db))

    expect(under.lines).toMatchObject([{
      message: "sandbox.spend",
      level: "INFO",
      annotations: { outcome: "under", month: month(), awake: 1, limitUsd: 10 },
    }])
    expect(under.read(Budget.awakeGauge).value).toBe(1)
    expect(under.count("under")).toBe(1)
    expect(over.lines).toMatchObject([{ message: "sandbox.spend", level: "WARN", annotations: { outcome: "over", usd: 12 } }])
    expect(over.read(SandboxSpend.spendGauge).value).toBeCloseTo(12, 1)
    expect(over.count("over")).toBe(1)
    const [span] = over.spans.filter((each) => each.name === "sandbox.spend")
    expect(span!.attributes.get("smithers.sandbox_spend.id")).toBe(SandboxSpend.executionId(current))
  })

  test("Postgres failing fails the step with SpendUnavailable, logged and counted by its code", async () => {
    const unreachable = Database.layer(
      Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")),
    )
    const failed = await observed(SandboxSpend.observedSample(window(), unreachable))
    expect(Exit.isFailure(failed.exit) && Cause.squash(failed.exit.cause)).toEqual(
      new SandboxSpend.SpendUnavailable({ reason: "database" }),
    )
    expect(failed.lines).toMatchObject([{
      message: "sandbox.spend",
      level: "WARN",
      annotations: { outcome: "failed", errorCode: expect.stringMatching(/^sql:/) },
    }])
    expect(failed.count("failed")).toBe(1)
  })
})

describe("ops/SandboxSpend on the Node host", () => {
  test("under the alert it samples, rings no bell and sends nothing, even with both channels set", async () => {
    await setChannel("email", ADDRESSES)
    await setChannel("telegram", [CHAT])
    await person("admin")
    await spent(hoursFor(1))

    const ran = await runFlow(SandboxSpend.SandboxSpend, window(), SandboxSpend.registration(await database(), channels()))

    expect(ran.status).toBe("completed")
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toMatchObject({
      sample: { over: false },
      bell: { admins: 0 },
      email: { outcome: "none" },
      telegram: { outcome: "none" },
    })
    expect(await bellRows()).toEqual([])
    expect(providers.received).toEqual([])
  })

  test("at the alert: every Admin's bell, never a Member's or an ended session's; one email and one Telegram message; once a month", async () => {
    await setChannel("email", ADDRESSES)
    await setChannel("telegram", [CHAT])
    const maya = await person("admin")
    const ben = await person("admin")
    await person("member")
    await person("admin", "revoked")
    await person("admin", "expired")
    await spent(hoursFor(104.2))
    const registration = SandboxSpend.registration(await database(), channels())

    const ran = await runFlow(SandboxSpend.SandboxSpend, window(), registration)

    expect(ran.status).toBe("completed")
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toMatchObject({
      sample: { over: true, limitUsd: 100 },
      bell: { admins: 2 },
      email: { outcome: "sent" },
      telegram: { outcome: "sent" },
    })
    const subject = `sandbox-spend:${month()}:100`
    const row = { subject, kind: "spend", state: "update", title: "$104.20 this month · alert at $100", href: "/app/settings" }
    expect(await bellRows()).toEqual([{ recipient: maya, ...row }, { recipient: ben, ...row }].sort((a, b) =>
      a.recipient.localeCompare(b.recipient)
    ))
    const words = "Sandbox spend · $104.20 this month · alert at $100"
    const email = providers.received.find((request) => request.provider === "email")
    const telegram = providers.received.find((request) => request.provider === "telegram")
    expect(email!.headers["idempotency-key"]).toBe(`sandbox-spend-${month()}-100`)
    expect(email!.body).toEqual({
      from: "Smithers <alerts@example.com>",
      to: ADDRESSES,
      subject: words,
      text: "https://smithers.test/app/settings",
    })
    expect(telegram!.body).toMatchObject({ chat_id: CHAT, text: `${words}\n\nhttps://smithers.test/app/settings` })

    // The next window of the same month: no second bell, no second message.
    const next = await runFlow(
      SandboxSpend.SandboxSpend,
      { from: window().until, until: window().until + 3_600_000 },
      registration,
    )
    expect(Exit.isSuccess(next.exit) && next.exit.value).toMatchObject({
      bell: { admins: 0 },
      email: { outcome: "existing" },
      telegram: { outcome: "existing" },
    })
    expect(providers.received).toHaveLength(2)
    expect(await receipts()).toMatchObject([
      { alertId: `sandbox-spend-${month()}-100`, channel: "email", status: "sent" },
      { alertId: `sandbox-spend-${month()}-100`, channel: "telegram", status: "sent" },
    ])
  })

  test("the execution names the window; the alert names the month and the limit", () => {
    expect(SandboxSpend.executionId({ from: 3_600_000, until: 7_200_000 })).toBe("sandbox-spend-3600000-3600000")
    expect(SandboxSpend.alertIdOf({ month: "2026-10", limitUsd: 100 })).toBe("sandbox-spend-2026-10-100")
  })
})

describe("the bell and the delivery steps", () => {
  test("the bell logs how many Admins it reached; Postgres down is SpendUnavailable, for the engine to retry", async () => {
    await person("admin")
    const alert = { alertId: `sandbox-spend-${month()}-100`, usd: 101, limitUsd: 100 }
    const rang = await observed(SandboxSpend.observedBell(alert, await database()))
    expect(rang.exit).toEqual(Exit.succeed({ admins: 1 }))
    expect(rang.lines).toMatchObject([{ message: "sandbox.spend.bell", level: "INFO", annotations: { admins: 1 } }])

    const down = Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("connection refused")))
    const failed = await observed(SandboxSpend.observedBell(alert, down))
    expect(Exit.isFailure(failed.exit) && Cause.squash(failed.exit.cause)).toEqual(
      new SandboxSpend.SpendUnavailable({ reason: "database" }),
    )
    expect(failed.lines).toMatchObject([{ message: "sandbox.spend.bell", level: "WARN" }])
  })

  test("a channel no Admin set is off; a provider that is down fails the step to retry, then sends", async () => {
    const request = { alertId: `sandbox-spend-${month()}-100`, channel: "telegram" as const, usd: 101, limitUsd: 100 }
    const off = await observed(SandboxSpend.observedDeliver(request, await database()).pipe(Effect.provide(channels())))
    expect(off.exit).toEqual(Exit.succeed({ outcome: "off" }))

    await setChannel("telegram", [CHAT])
    providers.answer({ status: 503, json: { ok: false, error_code: 503, description: "Service Unavailable" } })
    const down = await observed(SandboxSpend.observedDeliver(request, await database()).pipe(Effect.provide(channels())))
    expect(Exit.isFailure(down.exit) && Cause.squash(down.exit.cause)).toBeInstanceOf(Channels.DeliveryFailed)
    const sent = await observed(SandboxSpend.observedDeliver(request, await database()).pipe(Effect.provide(channels())))
    expect(sent.exit).toEqual(Exit.succeed({ outcome: "sent" }))
    const counted = Metric.withAttributes(SandboxSpend.deliveries, { channel: "telegram", outcome: "sent" })
    expect(sent.read(counted).count).toBe(1)
    expect(JSON.stringify([...down.lines, ...sent.lines])).not.toContain(CHAT)
  })

  test("is irreversible and at least once: keyed by the alert and the channel", () => {
    expect(SandboxSpend.Deliver.tier).toBe("irreversible")
    const key = SandboxSpend.Deliver.idempotencyKey as (payload: SandboxSpend.DeliverRequest) => unknown
    const request = { alertId: "sandbox-spend-2026-10-100", channel: "email" as const, usd: 1, limitUsd: 1 }
    expect(key(request)).toEqual({ alert: "sandbox-spend-2026-10-100", channel: "email" })
  })

  test("the words: dollars to the cent, the limit, and the link to Settings", () => {
    expect(SandboxSpend.dollars(1234.5)).toBe("$1,234.50")
    expect(SandboxSpend.detailOf({ usd: 99.999, limitUsd: 1000 })).toBe("$100.00 this month · alert at $1,000")
    expect(SandboxSpend.alertWords({ usd: 5, limitUsd: 5 }, "https://smithers.sh/app")).toEqual({
      subject: "Sandbox spend · $5.00 this month · alert at $5",
      text: "https://smithers.sh/app/settings",
    })
  })
})

describe("the start once a window", () => {
  const starts = (starter: Flows.FlowStarter["Service"], times: number) =>
    observed(
      Effect.gen(function* () {
        const start = yield* SandboxSpend.sampler
        for (let index = 0; index < times; index++) yield* start
      }).pipe(Effect.provideService(Flows.FlowStarter, starter), Effect.provide(TestClock.layer())),
    )

  test("each alarm in an hour starts its one execution once, with the window as its payload", async () => {
    const started: Array<{ readonly flow: string; readonly executionId: string; readonly payload: unknown }> = []
    const ran = await starts(
      Flows.FlowStarter.of({
        start: (flow, { executionId, payload }) => Effect.sync(() => void started.push({ flow: flow._tag, executionId, payload })),
      }),
      3,
    )
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    expect(started).toEqual([
      { flow: "ops/SandboxSpend", executionId: "sandbox-spend-3600000-0", payload: { from: 0, until: 3_600_000 } },
    ])
  })

  test("a start the host can't record is an Error line and a count; the alarm goes on", async () => {
    const ran = await starts(
      Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "object_unreachable" })) }),
      1,
    )
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    expect(ran.lines).toMatchObject([{
      message: "sandbox.spend",
      level: "ERROR",
      annotations: { outcome: "not_started", errorCode: "object_unreachable" },
    }])
    expect(ran.count("not_started")).toBe(1)
  })
})
