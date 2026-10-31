import { Clock, Config, Effect, Metric, Option, Schema } from "effect"
import type { Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { MARK_LENGTH, PHASES_FLOW, SEGMENT_SPANS, SUMMARIZE_FLOW, SUMMARY_DAILY_CAP, SUMMARY_REASONS, TIMELINE_SUMMARIES_ROUTE } from "../src/features/timeline/contract.ts"
import { parseMark } from "../src/features/timeline/marks.ts"
import { Sessions } from "./Actor.ts"
import { branchAccess, canView } from "./branch/Access.ts"
import { readBounded } from "./Body.ts"

// The timeline's summaries, once per message for everyone (docs/features/timeline.md#cost). A tab that wants a model
// summary of a finished answer claims it first; only the claim that inserts the row calls the model, and its summary is
// recorded on the message, which every device syncs. On smithers.sh on 2026-10-25 each tab, device and fresh browser
// made its own: 350 calls on one person's key in 50 minutes against 19 answers.
//
// Phases and arcs (decision 0138) work the same way one level out: `claim_spans` takes the one call a segmentation may
// cost, and `record_spans` writes what it made onto the messages they start at. A closed span never changes. A claim
// whose model never answered is released, so the message or span can be made once a model can, and one left behind by
// a closed tab may be taken again after ten minutes. Every attempt counts against the daily cap.

const Id = Schema.String.check(Schema.isUUID())
const Revision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16,128}$/))
const Level = Schema.Literals([1, 2])
/** What a person may hand this route: the largest record, twelve spans of stored marks. */
const MAX_BODY = 16_384
const Request = Schema.Union([
  Schema.Struct({ op: Schema.Literal("claim"), messageId: Id, revision: Revision, reason: Schema.Literals(SUMMARY_REASONS) }),
  Schema.Struct({
    op: Schema.Literal("record"), messageId: Id, revision: Revision,
    summary: Schema.String.check(Schema.isPattern(/^[^\n\r<>`]{1,96}$/)),
  }),
  Schema.Struct({ op: Schema.Literal("release"), messageId: Id, revision: Revision }),
  Schema.Struct({ op: Schema.Literal("claim_spans"), messageId: Id, level: Level, revision: Revision }),
  Schema.Struct({
    op: Schema.Literal("record_spans"), messageId: Id, level: Level, revision: Revision,
    spans: Schema.Array(Schema.Struct({ id: Id, mark: Schema.String.check(Schema.isMaxLength(MARK_LENGTH)) })).check(Schema.isMinLength(1), Schema.isMaxLength(SEGMENT_SPANS)),
  }),
  Schema.Struct({ op: Schema.Literal("release_spans"), messageId: Id, level: Level, revision: Revision }),
])
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Request))
const headers = { "cache-control": "no-store" }
/** A response and its outcome, for the metric and the log: the refusal's `code`, or what the request did. */
const answer = (status: number, body: Record<string, unknown>, outcome = String(body.code)) =>
  ({ response: HttpServerResponse.jsonUnsafe(body, { status, headers }), outcome })

/** The person's claims in any 24 hours that start a model call: `TIMELINE_SUMMARY_DAILY_CAP`, 200 unless set. */
export const dailyCap = (unset: number = SUMMARY_DAILY_CAP) =>
  Config.schema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), "TIMELINE_SUMMARY_DAILY_CAP").pipe(Config.withDefault(unset))
/** Each request's outcome: `claimed`, `taken`, `capped`, `recorded`, `unclaimed`, or a refusal's code. */
export const claims = Metric.counter("smithers_timeline_summary_claims", { incremental: true })

export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, unsetCap?: number) => Effect.gen(function* () {
  const cap = yield* dailyCap(unsetCap)
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
      const flow = act?.kind === "flow" ? act.chain?.at(-1) : undefined
      if (act !== undefined && flow !== SUMMARIZE_FLOW && flow !== PHASES_FLOW) return answer(403, { code: "person_only" })
      const body = yield* readBounded(request, MAX_BODY).pipe(Effect.option)
      const parsed = Option.isNone(body) ? Option.none() : yield* decode(body.value).pipe(Effect.option)
      if (Option.isNone(parsed)) return answer(400, { code: "invalid_request" })
      const p = parsed.value
      if (p.op === "claim") reason = p.reason
      const person = actor.value.subject.id
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const messageId = p.messageId.toLowerCase()
        const [message] = yield* sql<{ readonly conversationId: string; readonly finished: boolean; readonly position: string }>`
          SELECT conversation_id AS "conversationId", role IN ('user', 'assistant') AND status = 'done' AS finished, position
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
              WHERE message_id = ${messageId} AND revision = ${p.revision} AND person_id = ${person} AND released_at IS NULL
              RETURNING message_id
            )
            UPDATE messages SET summary = ${p.summary}, summary_revision = ${p.revision}
            WHERE id IN (SELECT message_id FROM claim)
            RETURNING id`
          return recorded === undefined ? answer(409, { code: "unclaimed" }) : answer(200, { recorded: true }, "recorded")
        }
        if (p.op === "release") {
          yield* sql`
            UPDATE timeline_summaries SET released_at = now()
            WHERE message_id = ${messageId} AND revision = ${p.revision} AND person_id = ${person} AND recorded_at IS NULL`
          return answer(200, { released: true }, "released")
        }
        if (p.op === "release_spans") {
          yield* sql`
            UPDATE timeline_phase_claims SET released_at = now()
            WHERE anchor_id = ${messageId} AND level = ${p.level} AND revision = ${p.revision} AND person_id = ${person} AND recorded_at IS NULL`
          return answer(200, { released: true }, "released")
        }
        if (p.op === "record_spans") {
          const column = sql(p.level === 1 ? "phase" : "arc")
          const marks = p.spans.flatMap(span => Option.isSome(parseMark(span.mark)) ? [{ id: span.id.toLowerCase(), mark: span.mark }] : [])
          if (marks.length !== p.spans.length || marks[0]!.id !== messageId) return answer(400, { code: "invalid_request" })
          const ids = marks.map(mark => mark.id)
          return yield* sql.withTransaction(Effect.gen(function* () {
            const [claim] = yield* sql<{ readonly recorded: boolean }>`
              SELECT recorded_at IS NOT NULL AS recorded FROM timeline_phase_claims
              WHERE anchor_id = ${messageId} AND level = ${p.level} AND revision = ${p.revision} AND person_id = ${person} AND released_at IS NULL
              FOR UPDATE`
            if (claim === undefined) return answer(409, { code: "unclaimed" })
            // A replay of what was recorded: it stands.
            if (claim.recorded) return answer(200, { recorded: true }, "recorded")
            const [found] = yield* sql<{ readonly n: number }>`
              SELECT count(*)::int AS n FROM messages
              WHERE id = ANY(${ids}::uuid[]) AND conversation_id = ${message.conversationId} AND position >= ${message.position}`
            if (found!.n !== ids.length) return answer(400, { code: "invalid_request" })
            // A closed span never changes; only what is still open at or after the anchor is rewritten.
            const [closed] = yield* sql`
              SELECT id FROM messages
              WHERE conversation_id = ${message.conversationId} AND position >= ${message.position} AND ${column} IS NOT NULL
                AND (${column}::jsonb ->> 'closed') = 'true'
              LIMIT 1`
            if (closed !== undefined) return answer(409, { code: "closed" })
            // An anchor with no mark of its own, before marks that exist, read a stale conversation: it sits inside a
            // closed span, and writing there would cut that span short.
            const [stale] = yield* sql`
              SELECT 1 AS stale FROM messages m
              WHERE m.conversation_id = ${message.conversationId} AND m.position > ${message.position} AND m.${column} IS NOT NULL
                AND EXISTS (SELECT 1 FROM messages a WHERE a.id = ${messageId} AND a.${column} IS NULL)
              LIMIT 1`
            if (stale !== undefined) return answer(409, { code: "closed" })
            yield* sql`
              UPDATE messages SET ${column} = NULL
              WHERE conversation_id = ${message.conversationId} AND position >= ${message.position} AND ${column} IS NOT NULL`
            for (const { id, mark } of marks) yield* sql`UPDATE messages SET ${column} = ${mark} WHERE id = ${id}`
            yield* sql`
              UPDATE timeline_phase_claims SET recorded_at = now()
              WHERE anchor_id = ${messageId} AND level = ${p.level} AND revision = ${p.revision}`
            return answer(200, { recorded: true }, "recorded")
          }))
        }
        if (!message.finished) return answer(409, { code: "unfinished" })
        // Every attempt counts, released or not: an outage must not re-claim the same messages for ever.
        const [spent] = yield* sql<{ readonly n: number }>`
          SELECT (SELECT coalesce(sum(attempts), 0) FROM timeline_summaries
                  WHERE person_id = ${person} AND claimed_at > now() - interval '1 day')::int
               + (SELECT coalesce(sum(attempts), 0) FROM timeline_phase_claims
                  WHERE person_id = ${person} AND claimed_at > now() - interval '1 day')::int AS n`
        if (spent!.n >= cap) return answer(429, { code: "capped" })
        const [claimed] = p.op === "claim_spans"
          ? yield* sql`
              INSERT INTO timeline_phase_claims (anchor_id, level, revision, person_id)
              VALUES (${messageId}, ${p.level}, ${p.revision}, ${person})
              ON CONFLICT (anchor_id, level, revision) DO UPDATE
                SET person_id = EXCLUDED.person_id, claimed_at = now(), released_at = NULL, attempts = timeline_phase_claims.attempts + 1
                WHERE timeline_phase_claims.recorded_at IS NULL
                  AND (timeline_phase_claims.released_at IS NOT NULL OR timeline_phase_claims.claimed_at < now() - interval '10 minutes')
              RETURNING anchor_id`
          : yield* sql`
              INSERT INTO timeline_summaries (message_id, revision, person_id, reason)
              VALUES (${messageId}, ${p.revision}, ${person}, ${p.reason})
              ON CONFLICT (message_id, revision) DO UPDATE
                SET person_id = EXCLUDED.person_id, claimed_at = now(), released_at = NULL, reason = EXCLUDED.reason, attempts = timeline_summaries.attempts + 1
                WHERE timeline_summaries.recorded_at IS NULL
                  AND (timeline_summaries.released_at IS NOT NULL OR timeline_summaries.claimed_at < now() - interval '10 minutes')
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
