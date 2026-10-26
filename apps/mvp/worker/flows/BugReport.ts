import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Channels } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { BUG_INBOX_PATH, bugAlertId, bugSubject } from "../../src/features/bugs/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import * as AlertDelivery from "./AlertDelivery.ts"

// `ops/BugReport { id }` (docs/features/bugs.md#the-admins-hear): once a person files a report
// (worker/bugs/Api.ts), each Admin gets it in their bell, never as a toast, and by email and Telegram where an Admin set
// them, as the spend and database alerts are delivered (worker/flows/AlertDelivery.ts).
//
// `POST /api/bugs` starts it after the report's row is written, one execution per report (`bugAlertId`), so filing it
// again starts nothing new. The bell and the messages say who filed it and on which page, and link to the bug inbox;
// never what the person wrote.
//
// It runs remotely because it must reach the Admins while every device is off, and sends with the deployment's provider
// keys (`flows.local-first-placement` in docs/rules.md). It runs on any host; the host injects Postgres and the channels.

const nonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** The report: its id in `bug_reports`. */
const payload = { id: Schema.String.check(Schema.isUUID()) }

/** Postgres failed the bell. The step retries it, and never gives up. */
export class BugReportUnavailable extends Schema.TaggedError<BugReportUnavailable>()(
  "@smthrs/mvp/ops/BugReportUnavailable",
  { reason: Schema.Literal("database") },
) {}

/** Deliveries outside the app, by `channel` and `outcome`. */
export const deliveries = Metric.counter("smithers_bug_report_deliveries", {
  description: "Bug report deliveries to Admins outside the app, by channel and outcome",
  incremental: true,
})

/** Only Postgres can fail the bell, so its retries never give up. */
const retryPolicy = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

/** Puts the report in every Admin's bell: one `bug` notification each, once. */
export const Bell = Action.make("ops/BellBugReport", {
  payload,
  success: Schema.Struct({ admins: nonNegative }),
  error: BugReportUnavailable,
  capabilities: ["db:read:bug_reports", "db:write:notifications"],
  retryPolicy,
})

/** One delivery's payload: the report and the channel. */
export interface DeliverRequest {
  readonly id: string
  readonly channel: Channels.Channel
}

/**
 * Sends the report's alert on one channel and records its receipt, at least once, as `ops/DeliverSpendAlert` does: the
 * send is the step's one write, so it is `irreversible`, keyed by the alert and the channel.
 */
export const Deliver = Action.make("ops/DeliverBugReport", {
  payload: { ...payload, channel: Channels.Channel },
  success: AlertDelivery.Delivered,
  error: Schema.Union([Channels.DeliveryFailed, AlertDelivery.DeliverUnavailable]),
  capabilities: ["db:read:bug_reports", "db:read:alert_channels", "db:write:alert_deliveries", "net:alert_channels"],
  tier: "irreversible",
  idempotencyKey: ({ id, channel }) => ({ alert: bugAlertId(id), channel }),
  retryPolicy: AlertDelivery.retryPolicy,
})

/** What the flow did: the bell, and each channel's delivery. */
const Outcome = Schema.Struct({
  bell: Schema.Struct({ admins: nonNegative }),
  email: AlertDelivery.Delivered,
  telegram: AlertDelivery.Delivered,
})

/** `ops/BugReport`: tells the deployment's Admins a report was filed. */
export const BugReport = Flow.make("ops/BugReport", {
  description: "Tell the deployment's Admins a person filed a bug report, in their notifications and by email and " +
    "Telegram where they set them, with who filed it and on which page, never what they wrote.",
  capabilities: [
    "db:read:bug_reports",
    "db:write:notifications",
    "db:read:alert_channels",
    "db:write:alert_deliveries",
    "net:alert_channels",
  ],
  modelInvocable: false,
  payload,
  success: Outcome,
  error: Schema.Union([BugReportUnavailable, Channels.DeliveryFailed, AlertDelivery.DeliverUnavailable]),
  body: Node.capture({}, (report: { readonly id: string }) =>
    Node.all({
      bell: Bell.call(report),
      email: Deliver.call({ id: report.id, channel: "email" }),
      telegram: Deliver.call({ id: report.id, channel: "telegram" }),
    })),
})

/** The longest title a bell row and a message's subject carry (`notifications.title`, `Channels.Message.subject`). */
export const MAX_TITLE = 200

/** `text`, cut to `max` UTF-16 units with an ellipsis when it is longer, never splitting a character. */
export const clip = (text: string, max: number) => {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`
}

/** Who filed a report and where, as a report's alert names them. */
export interface Filed {
  readonly login: string | null
  readonly route: string | null
}

/** The report's line in a bell: `@maya · /app/repos/acme/web`, `@maya` with no page, `someone` with no login. */
export const titleOf = (filed: Filed) => {
  const who = filed.login === null ? "someone" : `@${filed.login}`
  return clip(filed.route === null ? who : `${who} · ${filed.route}`, MAX_TITLE)
}

/** What a message says: `Bug report · @maya · /app/repos/acme/web`, and the link to the bug inbox. */
export const alertWords = (filed: Filed, appUrl: string): AlertDelivery.Words => ({
  subject: clip(`Bug report · ${titleOf(filed)}`, MAX_TITLE),
  text: new URL(BUG_INBOX_PATH, appUrl).href,
})

/** Who filed report `id` and where, against the `SqlClient` in context; none when there is no such report. */
export const filedOf = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<Filed>`SELECT reporter_login AS login, route FROM bug_reports WHERE id = ${id}`
    return Option.fromNullishOr(rows[0])
  })

/**
 * Puts report `id` in the bell of every Admin with a live session, against the `SqlClient` in context: one `bug`
 * notification each (`bug:<id>`), never twice. Answers how many Admins it reached this time; none for a report that
 * isn't there.
 */
export const bell = (report: typeof Bell.payloadSchema.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const filed = yield* filedOf(report.id)
    if (Option.isNone(filed)) return { admins: 0 }
    const rows = yield* sql`
      INSERT INTO notifications (recipient, subject, kind, state, title, href)
      SELECT DISTINCT person_id::text, ${bugSubject(report.id)}, 'bug', 'update', ${titleOf(filed.value)}, ${BUG_INBOX_PATH}
      FROM sessions WHERE role = 'admin' AND revoked_at IS NULL AND expires_at > now()
      ON CONFLICT (recipient, subject) DO NOTHING
      RETURNING recipient`
    return { admins: rows.length }
  })

/** The bell step over `database`, with its `bug.report.bell` line and span: the alert and a count, never who or where. */
export const observedBell = <E, R>(
  report: typeof Bell.payloadSchema.Type,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
) => {
  const alertId = bugAlertId(report.id)
  return bell(report).pipe(
    Effect.provide(database),
    Effect.tapError((error) =>
      Effect.logWarning("bug.report.bell").pipe(Effect.annotateLogs({ alertId, errorCode: codeOf(error) }))
    ),
    Effect.mapError(() => new BugReportUnavailable({ reason: "database" })),
    Effect.tap(({ admins }) => Effect.logInfo("bug.report.bell").pipe(Effect.annotateLogs({ alertId, admins }))),
    Effect.withSpan("bug.report.bell", { attributes: { "smithers.bug_report.id": alertId } }),
  )
}

/**
 * Delivers report `id`'s alert on one channel, against the `SqlClient` and `Channels` in context
 * (`AlertDelivery.deliver`): nothing when an earlier run recorded its receipt, no Admin set the channel, or the report
 * isn't there; else one send and its receipt.
 */
export const deliver = (request: DeliverRequest) =>
  AlertDelivery.deliver(
    { alertId: bugAlertId(request.id), channel: request.channel },
    (appUrl) => Effect.map(filedOf(request.id), Option.map((filed) => alertWords(filed, appUrl))),
  )

/** The delivery step over `database`, with its records (`AlertDelivery.observed`): `bug.report.delivery`. */
export const observedDeliver = <E, R>(request: DeliverRequest, database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  AlertDelivery.observed(
    { name: "bug.report.delivery", deliveries, idAttribute: "smithers.bug_report.id" },
    { alertId: bugAlertId(request.id), channel: request.channel },
    deliver(request),
    database,
  )

/**
 * Registers `ops/BugReport` with its steps, reaching Postgres through `database` and sending through `channels`
 * (worker/AlertChannels.ts `channelsConfig`; none by default).
 */
export const registration = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  channels: Layer.Layer<Channels.Channels> = AlertDelivery.noChannels,
) =>
  Interpreter.layerWithImplementations(
    BugReport,
    Layer.mergeAll(
      Bell.toLayer((report) => observedBell(report, database)),
      Deliver.toLayer((request) => observedDeliver(request, database)),
    ),
  ).pipe(Layer.provide(channels), Layer.provideMerge(Action.layerImplementations))
