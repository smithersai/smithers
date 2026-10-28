import { ShapeProxy } from "@smthrs/effect-electric"
import { Cause, Clock, Effect, type Layer, Metric, Option, Result, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../src/features/chat/contract.ts"
import { MAX_RUN_BODY_BYTES, RUNS_TABLE } from "../src/features/status/contract.ts"
import {
  Decision,
  type Report,
  Report as ReportSchema,
  type RunAnswer,
  RunAnswer as RunAnswerSchema,
} from "../src/features/status/schema.ts"
import { type Actor, boundTo, refusesPersonOnly, Sessions } from "./Actor.ts"
import { askingOnAnswer } from "./branch/Access.ts"
import { readBounded } from "./Body.ts"
import { codeOf } from "./ErrorCode.ts"
import { withAnswerConversation } from "./Messages.ts"
import * as Notifications from "./Notifications.ts"
import * as RunCredentials from "./RunCredentials.ts"
import * as ShapeAccess from "./ShapeAccess.ts"

// Agent status in ChatApi (decision 0015, docs/features/agent-status.md#the-routes): the `runs` rows a run's own steps
// report its status to, the answer a person gives its open question, and Electric's `runs` shape.
//
// - `POST /api/runs/<id>`: a run reports. In this slice a run is an agent's answer, so `<id>` is an answer's id and only
//   the person who asked its question may report for it (an agent acting for them is them), while they may still ask.
//   A settled row (`done`, `failed`) never changes; a new question bumps `version` and clears the answer; a report
//   that changes nothing writes nothing (`200 {txid: null}`). A report that can't be written says why:
//   `409 not_writable` with `reason` `settled` or `other_launcher`.
// - `POST /api/runs/<id>/answer`: the person answers the open question `version` names. The first accepted answer
//   settles it; the same answer again is taken as landed; anything else is `409 not_open`. Only the person answers:
//   anyone acting for them is `403 person_only`.
// - `POST /api/runs/<run>/credential {flow, ceiling?}`: the run credential of run `<run>` (its execution id,
//   percent-encoded), minted for the person's session or, nested, for the caller's credential (worker/RunCredentials.ts).
// - `GET /api/shapes/runs`: the signed-in person's rows, without `launched_by`. Signed out, no rows.
//
// A run credential reports and answers only for the run its chain started from: any other is `403 other_run`.
//
// A report or an answer that writes the row routes it to the feed in the same transaction (worker/Notifications.ts,
// decision 0009): the run's launcher and the people on its branch.

/** The largest `POST /api/runs/<run>/credential` body: a flow's name and its declared ceiling. */
export const MAX_CREDENTIAL_BODY_BYTES = 16 * 1024

/** Runs route requests, by `route` (`report`, `answer`, `credential`) and `status`. */
export const requests = Metric.counter("smithers_run_requests", {
  description: "Requests to the runs routes, by route and status",
  incremental: true,
})

/** `GET /api/shapes/runs` requests, by `status` and `live`. */
export const shapes = Metric.counter("smithers_run_shape_requests", {
  description: "GET /api/shapes/runs requests, by status and live",
  incremental: true,
})

/** The `runs` columns a device syncs: all of them but `launched_by`, which the shape filters on. */
export const SYNCED_RUN_COLUMNS = [
  "id",
  "flow",
  "status",
  "waiting",
  "wait",
  "version",
  "answer",
  "answered_at",
  "created_at",
  "updated_at",
]

/** The flow of every run that reports in this slice: an agent's answer. */
const AGENT_RUN_FLOW = "chat/Answer"

/** No person's id: what a signed-out shape filters on, so it holds no rows. */
const NOBODY = ""

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))
const decodeMint = Schema.decodeUnknownEffect(Schema.fromJsonString(RunCredentials.MintRequest))
const decodeAnswer = Schema.decodeUnknownEffect(Schema.fromJsonString(RunAnswerSchema))
const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))

/** A credential's run from its percent-encoded path segment, or none when it isn't one. */
const decodedRun = (segment: string): string | undefined => {
  try {
    const run = decodeURIComponent(segment)
    return /^[\x21-\x7e]{1,256}$/.test(run) ? run : undefined
  } catch {
    return undefined
  }
}

type Fields = Record<string, string | number | boolean>

const noStore = { "cache-control": "no-store" }
const refusal = (status: number, code: string, fields: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe({ code, ...fields }, { status, headers: noStore })
const ok = (txid: number | null) => HttpServerResponse.jsonUnsafe({ txid }, { headers: noStore })

/** Who asked the question of the answer `runId`: `undefined` when it isn't an answer, `null` for an unknown asker. */
const askerOf = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly askedBy: string | null }>`
      SELECT q.asked_by AS "askedBy" FROM messages a JOIN messages q ON q.id = a.question_id
      WHERE a.id = ${runId} AND a.role = 'assistant'`
    return row === undefined ? undefined : row.askedBy
  })

/**
 * Writes `report` to the run's row for `launchedBy`: its transaction, or `undefined` when the row is settled, belongs
 * to someone else, or already says exactly this. A question whose `execution` differs from the row's last one is a new
 * question: `version` goes up and the last answer is cleared. The same question reported again never reopens it.
 */
const applyReport = (runId: string, launchedBy: string, report: Report) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const waiting = report.status === "waiting" ? report.waiting : report.status === "needs_you"
      ? report.wait.kind === "approval" ? "approval" : "input"
      : null
    const wait = report.status === "needs_you" ? JSON.stringify(report.wait) : null
    // The run works where its answer is (decision 0009 §2): the answer's conversation, its branch and repository.
    const [row] = yield* sql<{ readonly txid: string }>`
      INSERT INTO runs AS r (id, flow, status, waiting, wait, version, launched_by, conversation_id, branch_id, repo_id)
      SELECT ${runId}, ${AGENT_RUN_FLOW}, ${report.status}, ${waiting}, ${wait}::jsonb,
        ${report.status === "needs_you" ? 1 : 0}, ${launchedBy}, m.conversation_id, c.branch_id, c.repo_id
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = ${runId}
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        waiting = EXCLUDED.waiting,
        wait = COALESCE(EXCLUDED.wait, r.wait),
        version = CASE WHEN EXCLUDED.wait IS NOT NULL AND r.wait->>'execution' IS DISTINCT FROM EXCLUDED.wait->>'execution'
          THEN r.version + 1 ELSE r.version END,
        answer = CASE WHEN EXCLUDED.wait IS NOT NULL AND r.wait->>'execution' IS DISTINCT FROM EXCLUDED.wait->>'execution'
          THEN NULL ELSE r.answer END,
        answered_at = CASE WHEN EXCLUDED.wait IS NOT NULL AND r.wait->>'execution' IS DISTINCT FROM EXCLUDED.wait->>'execution'
          THEN NULL ELSE r.answered_at END,
        updated_at = now()
      WHERE r.launched_by = EXCLUDED.launched_by AND r.status NOT IN ('done', 'failed')
        AND NOT (r.status = EXCLUDED.status AND r.waiting IS NOT DISTINCT FROM EXCLUDED.waiting
          AND (EXCLUDED.wait IS NULL OR r.wait = EXCLUDED.wait))
        AND NOT (EXCLUDED.wait IS NOT NULL AND r.wait->>'execution' = EXCLUDED.wait->>'execution' AND r.answer IS NOT NULL)
      RETURNING pg_current_xact_id()::xid::text AS txid`
    return row === undefined ? undefined : Number(row.txid)
  })

/** Why a report for `launchedBy` wrote nothing to run `runId`'s row, when it isn't a report already landed. */
export type NotWritable = "settled" | "other_launcher"

/**
 * Why a report wrote nothing: `settled` or `other_launcher` for a row that can't take it, and `undefined` when the row
 * already says what the report says. A report always finds its row: an answer the route takes is in a conversation
 * (`messages.conversation_id` is required), so the report made the row if there was none.
 */
const unwrittenBecause = (runId: string, launchedBy: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly reason: NotWritable | null }>`
      SELECT CASE
          WHEN launched_by <> ${launchedBy} THEN 'other_launcher'
          WHEN status IN ('done', 'failed') THEN 'settled'
        END AS reason
      FROM runs WHERE id = ${runId}`
    return row!.reason ?? undefined
  })

/** The run's row as the answer route reads it. */
const runOf = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly launchedBy: string
      readonly status: string
      readonly version: number
      readonly kind: string | null
      readonly answer: { readonly value: unknown } | null
    }>`
      SELECT launched_by AS "launchedBy", status, version, wait->>'kind' AS kind, answer FROM runs WHERE id = ${runId}`
    return row
  })

/**
 * Whether `value` answers a question of `kind`: words for a question; for an approval, a yes or no, or a decision with
 * a note, which may be empty.
 */
const fits = (kind: string | null, value: RunAnswer["value"]) =>
  kind === "approval" ? typeof value !== "string" : typeof value === "string" && value.trim() !== ""

/** The answer as it is kept: words and a note trimmed. */
const kept = (value: RunAnswer["value"]): RunAnswer["value"] =>
  typeof value === "string"
    ? value.trim()
    : typeof value === "boolean"
    ? value
    : { approved: value.approved, note: value.note.trim() }

const isDecision = Schema.is(Decision)

/** Whether the kept answer `stored` is `value`, kept. */
const same = (stored: unknown, value: RunAnswer["value"]) =>
  typeof value === "object"
    ? isDecision(stored) && stored.approved === value.approved && stored.note === value.note
    : stored === value

/** Records the answer to the open question `version` names, for `launchedBy`: its transaction, or `undefined`. */
const applyAnswer = (runId: string, launchedBy: string, answer: RunAnswer) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const value = kept(answer.value)
    const [row] = yield* sql<{ readonly txid: string }>`
      UPDATE runs SET answer = jsonb_build_object('value', ${JSON.stringify(value)}::jsonb), answered_at = now(),
        updated_at = now()
      WHERE id = ${runId} AND launched_by = ${launchedBy} AND status = 'needs_you' AND version = ${answer.version}
        AND answer IS NULL
      RETURNING pg_current_xact_id()::xid::text AS txid`
    return row === undefined ? undefined : Number(row.txid)
  })


/**
 * Runs `write` and, when it wrote, the feed's fold of the run (worker/Notifications.ts), in one transaction: the run's
 * row and its recipients' rows land together or not at all.
 */
const withFold = <E, R>(write: Effect.Effect<number | undefined, E, R>, runId: string, login: string | undefined) =>
  withAnswerConversation(runId,
    Effect.tap(write, (txid) => (txid === undefined ? Effect.void : Notifications.foldRun(runId, login))),
  )

/**
 * Reads Electric's connection (`ShapeProxy.config`) and returns the runs routes: `route(rest)` for
 * `/api/runs/<rest>`, and `shape` for `GET /api/shapes/runs`. Each route request is a log line `agent.status.report`
 * or `agent.status.answer`, a span `agent.status.request` and a count; none carries a question or an answer.
 * `database` opens a Postgres client for the scope of each request.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })

    /** `POST /api/runs/<id>`: the run's step reports its status. */
    const report = (
      request: HttpServerRequest.HttpServerRequest,
      runId: string,
      actorId: string,
      login: string | undefined,
      fields: Fields,
    ) =>
      Effect.gen(function* () {
        const body = yield* readBounded(request, MAX_RUN_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(Effect.result)
        if (body._tag === "Failure") {
          return body.failure.reason === "too_large" ? refusal(413, "too_large") : refusal(400, "invalid")
        }
        const decoded = yield* decodeReport(body.success).pipe(Effect.option)
        if (Option.isNone(decoded)) return refusal(400, "invalid")
        fields.report = decoded.value.status
        const askedBy = yield* askerOf(runId)
        if (askedBy === undefined) return refusal(404, "not_found")
        if (askedBy !== actorId) {
          fields.errorCode = "not_launcher"
          return refusal(403, "forbidden")
        }
        // The feed folds the report in its own transaction (decision 0009 decision 2): a report that lands routes.
        const txid = yield* withFold(applyReport(runId, actorId, decoded.value), runId, login)
        if (txid !== undefined) return ok(txid)
        // Nothing written: a report already landed is taken as landed; any other is refused with its reason, so the
        // run never goes on as if the person could see a question nobody shows.
        const reason = yield* unwrittenBecause(runId, actorId)
        if (reason === undefined) {
          fields.existing = true
          return ok(null)
        }
        fields.errorCode = "not_writable"
        fields.reason = reason
        return refusal(409, "not_writable", { reason })
      })

    /** `POST /api/runs/<id>/answer`: the person answers the open question. */
    const answer = (
      request: HttpServerRequest.HttpServerRequest,
      runId: string,
      actorId: string,
      login: string | undefined,
      fields: Fields,
    ) =>
      Effect.gen(function* () {
        const body = yield* readBounded(request, MAX_RUN_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(Effect.result)
        if (body._tag === "Failure") {
          return body.failure.reason === "too_large" ? refusal(413, "too_large") : refusal(400, "invalid")
        }
        const decoded = yield* decodeAnswer(body.success).pipe(Effect.option)
        if (Option.isNone(decoded)) return refusal(400, "invalid")
        fields.version = decoded.value.version
        const row = yield* runOf(runId)
        if (row === undefined) return refusal(404, "not_found")
        if (row.launchedBy !== actorId) {
          fields.errorCode = "not_launcher"
          return refusal(403, "forbidden")
        }
        if (!fits(row.kind, decoded.value.value)) return refusal(400, "invalid")
        // An answered question closes for every recipient in the answer's transaction.
        const txid = yield* withFold(applyAnswer(runId, actorId, decoded.value), runId, login)
        if (txid !== undefined) return ok(txid)
        if (row.version === decoded.value.version && same(row.answer?.value, kept(decoded.value.value))) {
          fields.existing = true
          return ok(null)
        }
        return refusal(409, "not_open")
      })

    const route = (rest: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const [segment = "", tail, ...more] = rest.split("/")
        const kind = tail === undefined ? "report" : tail === "credential" ? "credential" : "answer"
        // A credential's run is any execution id, so its segment is percent-encoded; a report's and an answer's is an
        // answer's id.
        const runId = kind === "credential" ? decodedRun(segment) : segment
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Fields = { runId: runId ?? "" }
        const response = yield* Effect.gen(function* () {
          if (
            (tail !== undefined && tail !== "answer" && tail !== "credential") || more.length > 0 || runId === undefined ||
            (kind !== "credential" && !isUuid(runId))
          ) {
            return refusal(404, "not_found")
          }
          if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
          const actor = yield* (yield* Sessions).resolve
          if (Option.isNone(actor)) return refusal(401, "authentication")
          if (kind === "credential") return yield* credential(request, runId, actor.value, fields).pipe(Effect.provide(database))
          const id = runId.toLowerCase()
          // A run is its answer's (decision 0009 §2): only a Member or above on that conversation's repository who may
          // edit its branch asks there, so reports or answers its runs (ruling AUTH-8).
          const asking = yield* askingOnAnswer(actor.value, id).pipe(Effect.provide(database))
          if (asking !== undefined && asking !== "ask") {
            fields.errorCode = asking
            return refusal(403, "forbidden")
          }
          if (actor.value.act !== undefined) fields.act = actor.value.act.kind
          // Only the person answers what the agent asked them (decision 0017 slice 0).
          if (kind === "answer" && (yield* refusesPersonOnly(actor.value, "run/answer"))) {
            return refusal(403, "person_only")
          }
          // A run's credential reports only for the run its chain started from.
          if (!boundTo(actor.value, id)) return refusal(403, "other_run")
          const handled = kind === "report"
            ? report(request, id, actor.value.subject.id, actor.value.login, fields)
            : answer(request, id, actor.value.subject.id, actor.value.login, fields)
          return yield* handled.pipe(Effect.provide(database))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              fields.errorCode = codeOf(Cause.squash(cause))
              return refusal(503, "unavailable")
            })
          ),
        )
        fields.status = response.status
        fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Metric.update(Metric.withAttributes(requests, { route: kind, status: String(response.status) }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          kind === "credential" ? "auth.credential" : `agent.status.${kind}`,
        ).pipe(Effect.annotateLogs(fields))
        return response
      }).pipe(Effect.withSpan("agent.status.request", { kind: "server", attributes: { "smithers.run.id": rest.split("/")[0] } }))

    /**
     * `POST /api/runs/<run>/credential`: the run credential of run `runId` for `actor`. The person's agent run is their
     * own answer: `chat/Answer`'s run is the answer's id, whose question they asked. Each mint is a log line
     * `auth.credential` and a count, with the flow, the act and the depth, never the payload.
     */
    const credential = (request: HttpServerRequest.HttpServerRequest, runId: string, actor: Actor, fields: Fields) =>
      Effect.gen(function* () {
        const body = yield* readBounded(request, MAX_CREDENTIAL_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(
          Effect.result,
        )
        if (body._tag === "Failure") {
          return body.failure.reason === "too_large" ? refusal(413, "too_large") : refusal(400, "invalid")
        }
        const decoded = yield* decodeMint(body.success).pipe(Effect.option)
        if (Option.isNone(decoded)) return refusal(400, "invalid")
        const { flow, renew } = decoded.value
        if (renew !== undefined) {
          const service = yield* RunCredentials.RunCredentials
          const renewed = yield* service.renew(renew, actor, runId)
          const outcome = Option.isSome(renewed) ? "renewed" : "renewal_refused"
          yield* Metric.update(Metric.withAttributes(RunCredentials.credentials, { op: "renew", outcome, act: Option.isSome(renewed) ? renewed.value.act : "none" }), 1)
          if (Option.isNone(renewed)) return refusal(403, "renewal_refused")
          fields.flow = renewed.value.chain.at(-1)!
          fields.act = renewed.value.act
          fields.depth = renewed.value.chain.length
          return HttpServerResponse.jsonUnsafe({ token: yield* service.sign(renewed.value), act: renewed.value.act, expiresAt: renewed.value.exp }, { headers: noStore })
        }
        fields.flow = flow
        fields.by = actor.act?.kind ?? "person"
        if (actor.act === undefined && flow === AGENT_RUN_FLOW) {
          const askedBy = isUuid(runId) ? yield* askerOf(runId.toLowerCase()) : undefined
          if (askedBy === undefined) return refusal(404, "not_found")
          if (askedBy !== actor.subject.id) {
            fields.errorCode = "not_launcher"
            return refusal(403, "forbidden")
          }
        }
        const claims = RunCredentials.claimsFor(actor, runId, decoded.value, yield* Clock.currentTimeMillis)
        if (Result.isFailure(claims)) {
          yield* Metric.update(
            Metric.withAttributes(RunCredentials.credentials, { op: "mint", outcome: claims.failure, act: "none" }),
            1,
          )
          return refusal(403, claims.failure)
        }
        fields.act = claims.success.act
        fields.depth = claims.success.chain.length
        const token = yield* (yield* RunCredentials.RunCredentials).sign(claims.success)
        yield* Metric.update(
          Metric.withAttributes(RunCredentials.credentials, { op: "mint", outcome: "minted", act: claims.success.act }),
          1,
        )
        return HttpServerResponse.jsonUnsafe(
          { token, act: claims.success.act, expiresAt: claims.success.exp },
          { headers: noStore },
        )
      })

    /** `GET /api/shapes/runs`: the signed-in person's rows; signed out, none; sessions unreadable, 503 (ShapeAccess). */
    const shape = ShapeProxy.make({
      ...connection,
      shape: Effect.map(ShapeAccess.actor, (actor) => ({
        table: RUNS_TABLE,
        // A repository's runs are its own list's (docs/features/actions.md), not the person's agent's.
        where: "launched_by = $1 AND execution IS NULL",
        params: { "1": Option.match(actor, { onNone: () => NOBODY, onSome: (actor) => actor.subject.id }) },
        columns: SYNCED_RUN_COLUMNS,
      })),
      name: "agent.status.shape",
      metric: shapes,
    })

    return { route, shape }
  })
