import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Channels } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Clock, Duration, Effect, Layer, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Budget from "../branch/Budget.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Flows from "../Flows.ts"
import * as AlertDelivery from "./AlertDelivery.ts"

// `ops/SandboxSpend { from, until }` (ruling AUTH-5, decision 0103, docs/features/sandbox-budgets.md#the-spend-alert):
// once an hour, the month's sandbox spend so far, priced from the sandbox ledger (worker/branch/Budget.ts). Once it
// reaches the Admins' monthly alert (`sandbox_limits.monthly_alert_usd`, $100 unless set), each Admin gets it in their
// bell, never as a toast, and by email and Telegram where an Admin set them, as the model spend and database alerts
// are delivered (worker/flows/AlertDelivery.ts).
//
// Every `FlowExecution` alarm starts its window's run once it is done (worker/Executions.ts, `sampler`), at most once a
// window in each isolate. One execution per window (`executionId`). The alert's id is the month's and the limit's
// (`alertIdOf`), so a month alerts once per limit: a later window finds the bell's rows and the receipts already there.
//
// It runs remotely because it reads the deployment's database and must run while every device is off
// (`flows.local-first-placement` in docs/rules.md). It runs on any host; the host injects Postgres and the channels.

const nonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const positive = Schema.Int.check(Schema.isGreaterThan(0))

/** One window: its start and end in epoch milliseconds. */
const payload = { from: nonNegative, until: positive }

/** How long one window lasts: one sample per window. */
export const WINDOW = Duration.hours(1)

/** The execution for one window: one per window length and start. */
export const executionId = (window: Flows.Window) => `sandbox-spend-${window.until - window.from}-${window.from}`

/**
 * The month's spend so far: its label, the estimated dollars and the machine-hours they price, machines awake now, the
 * Admins' monthly alert in dollars (0: off), whether the spend reached it, and the alert's id (`alertIdOf`).
 */
export const Sampled = Schema.Struct({
  alertId: Schema.String,
  month: Schema.String,
  usd: Schema.Number,
  hours: Schema.Number,
  awake: nonNegative,
  limitUsd: nonNegative,
  over: Schema.Boolean,
})
export type Sampled = typeof Sampled.Type

/** The alert of a month and a limit: `sandbox-spend-2026-10-100`. */
export const alertIdOf = (sampled: Pick<Sampled, "month" | "limitUsd">) => `sandbox-spend-${sampled.month}-${sampled.limitUsd}`

/** Postgres failed the sample or the bell. The step retries it, and never gives up. */
export class SpendUnavailable extends Schema.TaggedError<SpendUnavailable>()("@smthrs/mvp/ops/SandboxSpendUnavailable", {
  reason: Schema.Literal("database"),
}) {}

/** Samples, by `outcome`: `under`, `over`, `failed`, and `not_started` when an alarm couldn't start one. */
export const samples = Metric.counter("smithers_sandbox_spend_samples", {
  description: "Sandbox spend samples, by outcome",
  incremental: true,
})

/** The month's estimated sandbox spend at the last sample, in dollars. */
export const spendGauge = Metric.gauge("smithers_sandbox_spend_usd", {
  description: "The month's estimated sandbox spend at the last sample, in dollars",
})

/** Deliveries outside the app, by `channel` and `outcome`. */
export const deliveries = Metric.counter("smithers_sandbox_spend_alert_deliveries", {
  description: "Sandbox spend alert deliveries outside the app, by channel and outcome",
  incremental: true,
})

/** Only Postgres can fail a sample or the bell, so their retries never give up. */
const retryPolicy = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

/** Reads the month's spend and the Admins' alert. */
export const Sample = Action.make("ops/SampleSandboxSpend", {
  payload,
  success: Sampled,
  error: SpendUnavailable,
  capabilities: ["db:read:sandbox_generations", "db:read:sandbox_limits"],
  retryPolicy,
})

/** The alert as it reaches Admins: its id, and the spend and limit it reports. */
const alertPayload = { alertId: Schema.String, usd: Schema.Number, limitUsd: nonNegative }

/** Puts the alert in every Admin's bell: one `spend` notification each, once. */
export const Bell = Action.make("ops/BellSandboxSpend", {
  payload: alertPayload,
  success: Schema.Struct({ admins: nonNegative }),
  error: SpendUnavailable,
  capabilities: ["db:write:notifications"],
  retryPolicy,
})

/** One delivery's payload. */
export interface DeliverRequest {
  readonly alertId: string
  readonly channel: Channels.Channel
  readonly usd: number
  readonly limitUsd: number
}

/**
 * Sends the alert on one channel and records its receipt, at least once, as `ops/DeliverSpendAlert` does: the send is
 * the step's one write, so it is `irreversible`, keyed by the alert and the channel.
 */
export const Deliver = Action.make("ops/DeliverSandboxSpend", {
  payload: { ...alertPayload, channel: Channels.Channel },
  success: AlertDelivery.Delivered,
  error: Schema.Union([Channels.DeliveryFailed, AlertDelivery.DeliverUnavailable]),
  capabilities: ["db:read:alert_channels", "db:write:alert_deliveries", "net:alert_channels"],
  tier: "irreversible",
  idempotencyKey: ({ alertId, channel }) => ({ alert: alertId, channel }),
  retryPolicy: AlertDelivery.retryPolicy,
})

/** What the flow did: the sample, the bell, and each channel's delivery; `none` under the alert. */
const Outcome = Schema.Struct({
  sample: Sampled,
  bell: Schema.Struct({ admins: nonNegative }),
  email: AlertDelivery.Delivered,
  telegram: AlertDelivery.Delivered,
})

const NONE = { outcome: "none" } as const

/** `ops/SandboxSpend`: the month's sandbox spend, and the Admins' alert once it reaches theirs. */
export const SandboxSpend = Flow.make("ops/SandboxSpend", {
  description: "Price the month's sandbox machine time and alert the deployment's Admins, in their notifications and " +
    "by email and Telegram where they set them, once it reaches their monthly sandbox alert.",
  capabilities: [
    "db:read:sandbox_generations",
    "db:read:sandbox_limits",
    "db:write:notifications",
    "db:read:alert_channels",
    "db:write:alert_deliveries",
    "net:alert_channels",
  ],
  modelInvocable: false,
  payload,
  success: Outcome,
  error: Schema.Union([SpendUnavailable, Channels.DeliveryFailed, AlertDelivery.DeliverUnavailable]),
  body: Node.capture({}, (window: Flows.Window) =>
    Sample.call(window).pipe(
      Node.branch({
        if: Node.capture({}, (sampled: Sampled) => sampled.over),
        then: Node.capture({}, (sampled) => {
          const alert = { alertId: sampled.alertId, usd: sampled.usd, limitUsd: sampled.limitUsd }
          return Node.all({
            sample: Node.succeed(sampled),
            bell: Bell.call(alert),
            email: Deliver.call({ ...alert, channel: "email" }),
            telegram: Deliver.call({ ...alert, channel: "telegram" }),
          })
        }),
        else: Node.capture({}, (sampled) =>
          Node.all({
            sample: Node.succeed(sampled),
            bell: Node.succeed({ admins: 0 }),
            email: Node.succeed(NONE),
            telegram: Node.succeed(NONE),
          })),
      }),
    )),
})

/** Reads the `SqlClient` in context at `nowMs`: the month's spend so far, the machines awake, and the Admins' alert. */
export const sample = (nowMs: number) =>
  Effect.gen(function* () {
    const month = Budget.monthOf(nowMs)
    const spent = yield* Budget.spendIn(month)
    const limit = yield* Budget.limits
    const awake = yield* Budget.awake
    return {
      alertId: alertIdOf({ month: month.label, limitUsd: limit.monthlyAlertUsd }),
      month: month.label,
      usd: spent.usd,
      hours: spent.hours,
      awake,
      limitUsd: limit.monthlyAlertUsd,
      over: limit.monthlyAlertUsd > 0 && spent.usd >= limit.monthlyAlertUsd,
    } satisfies Sampled
  })

/**
 * The sample step over `database`, with its records: a `sandbox.spend` line (Info under the alert, Warn at it or past
 * it, Warn for a failed sample), a span, the spend and awake gauges and `smithers_sandbox_spend_samples`. Dollars,
 * hours and counts only.
 */
export const observedSample = <E, R>(window: Flows.Window, database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.flatMap(Clock.currentTimeMillis, sample).pipe(
    Effect.provide(database),
    Effect.tapError((error) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(samples, { outcome: "failed" }), 1),
        Effect.logWarning("sandbox.spend").pipe(Effect.annotateLogs({ outcome: "failed", errorCode: codeOf(error) })),
      )
    ),
    Effect.mapError(() => new SpendUnavailable({ reason: "database" })),
    Effect.tap((sampled) => {
      const outcome = sampled.over ? "over" : "under"
      return Effect.all([
        Metric.update(spendGauge, sampled.usd),
        Metric.update(Budget.awakeGauge, sampled.awake),
        Metric.update(Metric.withAttributes(samples, { outcome }), 1),
        Effect.logWithLevel(sampled.over ? "Warn" : "Info")("sandbox.spend").pipe(
          Effect.annotateLogs({
            outcome,
            month: sampled.month,
            usd: Math.round(sampled.usd * 100) / 100,
            hours: Math.round(sampled.hours * 10) / 10,
            awake: sampled.awake,
            limitUsd: sampled.limitUsd,
          }),
        ),
      ])
    }),
    Effect.withSpan("sandbox.spend", { attributes: { "smithers.sandbox_spend.id": executionId(window) } }),
  )

/** Dollars as an alert says them: `$104.20`. */
export const dollars = (usd: number) =>
  `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The alert's line in a bell and a message's subject: `$104.20 this month · alert at $100`. */
export const detailOf = (alert: Pick<DeliverRequest, "usd" | "limitUsd">) =>
  `${dollars(alert.usd)} this month · alert at $${alert.limitUsd.toLocaleString("en-US")}`

/** What a message says: `Sandbox spend · $104.20 this month · alert at $100`, and the link to the app's Settings. */
export const alertWords = (alert: Pick<DeliverRequest, "usd" | "limitUsd">, appUrl: string): AlertDelivery.Words => ({
  subject: `Sandbox spend · ${detailOf(alert)}`,
  text: new URL(SETTINGS_HREF, appUrl).href,
})

/** Where the alert opens: Settings, where an Admin sets the limits. */
export const SETTINGS_HREF = "/app/settings"

/**
 * Puts the alert in the bell of every Admin with a live session, against the `SqlClient` in context: one `spend`
 * notification each (`sandbox-spend:<month>:<limit>`), never twice. Answers how many Admins it reached this time.
 */
export const bell = (alert: typeof Bell.payloadSchema.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const subject = alert.alertId.replace(/^sandbox-spend-(\d{4}-\d{2})-/, "sandbox-spend:$1:")
    const rows = yield* sql`
      INSERT INTO notifications (recipient, subject, kind, state, title, href)
      SELECT DISTINCT person_id::text, ${subject}, 'spend', 'update', ${detailOf(alert)}, ${SETTINGS_HREF}
      FROM sessions WHERE role = 'admin' AND revoked_at IS NULL AND expires_at > now()
      ON CONFLICT (recipient, subject) DO NOTHING
      RETURNING recipient`
    return { admins: rows.length }
  })

/** The bell step over `database`, with its `sandbox.spend.bell` line and span. Never an Admin's id. */
export const observedBell = <E, R>(alert: typeof Bell.payloadSchema.Type, database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  bell(alert).pipe(
    Effect.provide(database),
    Effect.tapError((error) =>
      Effect.logWarning("sandbox.spend.bell").pipe(Effect.annotateLogs({ alertId: alert.alertId, errorCode: codeOf(error) }))
    ),
    Effect.mapError(() => new SpendUnavailable({ reason: "database" })),
    Effect.tap(({ admins }) =>
      Effect.logInfo("sandbox.spend.bell").pipe(Effect.annotateLogs({ alertId: alert.alertId, admins }))
    ),
    Effect.withSpan("sandbox.spend.bell", { attributes: { "smithers.sandbox_spend.id": alert.alertId } }),
  )

/**
 * Delivers the alert on one channel, against the `SqlClient` and `Channels` in context (`AlertDelivery.deliver`):
 * nothing when an earlier run recorded its receipt or no Admin set the channel; else one send and its receipt.
 */
export const deliver = (request: DeliverRequest) =>
  AlertDelivery.deliver(request, (appUrl) => Effect.succeed(Option.some(alertWords(request, appUrl))))

/** The delivery step over `database`, with its records (`AlertDelivery.observed`): `sandbox.spend.delivery`. */
export const observedDeliver = <E, R>(request: DeliverRequest, database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  AlertDelivery.observed(
    { name: "sandbox.spend.delivery", deliveries, idAttribute: "smithers.sandbox_spend.id" },
    request,
    deliver(request),
    database,
  )

/**
 * Registers `ops/SandboxSpend` with its steps, reaching Postgres through `database` and sending through `channels`
 * (worker/AlertChannels.ts `channelsConfig`; none by default).
 */
export const registration = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  channels: Layer.Layer<Channels.Channels> = AlertDelivery.noChannels,
) =>
  Interpreter.layerWithImplementations(
    SandboxSpend,
    Layer.mergeAll(
      Sample.toLayer((window) => observedSample(window, database)),
      Bell.toLayer((alert) => observedBell(alert, database)),
      Deliver.toLayer((request) => observedDeliver(request, database)),
    ),
  ).pipe(Layer.provide(channels), Layer.provideMerge(Action.layerImplementations))

/**
 * What each `FlowExecution` alarm runs once it is done (worker/Executions.ts): it starts the current window's
 * `ops/SandboxSpend` through `FlowStarter`, once a window in this isolate (`Flows.startEachWindow`). A start the host
 * can't record is an Error `sandbox.spend` line and a count, `not_started`, and the next alarm starts it again.
 */
export const sampler = Flows.startEachWindow(
  WINDOW,
  (window) => ({ flow: SandboxSpend, executionId: executionId(window), payload: window }),
  (errorCode) =>
    Effect.andThen(
      Metric.update(Metric.withAttributes(samples, { outcome: "not_started" }), 1),
      Effect.logError("sandbox.spend").pipe(Effect.annotateLogs({ outcome: "not_started", errorCode })),
    ),
)
