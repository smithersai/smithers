import { Schema } from "effect"
import { LIST_MAX, MAX_RECENT, MAX_WHAT_LENGTH } from "./contract"

// Bug reports' rows and wire shapes (docs/features/bugs.md): what a tab says it shows, the request that files a
// report, the row Electric delivers and the read route answers, and the flows' payloads and answers. A report carries
// what the person wrote and ids, never a message, an answer, a payload or a credential: its context is built from
// ids and counts alone (src/features/bugs/tab.ts).

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max))

/** An OpenTelemetry trace id: 32 lowercase hex characters. */
export const TraceId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))

/** A run's execution id: a UUID, or an agent call's path (`<answer>/chat/Respond@…/call/<frame>.<ordinal>`). */
export const RunId = Schema.String.check(Schema.isPattern(/^[\w.:@/+-]{1,200}$/))

/** A failure the tab showed: the flow, and its stable code, never its message. */
export const Failure = Schema.Struct({
  flow: Schema.String.check(Schema.isPattern(/^[\w./-]{1,128}$/)),
  code: Schema.String.check(Schema.isPattern(/^[\w./:-]{1,64}$/)),
})
export type Failure = typeof Failure.Type

/** A repository as `owner/name`. */
export const Repository = Schema.String.check(Schema.isPattern(/^[\w.-]{1,100}\/[\w.-]{1,100}$/))

/**
 * What the tab that asked shows, captured when the report is filed: its page (the last one before the form), the
 * repository on it, the build, its latest trace ids, run ids and failure codes, and the browser and window size.
 */
export const ReportContext = Schema.Struct({
  route: Schema.NullOr(bounded(2_048)),
  repo: Schema.NullOr(Repository),
  build: bounded(64),
  traces: Schema.Array(TraceId).check(Schema.isMaxLength(MAX_RECENT)),
  runs: Schema.Array(RunId).check(Schema.isMaxLength(MAX_RECENT)),
  failures: Schema.Array(Failure).check(Schema.isMaxLength(MAX_RECENT)),
  browser: bounded(512),
  viewport: bounded(32),
})
export type ReportContext = typeof ReportContext.Type

/** What happened, in the person's words: one to 4,000 characters, not only spaces. */
export const What = Schema.String.check(
  Schema.isMaxLength(MAX_WHAT_LENGTH),
  Schema.isPattern(/\S/),
)

/** `POST /api/bugs`: one report, keyed by the id its flow chose, so filing it again changes nothing. */
export const ReportRequest = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  what: What,
  ...ReportContext.fields,
})
export type ReportRequest = typeof ReportRequest.Type

/** What `POST /api/bugs` answers: the report's id, and the transaction that wrote it (`null` when it was there). */
export const Filed = Schema.Struct({ id: Schema.String, txid: Schema.NullOr(Schema.Number) })
export type Filed = typeof Filed.Type

/** A refusal's body: its code. */
export const Refused = Schema.Struct({ code: Schema.String })

/**
 * One row of Postgres `bug_reports`, as Electric delivers it and the read route answers it: columns in camelCase.
 * Who filed it, their login and role then, and `actedBy`, the kind of run that filed it for them (`agent`), else null.
 */
export const BugReport = Schema.Struct({
  id: Schema.String,
  reporterId: Schema.String,
  reporterLogin: Schema.NullOr(Schema.String),
  reporterRole: Schema.NullOr(Schema.String),
  actedBy: Schema.NullOr(Schema.String),
  what: Schema.String,
  route: Schema.NullOr(Schema.String),
  repo: Schema.NullOr(Schema.String),
  build: Schema.String,
  traces: Schema.Array(Schema.String),
  runs: Schema.Array(Schema.String),
  failures: Schema.Array(Failure),
  browser: Schema.String,
  viewport: Schema.String,
  createdAt: Schema.String,
})
export type BugReport = typeof BugReport.Type

/** What `GET /api/bugs` answers: the reports, newest first. */
export const Listed = Schema.Struct({ reports: Schema.Array(BugReport) })
export type Listed = typeof Listed.Type

/** `app/bug/report`'s payload: what happened, and the id a door chose so it knows the report when it lands. */
export const ReportPayload = {
  what: What,
  id: Schema.optional(Schema.String.check(Schema.isUUID())),
}

/** `app/bug/report`'s answer: the report's id, and GitHub's prefilled new-issue form for it, which only a click opens. */
export const Reported = Schema.Struct({ id: Schema.String, github: Schema.String })
export type Reported = typeof Reported.Type

/** `app/bug/list`'s payload: how many of the latest reports. */
export const ListPayload = {
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIST_MAX }))),
}
