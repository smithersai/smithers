import { ShapeProxy } from "@smthrs/effect-electric"
import { Core } from "@smthrs/integrations"
import { Cause, Clock, Config, Effect, type Layer, Metric, Option, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import {
  BUG_READ_TOKEN_VARIABLE,
  BUG_REPORT_COLUMNS,
  BUG_REPORTS_ROUTE,
  BUG_REPORTS_SHAPE_ROUTE,
  BUG_REPORTS_TABLE,
  bugAlertId,
  LIST_DEFAULT,
  LIST_MAX,
  MAX_REPORT_BODY_BYTES,
  type Refusal,
} from "../../src/features/bugs/contract.ts"
import { type BugReport as Report, ReportRequest } from "../../src/features/bugs/schema.ts"
import { LOCAL_ELECTRIC_URL } from "../../src/features/chat/contract.ts"
import { type Actor, Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Flows from "../Flows.ts"
import { BugReport } from "../flows/BugReport.ts"
import { bearerOf } from "../RunCredentials.ts"
import * as ShapeAccess from "../ShapeAccess.ts"

// Bug reports' routes (docs/features/bugs.md).
//
// - `POST /api/bugs`: a signed-in person, whatever their role, or a run acting for them, files a report
//   (`ReportRequest`). Who filed it comes from the actor, never the body; fields the body adds are ignored. The row is
//   keyed by the report's id, so filing it again answers as filed and changes nothing, and an id another person filed is
//   refused. Then it starts `ops/BugReport`, which tells the Admins (worker/flows/BugReport.ts), once per report.
// - `GET /api/bugs?limit=N`: the latest reports, newest first, for an Admin (in person, or a run acting for one), or for
//   a bearer of the deployment's read token (`BUG_REPORTS_READ_TOKEN`; unset, that door is off).
// - `GET /api/shapes/bug-reports`: every report for an Admin in person; a person's own for anyone else signed in.
//
// No log line, span or metric carries what a person wrote, a page, a login or the token; a refusal names a code.

/** Requests to `/api/bugs`, by `op` (`file`, `list`) and `outcome`. */
export const requests = Metric.counter("smithers_bug_requests", {
  description: "Requests to /api/bugs, by op and outcome",
  incremental: true,
})

/** `GET /api/shapes/bug-reports` requests, by `status` and `live`. */
export const shapes = Metric.counter("smithers_bug_shape_requests", {
  description: "GET /api/shapes/bug-reports requests, by status and live",
  incremental: true,
})

/** Whether a path is one of the bug reports' routes. */
export const handles = (path: string): boolean => path === BUG_REPORTS_ROUTE || path === BUG_REPORTS_SHAPE_ROUTE

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(ReportRequest))

/** What a shape filters on for someone signed out: no person, so it holds no rows. */
const NOBODY = ""

const noStore = { "cache-control": "no-store" }

type Fields = Record<string, string | number | boolean>

const encoder = new TextEncoder()

/** Whether `presented` is `token`, compared in constant time. */
const sameToken = (presented: string, token: Redacted.Redacted<string>) =>
  Core.Signature.constantTimeEqual(encoder.encode(presented), encoder.encode(Redacted.value(token)))

/**
 * Whether a report's free text holds a NUL character, which Postgres text can't store: refused as invalid, so the
 * browser's step doesn't retry a write that can never land.
 */
export const hasNul = (report: ReportRequest) =>
  [report.what, report.route ?? "", report.build, report.browser, report.viewport].some((text) => text.includes("\u0000"))

/** A `limit` query parameter: `LIST_DEFAULT` when absent, else a whole number from 1 to `LIST_MAX`. */
export const limitOf = (raw: string | null): number | undefined => {
  if (raw === null) return LIST_DEFAULT
  const limit = /^\d{1,4}$/.test(raw) ? Number(raw) : 0
  return limit >= 1 && limit <= LIST_MAX ? limit : undefined
}

/**
 * Writes `report` as `actor`'s, against the `SqlClient` in context, unless its id is taken. Answers the transaction
 * that wrote it; `null` when `actor` had filed it already; `"conflict"` when someone else had.
 */
export const file = (report: ReportRequest, actor: Actor) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const reporter = actor.subject.id
    const written = yield* sql<{ readonly txid: string }>`
      INSERT INTO bug_reports (id, reporter_id, reporter_login, reporter_role, acted_by, what, route, repo, build, traces,
        runs, failures, browser, viewport)
      VALUES (${report.id}, ${reporter}, ${actor.login ?? null}, ${actor.role}, ${actor.act?.kind ?? null},
        ${report.what}, ${report.route}, ${report.repo}, ${report.build}, ${JSON.stringify(report.traces)}::jsonb,
        ${JSON.stringify(report.runs)}::jsonb, ${JSON.stringify(report.failures)}::jsonb, ${report.browser},
        ${report.viewport})
      ON CONFLICT (id) DO NOTHING
      RETURNING pg_current_xact_id()::xid::text AS txid`
    if (written[0] !== undefined) return Number(written[0].txid)
    const mine = yield* sql<{ readonly mine: boolean }>`
      SELECT reporter_id = ${reporter} AS mine FROM bug_reports WHERE id = ${report.id}`
    return mine.some((row) => row.mine) ? null : "conflict" as const
  })

/** The latest `limit` reports, newest first, against the `SqlClient` in context, as the read route answers them. */
export const latest = (limit: number) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<Report>`
      SELECT id::text AS id, reporter_id AS "reporterId", reporter_login AS "reporterLogin", reporter_role AS "reporterRole",
        acted_by AS "actedBy", what, route, repo, build, traces, runs, failures, browser, viewport,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
      FROM bug_reports ORDER BY created_at DESC, id DESC LIMIT ${limit}`)

/**
 * The bug reports' routes over `database`. They read who is asking from `Sessions` and start `ops/BugReport` through
 * `Flows.FlowStarter`. The deployment's read token (`BUG_REPORTS_READ_TOKEN`) is read here, while the program is built.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })
    const token = Option.filter(
      yield* Config.option(Config.Redacted(BUG_READ_TOKEN_VARIABLE)),
      (value) => Redacted.value(value).trim() !== "",
    )

    /** `GET /api/shapes/bug-reports`: every report for an Admin in person, a person's own otherwise. */
    const shape = ShapeProxy.make({
      ...connection,
      shape: Effect.map(ShapeAccess.actor, (actor) =>
        Option.isSome(actor) && actor.value.role === "admin" && actor.value.act === undefined
          ? { table: BUG_REPORTS_TABLE, columns: BUG_REPORT_COLUMNS }
          : {
            table: BUG_REPORTS_TABLE,
            where: "reporter_id = $1",
            params: { "1": Option.isSome(actor) ? actor.value.subject.id : NOBODY },
            columns: BUG_REPORT_COLUMNS,
          }),
      name: "bug.shape",
      metric: shapes,
    })

    /** `POST` and `GET /api/bugs`. */
    const route = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const startedAt = yield* Clock.currentTimeMillis
      const op = request.method === "GET" ? "list" : "file"
      const fields: Fields = { op }
      const refuse = (status: number, code: Refusal) => {
        fields.code = code
        return HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
      }
      const response = yield* Effect.gen(function* () {
        if (request.method !== "GET" && request.method !== "POST") {
          return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, POST", ...noStore } })
        }
        if (op === "list") {
          // A bearer of the read token is let in before sessions read the header as a run's credential.
          const bearer = bearerOf(request)
          const byToken = Option.isSome(bearer) && Option.isSome(token) && sameToken(bearer.value, token.value)
          if (!byToken) {
            const actor = yield* (yield* Sessions).resolve
            if (Option.isNone(actor)) return refuse(401, "authentication")
            if (actor.value.role !== "admin") return refuse(403, "forbidden")
          }
          fields.door = byToken ? "token" : "session"
          const limit = limitOf(new URL(request.url, "http://chat.invalid").searchParams.get("limit"))
          if (limit === undefined) return refuse(400, "invalid")
          const reports = yield* latest(limit).pipe(Effect.provide(database))
          fields.outcome = "listed"
          fields.count = reports.length
          return HttpServerResponse.jsonUnsafe({ reports }, { status: 200, headers: noStore })
        }
        const actor = yield* (yield* Sessions).resolve
        if (Option.isNone(actor)) return refuse(401, "authentication")
        if (actor.value.act !== undefined) fields.by = actor.value.act.kind
        const body = yield* readBounded(request, MAX_REPORT_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(
          Effect.result,
        )
        if (body._tag === "Failure") {
          return body.failure.reason === "too_large" ? refuse(413, "too_large") : refuse(400, "invalid")
        }
        // A decoding failure would quote its input, what the person wrote: it is dropped whole.
        const decoded = yield* decodeReport(body.success).pipe(Effect.option)
        if (Option.isNone(decoded) || hasNul(decoded.value)) return refuse(400, "invalid")
        const report = decoded.value
        fields.reportId = report.id
        const txid = yield* file(report, actor.value).pipe(Effect.provide(database))
        if (txid === "conflict") return refuse(409, "conflict")
        if (txid === null) fields.existing = true
        // Filed again, it starts again: a start an earlier request couldn't record runs now, and one it did is the same.
        const started = yield* (yield* Flows.FlowStarter).start(BugReport, {
          executionId: bugAlertId(report.id),
          payload: { id: report.id },
        }).pipe(Effect.catchTag("@smthrs/mvp/flows/StartConflict", () => Effect.void), Effect.result)
        if (started._tag === "Failure") {
          fields.errorCode = started.failure.errorCode
          return refuse(503, "unavailable")
        }
        fields.outcome = "filed"
        return HttpServerResponse.jsonUnsafe({ id: report.id, txid }, { status: 200, headers: noStore })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            fields.errorCode = codeOf(Cause.squash(cause))
            return refuse(503, "unavailable")
          })
        ),
      )
      fields.status = response.status
      fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
      const outcome = String(fields.outcome ?? fields.code ?? "refused")
      yield* Metric.update(Metric.withAttributes(requests, { op, outcome }), 1)
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, op, outcome })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
        "bug.request",
      ).pipe(Effect.annotateLogs({ ...fields, outcome }))
      return response
    }).pipe(Effect.withSpan("bug.request", { kind: "server" }))

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return request.url.split("?")[0] === BUG_REPORTS_SHAPE_ROUTE ? yield* shape : yield* route
    })

    return { fetch }
  })
