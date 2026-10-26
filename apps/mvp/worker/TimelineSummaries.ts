import { Clock, Config, Effect, Metric, Option, Schema } from "effect"
import type { Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { SUMMARIZE_FLOW, SUMMARY_DAILY_CAP, SUMMARY_REASONS, TIMELINE_SUMMARIES_ROUTE } from "../src/features/timeline/contract.ts"
import { Sessions } from "./Actor.ts"
import { branchAccess, canView } from "./branch/Access.ts"
import { readBounded } from "./Body.ts"

// The timeline's summaries, once per message for everyone (docs/features/timeline.md#cost). A tab that wants a model
// summary of a finished answer claims it first; only the claim that inserts the row calls the model, and its summary is
// recorded on the message, which every device syncs. On smithers.sh on 2026-10-25 each tab, device and fresh browser
// made its own: 350 calls on one person's key in 50 minutes against 19 answers.

const Id = Schema.String.check(Schema.isUUID())
const Revision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16,128}$/))
const Request = Schema.Union([
  Schema.Struct({ op: Schema.Literal("claim"), messageId: Id, revision: Revision, reason: Schema.Literals(SUMMARY_REASONS) }),
  Schema.Struct({
    op: Schema.Literal("record"), messageId: Id, revision: Revision,
    summary: Schema.String.check(Schema.isPattern(/^[^\n\r<>`]{1,96}$/)),
  }),
])
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Request))
const headers = { "cache-control": "no-store" }
/** A response and its outcome, for the metric and the log: the refusal's `code`, or what the request did. */
const answer = (status: number, body: Record<string, unknown>, outcome = String(body.code)) =>
  ({ response: HttpServerResponse.jsonUnsafe(body, { status, headers }), outcome })

/** The person's claims in any 24 hours that start a model call: `TIMELINE_SUMMARY_DAILY_CAP`, 200 unless set. */
export const dailyCap = Config.schema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), "TIMELINE_SUMMARY_DAILY_CAP").pipe(
  Config.withDefault(SUMMARY_DAILY_CAP),
)
/** Each request's outcome: `claimed`, `taken`, `capped`, `recorded`, `unclaimed`, or a refusal's code. */
export const claims = Metric.counter("smithers_timeline_summary_claims", { incremental: true })

export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => Effect.gen(function* () {
  const cap = yield* dailyCap
  const write = Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    let reason: string | undefined
    const { response, outcome } = yield* Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.method !== "POST") return { response: HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } }), outcome: "method" }
      const actor = yield* (yield* Sessions).resolve
      if (Option.isNone(actor)) return answer(401, { code: "signed_out" })
      // A person's summaries: their own session, or the summary flow acting for them; never an agent or another run.
      const act = actor.value.act
      if (act !== undefined && !(act.kind === "flow" && act.chain?.at(-1) === SUMMARIZE_FLOW)) return answer(403, { code: "person_only" })
      const body = yield* readBounded(request, 1024).pipe(Effect.option)
      const parsed = Option.isNone(body) ? Option.none() : yield* decode(body.value).pipe(Effect.option)
      if (Option.isNone(parsed)) return answer(400, { code: "invalid_request" })
      const p = parsed.value
      if (p.op === "claim") reason = p.reason
      const person = actor.value.subject.id
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const messageId = p.messageId.toLowerCase()
        const [message] = yield* sql<{ readonly conversationId: string; readonly finished: boolean }>`
          SELECT conversation_id AS "conversationId", role = 'assistant' AND status = 'done' AS finished
          FROM messages WHERE id = ${messageId}`
        // Only someone who may view the conversation summarizes its messages; anyone else learns nothing of them.
        const access = message === undefined
          ? undefined
          : yield* branchAccess(actor, message.conversationId, "conversation")
        if (message === undefined || access === undefined || !canView(access.access)) return answer(404, { code: "not_found" })
        if (p.op === "record") {
          const [recorded] = yield* sql`
            WITH claim AS (
              UPDATE timeline_summaries SET recorded_at = coalesce(recorded_at, now())
              WHERE message_id = ${messageId} AND revision = ${p.revision} AND person_id = ${person}
              RETURNING message_id
            )
            UPDATE messages SET summary = ${p.summary}, summary_revision = ${p.revision}
            WHERE id IN (SELECT message_id FROM claim)
            RETURNING id`
          return recorded === undefined ? answer(409, { code: "unclaimed" }) : answer(200, { recorded: true }, "recorded")
        }
        if (!message.finished) return answer(409, { code: "unfinished" })
        const [spent] = yield* sql<{ readonly n: number }>`
          SELECT count(*)::int AS n FROM timeline_summaries
          WHERE person_id = ${person} AND claimed_at > now() - interval '1 day'`
        if (spent!.n >= cap) return answer(429, { code: "capped" })
        const [claimed] = yield* sql`
          INSERT INTO timeline_summaries (message_id, revision, person_id, reason)
          VALUES (${messageId}, ${p.revision}, ${person}, ${p.reason})
          ON CONFLICT DO NOTHING
          RETURNING message_id`
        return claimed === undefined ? answer(200, { claimed: false }, "taken") : answer(200, { claimed: true }, "claimed")
      }).pipe(Effect.provide(database))
    }).pipe(Effect.catchCause(() => Effect.succeed(answer(503, { code: "unavailable" }))))
    yield* Metric.update(Metric.withAttributes(claims, { outcome }), 1)
    yield* Effect.annotateCurrentSpan({ status: response.status, outcome })
    yield* Effect.logInfo("timeline.summary.claim").pipe(Effect.annotateLogs({
      status: response.status, outcome, durationMs: (yield* Clock.currentTimeMillis) - started,
      ...(reason === undefined ? {} : { reason }),
    }))
    return response
  }).pipe(Effect.withSpan("timeline.summary.claim", { kind: "server" }))
  return { route: TIMELINE_SUMMARIES_ROUTE, write }
})
