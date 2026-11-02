// `ops/DatabaseLoad` (worker/flows/DatabaseLoad.ts, docs/features/database-alerts.md) on the Node host
// (worker/test/flowHost.ts), its steps alone, and its start once a window, over this file's schema of the compose
// Postgres. The sample reads the compose Postgres' own connections: a test that needs it over the share holds real
// connections open and alerts at a share they reach, never made-up numbers. Alerts go to the local providers
// (worker/test/alertProviders.ts); a provider that refuses is the local one answering 400.
import { PgClient } from "@effect/sql-pg"
import { Channels } from "@smthrs/notifications"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Cause, Context, Effect, Exit, Layer, Logger, Metric, Redacted, Tracer } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { ALERT_PERCENT } from "../../infra/Connections.ts"
import * as Flows from "../Flows.ts"
import { type AlertProviders, startAlertProviders } from "../test/alertProviders.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as AlertDelivery from "./AlertDelivery.ts"
import * as DatabaseLoad from "./DatabaseLoad.ts"

const runtime = testFile("database_load")

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE alert_channels, alert_deliveries`))
)

const sql = <A extends object = Record<string, unknown>>(statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe<A>(statement))))

const database = () =>
  runtime.runPromise(Effect.gen(function* () {
    return (yield* TestDatabase.Scratch).database
  }))

/** The compose Postgres' `max_connections`, as the server reports it. */
const serverMax = async () =>
  (await sql<{ max: number }>(`SELECT current_setting('max_connections')::int AS max`))[0]!.max

/** A client of the compose Postgres as `user`, for the scope that builds it: the server's own address otherwise. */
const client = (count: number, user?: { readonly name: string; readonly password: string }) =>
  Layer.unwrap(Effect.map(TestDatabase.serverUrl, (server) => {
    const url = new URL(server)
    if (user !== undefined) {
      url.username = user.name
      url.password = user.password
    }
    return PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: count })
  }))

/** Runs `use` while `count` more connections to the compose Postgres stay open, each a client backend. */
const holding = <A>(count: number, use: () => Promise<A>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const held = Context.get(yield* Layer.build(client(count)), SqlClient.SqlClient)
    for (let index = 0; index < count; index++) yield* held.reserve
    return yield* Effect.promise(use)
  })))

/** The share a sample is over while `count` connections are held: the most that many reach, at least 1%. */
const reachedBy = (count: number, max: number) => Math.max(1, Math.floor((count * 100) / max))

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
  const count = (outcome: string) => read(Metric.withAttributes(DatabaseLoad.samples, { outcome })).count
  return { exit, lines, spans, read, count }
}

/** A window that began a minute ago, as an alarm starts it. */
const window = () => Flows.windowAt(Date.now(), DatabaseLoad.WINDOW)

describe("the sample", () => {
  test("reads client connections in use and max_connections from Postgres; under the share, not over", async () => {
    const max = await serverMax()
    // No server is at 100%: the sample's own connection is a client backend, and it got in.
    const sampled = await runtime.runPromise(DatabaseLoad.sample(100))
    expect(sampled.max).toBe(max)
    expect(sampled.used).toBeGreaterThanOrEqual(1)
    expect(sampled.used).toBeLessThan(max)
    expect(sampled.over).toBe(false)
  })

  test("counts the connections other clients hold, and is over once they reach the share", async () => {
    const max = await serverMax()
    const held = Math.ceil(max / 50)
    const sampled = await holding(held, () => runtime.runPromise(DatabaseLoad.sample(reachedBy(held, max))))
    // The held connections and the sample's own.
    expect(sampled.used).toBeGreaterThanOrEqual(held + 1)
    expect(sampled.over).toBe(true)
  })

  test("reaches the share at its boundary: 90 of 112 is 80%, 89 is not", () => {
    expect(DatabaseLoad.reached({ used: 89, max: 112 }, ALERT_PERCENT)).toBe(false)
    expect(DatabaseLoad.reached({ used: 90, max: 112 }, ALERT_PERCENT)).toBe(true)
    expect(DatabaseLoad.reached({ used: 80, max: 100 }, ALERT_PERCENT)).toBe(true)
    expect(DatabaseLoad.reached({ used: 79, max: 100 }, ALERT_PERCENT)).toBe(false)
  })

  test("a role without pg_read_all_stats still counts the sessions it can't see the kind of", async () => {
    const role = { name: `load_probe_${crypto.randomUUID().replaceAll("-", "")}`, password: "probe" }
    await sql(`CREATE ROLE ${role.name} LOGIN PASSWORD '${role.password}'`)
    try {
      const held = 3
      const { visible, sampled } = await holding(held, () =>
        Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          const asRole = Context.get(yield* Layer.build(client(1, role)), SqlClient.SqlClient)
          const [own] = yield* asRole<{ readonly visible: number }>`
            SELECT count(*)::int AS visible FROM pg_stat_activity WHERE backend_type = 'client backend'`
          const sampled = yield* DatabaseLoad.sample(100).pipe(Effect.provideService(SqlClient.SqlClient, asRole))
          return { visible: own!.visible, sampled }
        }))))
      // The role sees only its own session's kind; the sample counts the held ones too.
      expect(visible).toBe(1)
      expect(sampled.used).toBeGreaterThanOrEqual(held + 1)
    } finally {
      await sql(`DROP ROLE ${role.name}`)
    }
  })

  test("it records each sample: Info under the share, Warn over it, both gauges, a count and a span", async () => {
    const db = await database()
    const max = await serverMax()
    const current = window()
    const under = await observed(DatabaseLoad.observedSample(current, 100, db))
    const held = Math.ceil(max / 50)
    const over = await holding(held, () => observed(DatabaseLoad.observedSample(current, reachedBy(held, max), db)))

    const sampled = Exit.isSuccess(under.exit) ? under.exit.value : undefined
    expect(under.lines).toMatchObject([{
      message: "database.connections",
      level: "INFO",
      annotations: { outcome: "under", used: sampled!.used, max, ratio: sampled!.used / max },
    }])
    // Only those numbers, and the span the line was written in.
    expect(Object.keys(under.lines[0]!.annotations).sort()).toEqual([
      "max",
      "outcome",
      "ratio",
      "span_id",
      "trace_id",
      "used",
    ])
    expect(under.lines[0]!.annotations.span_id).toBe(
      under.spans.find((each) => each.name === "database.connections")!.spanId,
    )
    expect(under.read(DatabaseLoad.connections).value).toBe(sampled!.used)
    expect(under.read(DatabaseLoad.maxConnections).value).toBe(max)
    expect(under.count("under")).toBe(1)
    // The step's span, with the query's inside it.
    const [span] = under.spans.filter((each) => each.name === "database.connections")
    expect(span!.attributes.get("smithers.database_load.id")).toBe(DatabaseLoad.executionId(current))
    expect(under.spans.filter((each) => each.name !== "database.connections").every((each) =>
      each.parent._tag === "Some" && each.parent.value.spanId === span!.spanId
    )).toBe(true)

    expect(over.lines).toMatchObject([
      { message: "database.connections", level: "WARN", annotations: { outcome: "over" } },
    ])
    expect(over.count("over")).toBe(1)
    expect(over.count("under")).toBe(0)
  })

  test("Postgres failing fails the step with SampleFailed, logged and counted by its code", async () => {
    // A Postgres that isn't there: nothing listens on port 1.
    const unreachable = Database.layer(
      Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")),
    )
    const failed = await observed(DatabaseLoad.observedSample(window(), ALERT_PERCENT, unreachable))
    expect(Exit.isFailure(failed.exit) && Cause.squash(failed.exit.cause)).toEqual(
      new DatabaseLoad.SampleFailed({ reason: "database" }),
    )
    expect(failed.lines).toMatchObject([{
      message: "database.connections",
      level: "WARN",
      annotations: { outcome: "failed", errorCode: expect.stringMatching(/^sql:/) },
    }])
    expect(failed.count("failed")).toBe(1)
  })
})

// Delivering the alert outside the app: the real `Channels` against the local providers.

const BOT_TOKEN = "123456:SYNTHETIC_LOAD_BOT"
const API_KEY = "re_SYNTHETIC_LOAD_KEY"
const ADDRESSES = ["will@example.com"]
const CHAT = "-1009876543210"
const APP_URL = "https://smithers.test/app"

let providers: AlertProviders
beforeAll(async () => {
  providers = await startAlertProviders()
})
afterAll(() => providers.close())
beforeEach(() => void providers.received.splice(0))

/** The deployment's channels, both at the local providers. */
const channels = () =>
  Channels.layer({
    email: { apiKey: Redacted.make(API_KEY), from: "Smithers <alerts@example.com>", url: providers.url },
    telegram: { token: Redacted.make(BOT_TOKEN), url: providers.url },
  })

/** An Admin's setting for `channel`, as `POST /api/alert-channels` writes it. */
const setChannel = (channel: "email" | "telegram", destinations: ReadonlyArray<string>) =>
  sql(`
    INSERT INTO alert_channels (channel, destinations, app_url, updated_by)
    VALUES ('${channel}', '${JSON.stringify(destinations)}'::jsonb, '${APP_URL}', 'person-admin')`)

const receipts = () =>
  sql<Record<string, unknown>>(`
    SELECT alert_id AS "alertId", channel, status, code, reason, http_status AS "httpStatus", attempts
    FROM alert_deliveries ORDER BY channel`)

describe("ops/DatabaseLoad on the Node host", () => {
  test("under the share it samples and sends nothing, even with both channels set", async () => {
    await setChannel("email", ADDRESSES)
    await setChannel("telegram", [CHAT])

    const ran = await runFlow(
      DatabaseLoad.DatabaseLoad,
      window(),
      DatabaseLoad.registration(await database(), channels(), { percent: 100 }),
    )

    expect(ran.status).toBe("completed")
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toMatchObject({
      sample: { over: false },
      email: { outcome: "none" },
      telegram: { outcome: "none" },
    })
    expect(providers.received).toEqual([])
    expect(await receipts()).toEqual([])
  })

  test("over the share, one email and one Telegram message with the numbers and the link, each with a receipt", async () => {
    await setChannel("email", ADDRESSES)
    await setChannel("telegram", [CHAT])
    const max = await serverMax()
    const held = Math.ceil(max / 50)
    const current = window()

    const ran = await holding(held, async () =>
      runFlow(
        DatabaseLoad.DatabaseLoad,
        current,
        DatabaseLoad.registration(await database(), channels(), { percent: reachedBy(held, max) }),
      ))

    expect(ran.status).toBe("completed")
    const outcome = Exit.isSuccess(ran.exit) ? ran.exit.value : undefined
    expect(outcome).toMatchObject({
      sample: { over: true, max },
      email: { outcome: "sent" },
      telegram: { outcome: "sent" },
    })
    const { used } = outcome!.sample
    // The shared channel never carries the counts (decision 0149).
    const subject = "Database connections high"
    expect(used).toBeGreaterThan(0)
    const id = DatabaseLoad.executionId(current)
    const email = providers.received.find((request) => request.provider === "email")
    const telegram = providers.received.find((request) => request.provider === "telegram")
    expect(providers.received).toHaveLength(2)
    expect(email!.headers["idempotency-key"]).toBe(id)
    expect(email!.body).toEqual({ from: "Smithers <alerts@example.com>", to: ADDRESSES, subject, text: APP_URL })
    expect(telegram!.body).toEqual({
      chat_id: CHAT,
      text: `${subject}\n\n${APP_URL}`,
      link_preview_options: { is_disabled: true },
    })
    const sent = { alertId: id, status: "sent", code: null, reason: null, httpStatus: null, attempts: 1 }
    expect(await receipts()).toEqual([{ ...sent, channel: "email" }, { ...sent, channel: "telegram" }])
  })

  test("the execution id names the window, so every alarm in a window starts the same one", () => {
    expect(DatabaseLoad.executionId({ from: 1_800_000, until: 2_100_000 })).toBe("database-load-300000-1800000")
    expect(Flows.windowAt(1_799_999, DatabaseLoad.WINDOW)).toEqual({ from: 1_500_000, until: 1_800_000 })
  })
})

/** The delivery step alone, as the engine runs it, keeping its log lines. */
const deliver = async (request: DatabaseLoad.DeliverRequest, layer: Layer.Layer<Channels.Channels> = channels()) =>
  observed(DatabaseLoad.observedDeliver(request, await database()).pipe(Effect.provide(layer)))

const request = (channel: "email" | "telegram"): DatabaseLoad.DeliverRequest => ({
  alertId: DatabaseLoad.executionId(window()),
  channel,
  used: 91,
  max: 112,
})

describe("the delivery step", () => {
  test("a channel no Admin set is off: no send, no receipt", async () => {
    const step = await deliver(request("email"))

    expect(Exit.isSuccess(step.exit) && step.exit.value).toEqual({ outcome: "off" })
    expect(providers.received).toEqual([])
    expect(await receipts()).toEqual([])
    expect(step.lines).toMatchObject([{
      message: "database.alert.delivery",
      level: "INFO",
      annotations: { channel: "email", outcome: "off" },
    }])
  })

  test("run again after it sent, it sends nothing more: one message, one receipt", async () => {
    await setChannel("telegram", [CHAT])

    const first = await deliver(request("telegram"))
    const again = await deliver(request("telegram"))

    expect(Exit.isSuccess(first.exit) && first.exit.value).toEqual({ outcome: "sent" })
    expect(Exit.isSuccess(again.exit) && again.exit.value).toEqual({ outcome: "existing" })
    expect(providers.received).toHaveLength(1)
    expect(providers.received[0]!.body).toMatchObject({
      text: `Database connections high\n\n${APP_URL}`,
    })
    expect(await receipts()).toMatchObject([{ channel: "telegram", status: "sent", attempts: 1 }])
  })

  test("a provider that refuses is recorded with its reason and not tried again; nothing names the chat", async () => {
    await setChannel("telegram", [CHAT])
    providers.answer({ status: 400, json: { ok: false, error_code: 400, description: "Bad Request: chat not found" } })

    const refused = await deliver(request("telegram"))
    const again = await deliver(request("telegram"))

    expect(Exit.isSuccess(refused.exit) && refused.exit.value).toEqual({ outcome: "refused" })
    expect(Exit.isSuccess(again.exit) && again.exit.value).toEqual({ outcome: "existing" })
    expect(await receipts()).toMatchObject([{
      channel: "telegram",
      status: "refused",
      code: "rejected",
      reason: "Bad Request: chat not found",
      httpStatus: 400,
      attempts: 1,
    }])
    expect(refused.lines).toMatchObject([{ level: "WARN", annotations: { channel: "telegram", outcome: "refused" } }])
    expect(refused.spans.map((span) => span.name)).toContain("database.alert.delivery")
    const counted = Metric.withAttributes(DatabaseLoad.deliveries, { channel: "telegram", outcome: "refused" })
    expect(refused.read(counted).count).toBe(1)
    const text = JSON.stringify(refused.lines)
    expect(text).not.toContain(CHAT)
    expect(text).not.toContain("SYNTHETIC_LOAD_BOT")
  })

  test("a deployment with no provider for the channel records it unconfigured", async () => {
    await setChannel("email", ADDRESSES)

    const step = await deliver(request("email"), AlertDelivery.noChannels)

    expect(Exit.isSuccess(step.exit) && step.exit.value).toEqual({ outcome: "refused" })
    expect(await receipts()).toMatchObject([{ status: "refused", code: "unconfigured" }])
  })

  test("is irreversible and at least once: keyed by the alert and the channel", () => {
    expect(DatabaseLoad.Deliver.tier).toBe("irreversible")
    const key = DatabaseLoad.Deliver.idempotencyKey as (payload: DatabaseLoad.DeliverRequest) => unknown
    expect(key(request("email"))).toEqual({ alert: request("email").alertId, channel: "email" })
    expect(key(request("email"))).not.toEqual(key(request("telegram")))
  })
})

describe("the alert's words", () => {
  test("the kind and the link, never the counts (decision 0149)", () => {
    expect(AlertDelivery.wordsOf(DatabaseLoad.NOTICE, APP_URL)).toEqual({ subject: "Database connections high", text: APP_URL })
  })
})

describe("the start once a window", () => {
  /** Runs the sampler's starts over `starter` on the test clock, keeping its log lines and counts. */
  const starts = (starter: Flows.FlowStarter["Service"], times: number) =>
    observed(
      Effect.gen(function* () {
        const start = yield* DatabaseLoad.sampler
        for (let index = 0; index < times; index++) yield* start
      }).pipe(Effect.provideService(Flows.FlowStarter, starter), Effect.provide(TestClock.layer())),
    )

  test("each alarm in a window starts its one execution once, with the window as its payload", async () => {
    const started: Array<{ readonly flow: string; readonly executionId: string; readonly payload: unknown }> = []
    const starter = Flows.FlowStarter.of({
      start: (flow, { executionId, payload }) =>
        Effect.sync(() => void started.push({ flow: flow._tag, executionId, payload })),
    })

    const ran = await starts(starter, 3)

    expect(Exit.isSuccess(ran.exit)).toBe(true)
    expect(started).toEqual([
      { flow: "ops/DatabaseLoad", executionId: "database-load-300000-0", payload: { from: 0, until: 300_000 } },
    ])
    expect(ran.lines).toEqual([])
  })

  test("a start the host can't record is an Error line and a count; the alarm goes on, and the next starts it", async () => {
    const attempts: Array<string> = []
    const starter = Flows.FlowStarter.of({
      start: (_flow, { executionId }) =>
        Effect.suspend(() => {
          attempts.push(executionId)
          return attempts.length === 1
            ? Effect.fail(new Flows.StartUnavailable({ errorCode: "object_unreachable" }))
            : Effect.void
        }),
    })

    const ran = await starts(starter, 3)

    expect(Exit.isSuccess(ran.exit)).toBe(true)
    expect(ran.lines).toEqual([expect.objectContaining({
      message: "database.connections",
      level: "ERROR",
      annotations: { outcome: "not_started", errorCode: "object_unreachable" },
    })])
    expect(ran.count("not_started")).toBe(1)
    expect(attempts).toEqual(["database-load-300000-0", "database-load-300000-0"])
  })
})
