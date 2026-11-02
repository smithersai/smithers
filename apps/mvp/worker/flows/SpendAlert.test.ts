// `ops/SpendAlert` (worker/flows/SpendAlert.ts, docs/features/spend-alerts.md) on the Node host
// (worker/test/flowHost.ts) and as its alert step alone, over this file's schema of the compose Postgres. The ledger
// rows are written as the model endpoint writes them; worker/ModelSpend.test.ts proves the endpoint starts the flow.
import { Channels } from "@smthrs/notifications"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Cause, Effect, Exit, Layer, Logger, Metric, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { type AlertProviders, startAlertProviders } from "../test/alertProviders.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as SpendAlert from "./SpendAlert.ts"

const runtime = testFile("spend_alert")

beforeEach(() =>
  runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`TRUNCATE model_usage, model_budget_days, spend_alerts, alert_channels, alert_deliveries`,
    ),
  )
)

const sql = <A extends object = Record<string, unknown>>(statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe<A>(statement))))

const database = () =>
  runtime.runPromise(Effect.gen(function* () {
    return (yield* TestDatabase.Scratch).database
  }))

/** One ledger row, as the endpoint writes it: what it reported, what it is charged, and when it was made. */
const call = (
  id: string,
  row: {
    readonly role?: string
    readonly model?: string
    readonly input?: number
    readonly output?: number
    readonly charged: number
    readonly at?: string
    readonly carried?: string
  },
) =>
  sql(`
    INSERT INTO model_usage (invocation_id, request_id, role, model_id, input_tokens, output_tokens, day,
      reserved_tokens, charged_tokens, expires_at, settled_at, created_at, spend_alert_id)
    VALUES ('${id}', 'r', '${row.role ?? "agent"}', '${row.model ?? "qwen-3.8-27b"}', ${row.input ?? 0},
      ${row.output ?? 0}, (now() AT TIME ZONE 'UTC')::date, ${row.charged}, ${row.charged}, now() + interval '1 hour',
      now(), ${row.at ?? "now() - interval '30 seconds'"}, ${row.carried === undefined ? "NULL" : `'${row.carried}'`})`)

const committed = (tokens: number) =>
  sql(`INSERT INTO model_budget_days (day, committed) VALUES ((now() AT TIME ZONE 'UTC')::date, ${tokens})`)

/** Which alert carried each call. */
const carried = async () =>
  Object.fromEntries(
    (await sql<{ id: string; alert: string | null }>(
      `SELECT invocation_id AS id, spend_alert_id AS alert FROM model_usage ORDER BY invocation_id`,
    )).map((row) => [row.id, row.alert]),
  )

const alertRows = () =>
  sql<Record<string, unknown>>(`
    SELECT id, kind, audience, calls, tokens::float8 AS tokens, cost_usd AS "costUsd", roles,
      day_tokens::float8 AS "dayTokens", budget::float8 AS budget,
      (extract(epoch FROM window_start) * 1000)::float8 AS "from",
      (extract(epoch FROM window_end) * 1000)::float8 AS "until",
      (extract(epoch FROM created_at) * 1000)::float8 AS "createdAt"
    FROM spend_alerts ORDER BY created_at`)

/** A window that ended a second ago. */
const ended = () => {
  const until = Date.now() - 1_000
  return { from: until - 60_000, until, budget: 10_000_000 }
}

/** Runs `effect` against the file's schema, keeping every log line and metric it records. */
const observed = async <A, E>(effect: Effect.Effect<A, E>) => {
  const lines: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const logger = Logger.make((options) => void lines.push(StructuredLogger.formatStructured.log(options)))
  const registry: Metric.MetricRegistry = new Map()
  const exit = await Effect.runPromiseExit(
    effect.pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  )
  const count = (outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(SpendAlert.alerts, { outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    ).count
  return { exit, lines, count }
}

// qwen-3.8-27b: $0.99 a million input tokens, $1.49 a million output; gpt-oss-120b: $0.35 and $0.75 (Pricing.table).
const QWEN = { input: 0.99, output: 1.49 }
const OSS = { input: 0.35, output: 0.75 }
const usd = (rates: { readonly input: number; readonly output: number }, input: number, output: number) =>
  (input * rates.input + output * rates.output) / 1_000_000

describe("ops/SpendAlert on the Node host", () => {
  test("waits for its window to end, then alerts once with each role's calls, tokens and estimated cost", async () => {
    const until = Date.now() + 400
    const window = { from: until - 900_000, until, budget: 10_000_000 }
    // Two agent calls: one settled, one whose usage was unknown, so it kept its 1,000,000-token reservation.
    await call("agent-settled", { input: 1_000_000, output: 500_000, charged: 1_500_000 })
    await call("agent-kept", { charged: 1_000_000 })
    await call("judge", { role: "judge", model: "gpt-oss-120b", input: 2_000, output: 1_000, charged: 3_000 })
    // Carried by the alert before spend alerts existed, and made after this window: neither is this alert's.
    await call("earlier", { charged: 99, carried: "before_spend_alerts" })
    await call("later", { charged: 77, at: "now() + interval '1 hour'" })
    await committed(2_503_176)

    const ran = await runFlow(SpendAlert.SpendAlert, window, SpendAlert.registration(await database()))

    const agentUsd = usd(QWEN, 1_000_000, 500_000) + usd(QWEN, 0, 1_000_000)
    const judgeUsd = usd(OSS, 2_000, 1_000)
    expect(ran.status).toBe("completed")
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toMatchObject({
      alert: { outcome: "recorded", calls: 3, tokens: 2_503_000 },
      // No Admin set a channel: the alert stays in the app.
      email: { outcome: "off" },
      telegram: { outcome: "off" },
    })
    const [alert] = await alertRows()
    expect(alert).toMatchObject({
      id: SpendAlert.executionId(window),
      kind: "model",
      audience: "admin",
      calls: 3,
      tokens: 2_503_000,
      dayTokens: 2_503_176,
      budget: 10_000_000,
      from: window.from,
      until: window.until,
    })
    expect(alert!.costUsd).toBeCloseTo(agentUsd + judgeUsd, 9)
    expect(alert!.roles).toEqual([
      { role: "agent", calls: 2, tokens: 2_500_000, costUsd: expect.closeTo(agentUsd, 9) },
      { role: "judge", calls: 1, tokens: 3_000, costUsd: expect.closeTo(judgeUsd, 9) },
    ])
    // It recorded only once the window ended.
    expect(alert!.createdAt as number).toBeGreaterThanOrEqual(until - 50)
    expect(await carried()).toEqual({
      "agent-kept": SpendAlert.executionId(window),
      "agent-settled": SpendAlert.executionId(window),
      earlier: "before_spend_alerts",
      judge: SpendAlert.executionId(window),
      later: null,
    })
  })

  test("the execution id names the window, so every call in a window starts the same one", () => {
    expect(SpendAlert.executionId({ from: 1_800_000, until: 2_700_000 })).toBe("spend-alert-900000-1800000")
    expect(SpendAlert.executionId({ from: 0, until: 3_600_000 })).toBe("spend-alert-3600000-0")
  })
})

describe("the alert step", () => {
  test("a role whose model no rate card prices has no cost, and neither has the alert", async () => {
    await call("priced", { input: 100, output: 100, charged: 200 })
    await call("unpriced", { role: "judge", model: "a-model-nobody-prices", input: 10, output: 5, charged: 15 })
    const result = await runtime.runPromise(SpendAlert.record(ended()))
    expect(result).toEqual({ outcome: "recorded", calls: 2, tokens: 215, costUsd: null })
    const [alert] = await alertRows()
    expect(alert!.costUsd).toBeNull()
    expect(alert!.roles).toEqual([
      { role: "agent", calls: 1, tokens: 200, costUsd: expect.closeTo(usd(QWEN, 100, 100), 12) },
      { role: "judge", calls: 1, tokens: 15, costUsd: null },
    ])
    // No row for today's budget yet: the alert reads 0.
    expect(alert!.dayTokens).toBe(0)
  })

  test("run again after it recorded, it returns its alert and claims nothing more", async () => {
    const window = ended()
    await call("first", { input: 10, output: 5, charged: 15 })
    const first = await runtime.runPromise(SpendAlert.record(window))
    await call("second", { input: 1, output: 1, charged: 2 })
    const again = await runtime.runPromise(SpendAlert.record(window))
    expect(again).toEqual({ ...first, outcome: "existing" })
    expect(await alertRows()).toHaveLength(1)
    expect((await carried()).second).toBeNull()
  })

  test("a window whose calls an earlier alert carried records nothing", async () => {
    await call("first", { input: 10, output: 5, charged: 15 })
    await runtime.runPromise(SpendAlert.record(ended()))
    const next = { ...ended(), from: Date.now() - 500, until: Date.now() }
    expect(await runtime.runPromise(SpendAlert.record(next))).toEqual({
      outcome: "none",
      calls: 0,
      tokens: 0,
      costUsd: null,
    })
    expect(await alertRows()).toHaveLength(1)
  })

  test("it records each outcome: a Warn line for an alert, Info otherwise, and counts it, with no content", async () => {
    const db = await database()
    const window = ended()
    await call("first", { input: 10, output: 5, charged: 15 })
    const recorded = await observed(SpendAlert.observedRecord(window, db))
    const again = await observed(SpendAlert.observedRecord(window, db))
    const none = await observed(SpendAlert.observedRecord({ ...window, from: 0, until: 1 }, db))

    expect(recorded.lines).toMatchObject([{
      message: "model.spend.alert",
      level: "WARN",
      annotations: { alertId: SpendAlert.executionId(window), outcome: "recorded", calls: 1, tokens: 15 },
    }])
    expect(recorded.lines[0]!.annotations).toHaveProperty("costUsd")
    expect(recorded.count("recorded")).toBe(1)
    expect(again.lines).toMatchObject([{ level: "INFO", annotations: { outcome: "existing" } }])
    expect(again.count("existing")).toBe(1)
    expect(none.lines).toMatchObject([{ level: "INFO", annotations: { outcome: "none", calls: 0, tokens: 0 } }])
    expect(none.lines[0]!.annotations).not.toHaveProperty("costUsd")
    expect(none.count("none")).toBe(1)
  })

  test("Postgres failing fails the step with AlertFailed, logged and counted by its code, and claims nothing", async () => {
    const db = await database()
    await call("first", { input: 10, output: 5, charged: 15 })
    await sql(`ALTER TABLE spend_alerts RENAME TO spend_alerts_away`)
    try {
      const failed = await observed(SpendAlert.observedRecord(ended(), db))
      expect(Exit.isFailure(failed.exit) && Cause.squash(failed.exit.cause)).toEqual(
        new SpendAlert.AlertFailed({ reason: "database" }),
      )
      expect(failed.lines).toMatchObject([{
        message: "model.spend.alert",
        level: "WARN",
        annotations: { outcome: "failed", errorCode: expect.stringMatching(/^sql:/) },
      }])
      expect(failed.count("failed")).toBe(1)
    } finally {
      await sql(`ALTER TABLE spend_alerts_away RENAME TO spend_alerts`)
    }
    expect((await carried()).first).toBeNull()
  })

  test("the wait is what is left of the window on the host's clock, and none once it ended", async () => {
    const now = Date.now()
    const left = await Effect.runPromise(SpendAlert.alertIn({ until: now + 60_000 }))
    expect(left).toBeGreaterThan(59_000)
    expect(left).toBeLessThanOrEqual(60_000)
    expect(await Effect.runPromise(SpendAlert.alertIn({ until: now - 1 }))).toBe(0)
  })
})

// Delivering an alert outside the app (docs/features/spend-alerts.md#channels): the real `Channels` against the local
// providers (worker/test/alertProviders.ts), and a faulty `Channels` injected for a provider that is down.

const BOT_TOKEN = "123456:SYNTHETIC_ALERT_BOT"
const API_KEY = "re_SYNTHETIC_ALERT_KEY"
const ADDRESSES = ["will@example.com", "ops@example.com"]
const CHAT = "-1001234567890"

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

/** A provider that is down: every send fails as `failure`. */
const down = (failure: Channels.DeliveryFailed) =>
  Layer.succeed(Channels.Channels)({ available: ["email", "telegram"], send: () => Effect.fail(failure) })

/** An Admin's setting for `channel`, as `POST /api/alert-channels` writes it. */
const setChannel = (channel: "email" | "telegram", destinations: ReadonlyArray<string>) =>
  sql(`
    INSERT INTO alert_channels (channel, destinations, app_url, updated_by)
    VALUES ('${channel}', '${JSON.stringify(destinations)}'::jsonb, 'https://smithers.test/app', 'person-admin')`)

const receipts = () =>
  sql<Record<string, unknown>>(`
    SELECT alert_id AS "alertId", channel, status, code, reason, http_status AS "httpStatus", provider_id AS "providerId",
      attempts
    FROM alert_deliveries ORDER BY channel`)

/** One recorded alert, for a window that ended a second ago: its request for `channel`. */
const recordedAlert = async (channel: "email" | "telegram") => {
  const window = ended()
  await call("call-1", { input: 12_000, output: 340, charged: 12_340 })
  await runtime.runPromise(SpendAlert.record(window))
  return { alertId: SpendAlert.executionId(window), channel, outcome: "recorded" as const }
}

/** The delivery step alone, as the engine runs it, keeping its log lines and counts. */
const deliver = async (request: SpendAlert.DeliverRequest, layer: Layer.Layer<Channels.Channels> = channels()) =>
  observed(SpendAlert.observedDeliver(request, await database()).pipe(Effect.provide(layer)))

describe("ops/SpendAlert delivers outside the app", () => {
  test("once the window ends, one email and one Telegram message, each with its receipt", async () => {
    await setChannel("email", ADDRESSES)
    await setChannel("telegram", [CHAT])
    await call("agent", { input: 12_000, output: 0, charged: 12_000 })
    await call("judge", { role: "judge", model: "gpt-oss-120b", input: 340, output: 0, charged: 340 })
    const window = ended()

    const ran = await runFlow(SpendAlert.SpendAlert, window, SpendAlert.registration(await database(), channels()))

    expect(ran.status).toBe("completed")
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toEqual({
      alert: expect.objectContaining({ outcome: "recorded", calls: 2, tokens: 12_340 }),
      email: { outcome: "sent" },
      telegram: { outcome: "sent" },
    })
    const id = SpendAlert.executionId(window)
    const email = providers.received.find((request) => request.provider === "email")
    const telegram = providers.received.find((request) => request.provider === "telegram")
    expect(providers.received).toHaveLength(2)
    expect(email!.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(email!.headers["idempotency-key"]).toBe(id)
    // The shared channel says only the kind and the link (decision 0149): tokens, dollars and roles stay in the app.
    const subject = "Model spend"
    const text = "https://smithers.test/app"
    expect(JSON.stringify(providers.received)).not.toContain("12,340")
    expect(email!.body).toEqual({ from: "Smithers <alerts@example.com>", to: ADDRESSES, subject, text })
    expect(telegram!.path).toBe(`/bot${BOT_TOKEN}/sendMessage`)
    expect(telegram!.body).toEqual({
      chat_id: CHAT,
      text: `${subject}\n\n${text}`,
      link_preview_options: { is_disabled: true },
    })
    // Each receipt keeps the provider's id for its message: the email's id, or the Telegram message's number.
    const sent = { alertId: id, status: "sent", code: null, reason: null, httpStatus: null, attempts: 1 }
    const emailAt = providers.received.indexOf(email!) + 1
    const telegramAt = providers.received.indexOf(telegram!) + 1
    expect(await receipts()).toEqual([
      { ...sent, channel: "email", providerId: `email-${emailAt}` },
      { ...sent, channel: "telegram", providerId: String(telegramAt) },
    ])
  })

  test("a window with nothing to carry sends nothing", async () => {
    await setChannel("email", ADDRESSES)

    const ran = await runFlow(SpendAlert.SpendAlert, ended(), SpendAlert.registration(await database(), channels()))

    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toMatchObject({
      alert: { outcome: "none" },
      email: { outcome: "none" },
      telegram: { outcome: "none" },
    })
    expect(providers.received).toEqual([])
    expect(await receipts()).toEqual([])
  })
})

describe("the delivery step", () => {
  test("a channel no Admin set is off: no send, no receipt", async () => {
    const step = await deliver(await recordedAlert("telegram"))

    expect(Exit.isSuccess(step.exit) && step.exit.value).toEqual({ outcome: "off" })
    expect(providers.received).toEqual([])
    expect(await receipts()).toEqual([])
    expect(step.lines).toMatchObject([{ message: "spend.alert.delivery", level: "INFO", annotations: { outcome: "off" } }])
  })

  test("an alert that isn't recorded sends nothing", async () => {
    await setChannel("email", ADDRESSES)
    const none = await deliver({ alertId: "spend-alert-900000-0", channel: "email", outcome: "none" })
    const missing = await deliver({ alertId: "spend-alert-900000-0", channel: "email", outcome: "recorded" })

    expect(Exit.isSuccess(none.exit) && none.exit.value).toEqual({ outcome: "none" })
    expect(Exit.isSuccess(missing.exit) && missing.exit.value).toEqual({ outcome: "none" })
    expect(providers.received).toEqual([])
  })

  test("run again after it sent, it sends nothing more", async () => {
    await setChannel("email", ADDRESSES)
    const request = await recordedAlert("email")

    await deliver(request)
    const again = await deliver(request)

    expect(Exit.isSuccess(again.exit) && again.exit.value).toEqual({ outcome: "existing" })
    expect(providers.received).toHaveLength(1)
    expect(await receipts()).toMatchObject([{ status: "sent", attempts: 1 }])
  })

  test("a provider that refuses is recorded with its reason and not tried again; nothing names the chat", async () => {
    await setChannel("telegram", [CHAT])
    providers.answer({ status: 400, json: { ok: false, error_code: 400, description: "Bad Request: chat not found" } })
    const request = await recordedAlert("telegram")

    const refused = await deliver(request)
    const again = await deliver(request)

    expect(Exit.isSuccess(refused.exit) && refused.exit.value).toEqual({ outcome: "refused" })
    expect(Exit.isSuccess(again.exit) && again.exit.value).toEqual({ outcome: "existing" })
    expect(providers.received).toHaveLength(1)
    expect(await receipts()).toEqual([{
      alertId: request.alertId,
      channel: "telegram",
      status: "refused",
      code: "rejected",
      reason: "Bad Request: chat not found",
      httpStatus: 400,
      providerId: null,
      attempts: 1,
    }])
    expect(refused.lines).toMatchObject([{ level: "WARN", annotations: { channel: "telegram", outcome: "refused" } }])
    const text = JSON.stringify(refused.lines)
    expect(text).not.toContain(CHAT)
    expect(text).not.toContain("SYNTHETIC_ALERT_BOT")
  })

  test("a channel the deployment has no provider for is recorded unconfigured", async () => {
    await setChannel("telegram", [CHAT])

    const step = await deliver(await recordedAlert("telegram"), SpendAlert.noChannels)

    expect(Exit.isSuccess(step.exit) && step.exit.value).toEqual({ outcome: "refused" })
    expect(await receipts()).toMatchObject([{ status: "refused", code: "unconfigured", httpStatus: null }])
    expect(providers.received).toEqual([])
  })

  test("a stored destination the channel can't take is recorded, never sent", async () => {
    await setChannel("email", ["not an address"])

    const step = await deliver(await recordedAlert("email"))

    expect(Exit.isSuccess(step.exit) && step.exit.value).toEqual({ outcome: "refused" })
    expect(await receipts()).toMatchObject([{ status: "refused", code: "rejected", reason: "invalid_destination" }])
    expect(providers.received).toEqual([])
  })

  test("a provider that is down fails the step for the engine to retry, recorded; the next attempt sends", async () => {
    await setChannel("email", ADDRESSES)
    const request = await recordedAlert("email")
    const failure = new Channels.DeliveryFailed({
      channel: "email",
      code: "rate_limited",
      status: 429,
      retryAfterMillis: 7_000,
    })

    const failed = await deliver(request, down(failure))

    // The engine reads the provider's wait off the failure.
    const error = Exit.isFailure(failed.exit) ? Cause.squash(failed.exit.cause) : undefined
    expect(error).toEqual(failure)
    expect(Object.getOwnPropertyDescriptor(error, "retryAfterMillis")?.value).toBe(7_000)
    expect(await receipts()).toMatchObject([{ status: "failed", code: "rate_limited", httpStatus: 429, attempts: 1 }])
    expect(failed.lines).toMatchObject([{
      level: "WARN",
      annotations: { channel: "email", outcome: "failed", errorCode: "rate_limited", status: 429 },
    }])

    const sent = await deliver(request)

    expect(Exit.isSuccess(sent.exit) && sent.exit.value).toEqual({ outcome: "sent" })
    expect(await receipts()).toMatchObject([{ status: "sent", code: null, httpStatus: null, attempts: 2 }])
  })

  test("a failure without a status is recorded without one", async () => {
    await setChannel("email", ADDRESSES)
    const failed = await deliver(
      await recordedAlert("email"),
      down(new Channels.DeliveryFailed({ channel: "email", code: "unreachable" })),
    )

    expect(failed.lines[0]!.annotations).not.toHaveProperty("status")
    expect(await receipts()).toMatchObject([{ status: "failed", code: "unreachable", httpStatus: null }])
  })

  test("Postgres failing fails the step with DeliverUnavailable, logged by its code", async () => {
    await setChannel("email", ADDRESSES)
    const request = await recordedAlert("email")
    await sql(`ALTER TABLE alert_channels RENAME TO alert_channels_away`)
    try {
      const failed = await deliver(request)
      expect(Exit.isFailure(failed.exit) && Cause.squash(failed.exit.cause)).toEqual(
        new SpendAlert.DeliverUnavailable({ reason: "database" }),
      )
      expect(failed.lines).toMatchObject([{
        level: "WARN",
        annotations: { outcome: "failed", errorCode: expect.stringMatching(/^sql:/) },
      }])
    } finally {
      await sql(`ALTER TABLE alert_channels_away RENAME TO alert_channels`)
    }
    expect(providers.received).toEqual([])
  })
})

describe("the delivery step's declaration", () => {
  test("is irreversible and at least once: keyed by the alert and the channel, so an engine re-runs a send a host died in", () => {
    expect(SpendAlert.Deliver.tier).toBe("irreversible")
    expect(SpendAlert.Deliver.implementationVersion).toBe(SpendAlert.DELIVER_VERSION)
    const key = SpendAlert.Deliver.idempotencyKey as (payload: SpendAlert.DeliverRequest) => unknown
    expect(key({ alertId: "a1", channel: "telegram", outcome: "recorded" })).toEqual({ alert: "a1", channel: "telegram" })
    expect(key({ alertId: "a1", channel: "email", outcome: "recorded" })).not.toEqual(
      key({ alertId: "a1", channel: "telegram", outcome: "recorded" }),
    )
  })
})
