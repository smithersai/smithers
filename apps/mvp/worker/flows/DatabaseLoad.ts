import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Channels } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Duration, Effect, Layer, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ALERT_PERCENT } from "../../infra/Connections.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Flows from "../Flows.ts"
import * as AlertDelivery from "./AlertDelivery.ts"

// `ops/DatabaseLoad { from, until }` (docs/features/database-alerts.md): how many connections the app's Postgres has
// in use, once a window, and an alert to the deployment's Admins when they reach `ALERT_PERCENT` of `max_connections`.
// On 2026-10-22 at 01:55 PDT the production compute held 91 of its 112 connections and stopped accepting logins, and
// nothing told anyone.
//
// Every `FlowExecution` alarm starts its window's sample once it is done (worker/Executions.ts, `sampler`), at most
// once a window in each isolate. One execution per window (`executionId`) makes every other start, its own alarm's
// included, a no-op. `ops/SampleConnections` reads the connections; when they reached the share,
// `ops/DeliverDatabaseAlert` sends the alert on each channel an Admin set, as a spend alert's delivery does
// (worker/flows/AlertDelivery.ts), each with an `alert_deliveries` receipt keyed by the execution id.
//
// It runs remotely because it reads the deployment's database, which no device reaches, and must run while every device
// is off (`flows.local-first-placement` in docs/rules.md). It runs on any host; the host injects Postgres and the
// channels through `registration`.

const nonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const positive = Schema.Int.check(Schema.isGreaterThan(0))

/** One window: its start and end in epoch milliseconds. */
const payload = { from: nonNegative, until: positive }

/** A window, as the flow's payload holds it. */
export type Window = Flows.Window

/** How long one window lasts: one sample, and at most one alert, per window. */
export const WINDOW = Duration.minutes(5)

/** The execution, and the alert, for one window: one per window length and start. */
export const executionId = (window: Window) => `database-load-${window.until - window.from}-${window.from}`

/** Client connections in use and `max_connections`, and whether in use reached the alert's share of it. */
export const Sampled = Schema.Struct({ used: nonNegative, max: positive, over: Schema.Boolean })
export type Sampled = typeof Sampled.Type

/** Postgres failed the sample. The step retries it, and never gives up. */
export class SampleFailed extends Schema.TaggedError<SampleFailed>()("@smthrs/mvp/ops/SampleFailed", {
  reason: Schema.Literal("database"),
}) {}

/**
 * Samples, by `outcome`: `under`, `over`, `failed` for one failed step, and `not_started` when an alarm couldn't start
 * one.
 */
export const samples = Metric.counter("smithers_database_load_samples", {
  description: "Database connection samples, by outcome",
  incremental: true,
})

/** Client connections in use on the app's Postgres at the last sample. */
export const connections = Metric.gauge("smithers_database_connections", {
  description: "Client connections in use on the app's Postgres at the last sample",
})

/** The app's Postgres `max_connections` at the last sample. */
export const maxConnections = Metric.gauge("smithers_database_max_connections", {
  description: "The app's Postgres max_connections at the last sample",
})

/** Deliveries, by `channel` and `outcome`, as `smithers_spend_alert_deliveries` counts a spend alert's. */
export const deliveries = Metric.counter("smithers_database_alert_deliveries", {
  description: "Database alert deliveries outside the app, by channel and outcome",
  incremental: true,
})

/** Only Postgres can fail the sample, so its retries never give up. */
const retryPolicy = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

/** Reads the window's connections. */
export const Sample = Action.make("ops/SampleConnections", {
  payload,
  success: Sampled,
  error: SampleFailed,
  capabilities: ["db:read:pg_stat_activity"],
  retryPolicy,
})

/** The alert as one channel delivers it: its id, the channel, and the connections it reports. */
const deliverPayload = { alertId: Schema.String, channel: Channels.Channel, used: nonNegative, max: positive }

/** One delivery's payload. */
export interface DeliverRequest {
  readonly alertId: string
  readonly channel: Channels.Channel
  readonly used: number
  readonly max: number
}

/**
 * Sends the window's alert on one channel and records its receipt, at least once, as `ops/DeliverSpendAlert` does: the
 * send is the step's one write, so it is `irreversible`, keyed by the alert and the channel.
 */
export const Deliver = Action.make("ops/DeliverDatabaseAlert", {
  payload: deliverPayload,
  success: AlertDelivery.Delivered,
  error: Schema.Union([Channels.DeliveryFailed, AlertDelivery.DeliverUnavailable]),
  capabilities: ["db:read:alert_channels", "db:write:alert_deliveries", "net:alert_channels"],
  tier: "irreversible",
  idempotencyKey: ({ alertId, channel }) => ({ alert: alertId, channel }),
  retryPolicy: AlertDelivery.retryPolicy,
})

/** What the flow did: the sample, and each channel's delivery, `none` under the share. */
const Outcome = Schema.Struct({ sample: Sampled, email: AlertDelivery.Delivered, telegram: AlertDelivery.Delivered })

const NONE = { outcome: "none" } as const

/** `ops/DatabaseLoad`: samples the app's Postgres connections and alerts the Admins once they reach the share. */
export const DatabaseLoad = Flow.make("ops/DatabaseLoad", {
  description: "Sample the app's Postgres connections in use against max_connections, and alert the deployment's " +
    `Admins by email and Telegram where they set them once ${ALERT_PERCENT}% are in use.`,
  capabilities: [
    "db:read:pg_stat_activity",
    "db:read:alert_channels",
    "db:write:alert_deliveries",
    "net:alert_channels",
  ],
  modelInvocable: false,
  payload,
  success: Outcome,
  error: Schema.Union([SampleFailed, Channels.DeliveryFailed, AlertDelivery.DeliverUnavailable]),
  body: Node.capture({}, (window: Window) =>
    Sample.call(window).pipe(
      Node.branch({
        if: Node.capture({}, (sampled: Sampled) => sampled.over),
        then: Node.capture({ alertId: executionId(window) }, function (sampled) {
          const { used, max } = sampled
          return Node.all({
            sample: Node.succeed(sampled),
            email: Deliver.call({ alertId: this.alertId, channel: "email", used, max }),
            telegram: Deliver.call({ alertId: this.alertId, channel: "telegram", used, max }),
          })
        }),
        else: Node.capture({}, (sampled) =>
          Node.all({ sample: Node.succeed(sampled), email: Node.succeed(NONE), telegram: Node.succeed(NONE) })),
      }),
    )),
})

/** Whether `used` reached `percent` of `max`. */
export const reached = (connected: Pick<Sampled, "used" | "max">, percent: number) =>
  connected.used * 100 >= percent * connected.max

/**
 * Reads the `SqlClient` in context: client connections in use, `max_connections`, and whether in use reached `percent`
 * of it. A role without `pg_read_all_stats` sees another role's sessions with no `backend_type`; those in a database
 * count too, so the sample never misses Hyperdrive's or Electric's connections, at the cost of counting a replication
 * sender as one.
 */
export const sample = (percent: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [connected] = yield* sql<Pick<Sampled, "used" | "max">>`
      SELECT
        count(*) FILTER (
          WHERE backend_type = 'client backend' OR (backend_type IS NULL AND datid IS NOT NULL)
        )::int AS used,
        current_setting('max_connections')::int AS max
      FROM pg_stat_activity`
    return { ...connected!, over: reached(connected!, percent) } satisfies Sampled
  })

/**
 * The sample step over `database`, with its records: a `database.connections` log line, Info, Warn when in use reached
 * the share or the sample failed, a span, both gauges and `smithers_database_load_samples`. They carry counts and the
 * ratio, never a query, a role or an address.
 */
export const observedSample = <E, R>(
  window: Window,
  percent: number,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
) =>
  sample(percent).pipe(
    Effect.provide(database),
    Effect.tapError((error) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(samples, { outcome: "failed" }), 1),
        Effect.logWarning("database.connections").pipe(
          Effect.annotateLogs({ outcome: "failed", errorCode: codeOf(error) }),
        ),
      )
    ),
    Effect.mapError(() => new SampleFailed({ reason: "database" })),
    Effect.tap((sampled) => {
      const outcome = sampled.over ? "over" : "under"
      return Effect.all([
        Metric.update(connections, sampled.used),
        Metric.update(maxConnections, sampled.max),
        Metric.update(Metric.withAttributes(samples, { outcome }), 1),
        Effect.logWithLevel(sampled.over ? "Warn" : "Info")("database.connections").pipe(
          Effect.annotateLogs({ outcome, used: sampled.used, max: sampled.max, ratio: sampled.used / sampled.max }),
        ),
      ])
    }),
    Effect.withSpan("database.connections", { attributes: { "smithers.database_load.id": executionId(window) } }),
  )

/**
 * What a shared channel says (decision 0149): `Database connections high`, and the link to the app. The counts stay in
 * the logs and metrics (`database.connections`).
 */
export const NOTICE: AlertDelivery.Notice = { kind: "Database connections high", repository: null, href: "/app" }

/**
 * Delivers one alert on one channel, against the `SqlClient` and `Channels` in context (`AlertDelivery.deliver`):
 * nothing when an earlier run recorded its receipt or no Admin set the channel; else one send and its receipt.
 */
export const deliver = (request: DeliverRequest) =>
  AlertDelivery.deliver(request, Effect.succeed(Option.some(NOTICE)))

/**
 * The delivery step over `database` and the `Channels` in context, with its records (`AlertDelivery.observed`): a
 * `database.alert.delivery` log line and span, Warn when a send failed or was refused, and
 * `smithers_database_alert_deliveries`. They never carry an address, a chat id or a key.
 */
export const observedDeliver = <E, R>(request: DeliverRequest, database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  AlertDelivery.observed(
    { name: "database.alert.delivery", deliveries, idAttribute: "smithers.database_load.id" },
    request,
    deliver(request),
    database,
  )

/**
 * Registers `ops/DatabaseLoad` with its steps, reaching Postgres through `database`, sending through `channels`
 * (worker/AlertChannels.ts `channelsConfig`; none by default), and alerting once `percent` of `max_connections` is in
 * use (`ALERT_PERCENT` unless set).
 */
export const registration = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  channels: Layer.Layer<Channels.Channels> = AlertDelivery.noChannels,
  options: { readonly percent?: number } = {},
) =>
  Interpreter.layerWithImplementations(
    DatabaseLoad,
    Layer.mergeAll(
      Sample.toLayer((window) => observedSample(window, options.percent ?? ALERT_PERCENT, database)),
      Deliver.toLayer((request) => observedDeliver(request, database)),
    ),
  ).pipe(Layer.provide(channels), Layer.provideMerge(Action.layerImplementations))

/**
 * Returns what each `FlowExecution` alarm runs once it is done (worker/Executions.ts): it starts the current window's
 * `ops/DatabaseLoad` through `FlowStarter`, once a window in this isolate (`Flows.startEachWindow`). A start that found
 * it started already counts as started. A start the host can't record is an Error `database.connections` line and a
 * count, `not_started`, and the next alarm starts it again; the alarm itself goes on.
 */
export const sampler = Flows.startEachWindow(
  WINDOW,
  (window) => ({ flow: DatabaseLoad, executionId: executionId(window), payload: window }),
  (errorCode) =>
    Effect.andThen(
      Metric.update(Metric.withAttributes(samples, { outcome: "not_started" }), 1),
      Effect.logError("database.connections").pipe(Effect.annotateLogs({ outcome: "not_started", errorCode })),
    ),
)
