import { RetryPolicy } from "@smthrs/flow"
import { Channels } from "@smthrs/notifications"
import { Effect, Layer, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { destinationOf } from "../AlertChannels.ts"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"

// Delivering an alert outside the app (docs/features/spend-alerts.md#delivery): what every alert flow's delivery step
// does on one channel, whatever the alert says. `ops/DeliverSpendAlert` (worker/flows/SpendAlert.ts) and
// `ops/DeliverDatabaseAlert` (worker/flows/DatabaseLoad.ts) each build their message and call `deliver`, wrapped in
// `observed` with their own records. Both send through `@smthrs/notifications`' `Channels` to the destinations an Admin
// set (`alert_channels`, worker/AlertChannels.ts), and record one `alert_deliveries` receipt per alert and channel.
//
// A channel is the deployment's, shared, and nobody's access is checked where it lands (decision 0149): a message names
// only the alert's kind, the repository it is about, and a link into the app, whose page shows the rest after its own
// access check. A flow hands `deliver` a `Notice`, which has room for nothing else: no title, cost, prompt, runner
// name, error text or login reaches a channel.

/**
 * What a delivery step did: `sent`; `refused` for good (recorded); `off`, no destination set for the channel; `none`,
 * no alert to send; `existing`, a receipt an earlier run of the step recorded.
 */
export const Delivered = Schema.Struct({ outcome: Schema.Literals(["sent", "refused", "off", "none", "existing"]) })
export type Delivered = typeof Delivered.Type

/** Postgres failed a delivery step. It retries, as a send that failed does. */
export class DeliverUnavailable extends Schema.TaggedError<DeliverUnavailable>()(
  "@smthrs/mvp/ops/DeliverUnavailable",
  { reason: Schema.Literal("database") },
) {}

/** 5 seconds doubling to 10 minutes, for a day: a provider that is down or rate limiting gets the time it asks for. */
export const retryPolicy = RetryPolicy.make({
  initialMs: 5_000,
  factor: 2,
  maxMs: 600_000,
  expirationMs: 86_400_000,
})

/** No channels: every send is refused `unconfigured`. A host with no alert providers passes it. */
export const noChannels: Layer.Layer<Channels.Channels> = Channels.layer({})

/** One alert on one channel: the alert's id, which keys its receipt with the channel, and the channel. */
export interface Target {
  readonly alertId: string
  readonly channel: Channels.Channel
}

/** An alert's words: the subject, and the text under it. */
export type Words = Pick<Channels.Message, "subject" | "text">

/**
 * All a shared channel may say of an alert (decision 0149): its kind (`Agent run failed`), the repository it is about
 * (`owner/name`) or none, and the app path that shows the rest after its own access check.
 */
export interface Notice {
  readonly kind: string
  readonly repository: string | null
  readonly href: string
}

/** A notice's words: `<kind> · <owner>/<name>`, and the link, on the app address the channel's setting names. */
export const wordsOf = (notice: Notice, appUrl: string): Words => ({
  subject: notice.repository === null ? notice.kind : `${notice.kind} · ${notice.repository}`,
  text: new URL(notice.href, appUrl).href,
})

/** A channel's setting, as Postgres holds it. */
interface ChannelRow {
  readonly destinations: ReadonlyArray<string>
  readonly appUrl: string
}

/**
 * A receipt's fields: its status, the failure's code, the provider's short reason and the HTTP status, and the
 * provider's id for the message.
 */
interface Receipt {
  readonly status: "sent" | "refused" | "failed"
  readonly code: string | null
  readonly reason: string | null
  readonly httpStatus: number | null
  readonly providerId: string | null
}

/** Records one attempt's receipt for an alert and channel; a later attempt overwrites it and counts. */
const recordReceipt = (target: Target, receipt: Receipt) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`
      INSERT INTO alert_deliveries (alert_id, channel, status, code, reason, http_status, provider_id)
      VALUES (${target.alertId}, ${target.channel}, ${receipt.status}, ${receipt.code}, ${receipt.reason},
        ${receipt.httpStatus}, ${receipt.providerId})
      ON CONFLICT (alert_id, channel) DO UPDATE SET status = EXCLUDED.status, code = EXCLUDED.code,
        reason = EXCLUDED.reason, http_status = EXCLUDED.http_status, provider_id = EXCLUDED.provider_id,
        attempts = alert_deliveries.attempts + 1, updated_at = now()`)

/** A failure's receipt: its status, code and HTTP status. */
const failedReceipt = (error: Channels.DeliveryError): Receipt => ({
  status: error._tag === "@smthrs/notifications/DeliveryFailed" ? "failed" : "refused",
  code: error.code,
  reason: error.reason ?? null,
  httpStatus: error.status ?? null,
  providerId: null,
})

/**
 * Delivers one alert on one channel, against the `SqlClient` and `Channels` in context: nothing when an earlier run
 * recorded its receipt, when no Admin set the channel, or when `notice` finds no alert to send; else one send of its
 * words (`wordsOf`, on the app address the channel's setting links to), with the alert's id as the message's idempotency key, and its receipt. A
 * refusal, including a channel the deployment has no provider for (`unconfigured`), is recorded and returned; a failure
 * another attempt may clear is recorded and fails the step.
 */
export const deliver = <E, R>(
  target: Target,
  notice: Effect.Effect<Option.Option<Notice>, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [earlier] = yield* sql<{ readonly status: string }>`
      SELECT status FROM alert_deliveries WHERE alert_id = ${target.alertId} AND channel = ${target.channel}`
    if (earlier !== undefined && earlier.status !== "failed") return { outcome: "existing" } satisfies Delivered
    const [setting] = yield* sql<ChannelRow>`
      SELECT destinations, app_url AS "appUrl" FROM alert_channels WHERE channel = ${target.channel}`
    if (setting === undefined) return { outcome: "off" } satisfies Delivered
    const found = yield* notice
    if (Option.isNone(found)) return { outcome: "none" } satisfies Delivered
    const message = wordsOf(found.value, setting.appUrl)
    const destination = destinationOf(target.channel, setting.destinations)
    const sent = Option.isNone(destination)
      ? yield* Effect.fail(
        new Channels.DeliveryRefused({ channel: target.channel, code: "rejected", reason: "invalid_destination" }),
      ).pipe(Effect.result)
      : yield* (yield* Channels.Channels).send(destination.value, { id: target.alertId, ...message }).pipe(
        Effect.result,
      )
    if (sent._tag === "Success") {
      yield* recordReceipt(target, {
        status: "sent",
        code: null,
        reason: null,
        httpStatus: null,
        providerId: sent.success.providerId,
      })
      return { outcome: "sent" } satisfies Delivered
    }
    yield* recordReceipt(target, failedReceipt(sent.failure))
    if (sent.failure._tag === "@smthrs/notifications/DeliveryRefused") return { outcome: "refused" } satisfies Delivered
    return yield* sent.failure
  })

/** What an alert flow records each delivery as: its log line's and span's name, its counter, and its span's id key. */
export interface Records {
  /** The log line and the span, such as `spend.alert.delivery`. */
  readonly name: string
  /** Deliveries, by `channel` and `outcome`. */
  readonly deliveries: Metric.Counter<number>
  /** The span attribute that carries the alert's id, such as `smithers.spend_alert.id`. */
  readonly idAttribute: string
}

/**
 * A delivery step's `delivery` over `database`, with `records`: one log line and span, Warn when a send failed or was
 * refused, and the counter by channel and outcome. A send that failed stays `DeliveryFailed`, so the engine reads the
 * provider's wait off it; any other failure is Postgres's, `DeliverUnavailable`. They carry the alert, the channel, the
 * outcome and the failure's code and status, never an address, a chat id or a key.
 */
export const observed = <E, R, DE, DR>(
  records: Records,
  target: Target,
  delivery: Effect.Effect<Delivered, E, R>,
  database: Layer.Layer<SqlClient.SqlClient, DE, DR>,
) =>
  delivery.pipe(
    Effect.provide(database),
    Effect.tapError((error) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(records.deliveries, { channel: target.channel, outcome: "failed" }), 1),
        Effect.logWarning(records.name).pipe(
          Effect.annotateLogs({
            alertId: target.alertId,
            channel: target.channel,
            outcome: "failed",
            ...(error instanceof Channels.DeliveryFailed
              ? { errorCode: error.code, ...(error.status === undefined ? {} : { status: error.status }) }
              : { errorCode: codeOf(error) }),
          }),
        ),
      )
    ),
    Effect.mapError((error) =>
      error instanceof Channels.DeliveryFailed ? error : new DeliverUnavailable({ reason: "database" })
    ),
    Effect.tap((delivered) =>
      Effect.andThen(
        Metric.update(
          Metric.withAttributes(records.deliveries, { channel: target.channel, outcome: delivered.outcome }),
          1,
        ),
        Effect.logWithLevel(delivered.outcome === "refused" ? "Warn" : "Info")(records.name).pipe(
          Effect.annotateLogs({ alertId: target.alertId, channel: target.channel, outcome: delivered.outcome }),
        ),
      )
    ),
    Effect.withSpan(records.name, {
      attributes: { [records.idAttribute]: target.alertId, "smithers.channel": target.channel },
    }),
  )
