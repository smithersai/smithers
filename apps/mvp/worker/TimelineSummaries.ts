import { MAX_SUMMARY_BODY_BYTES } from "../src/features/timeline/contract.ts"
import { Clock, Config, Effect, Metric, Option, Schema } from "effect"
import type { Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { MARK_SUMMARY_LENGTH, MOST_COVERED, PHASES_FLOW, SEGMENT_SPANS, SUMMARIZE_FLOW, SUMMARY_DAILY_CAP, SUMMARY_REASONS, TIMELINE_SUMMARIES_ROUTE, TITLE_LENGTH } from "../src/features/timeline/contract.ts"
import { segmentRevision } from "../src/features/timeline/identity.ts"
import { checkPlan, exchangeUnits, phaseUnits, type PhaseRow, sealSpans } from "../src/features/timeline/marks.ts"
import { Sessions } from "./Actor.vibe"
import { branchAccess, canView } from "./branch/Access.ts"
import { readBounded } from "./Body.vibe"

// The timeline's summaries, once per message for everyone (docs/features/timeline.md#cost). A tab that wants a model
// summary of a finished answer claims it first; only the claim that inserts the row calls the model, and its summary is
// recorded on the message, which every device syncs. On smithers.sh on 2026-10-25 each tab, device and fresh browser
// made its own: 350 calls on one person's key in 50 minutes against 19 answers.
//
// Phases and arcs (decision 0138) work the same way one level out: `claim_spans` takes the one call a segmentation may
// cost, and `record_spans` writes what it made onto the messages they start at. A device says only where its spans
// start and what they are called: the server holds the conversation, so it checks the call against its own items and
// counts each span's coverage itself. One recording at a time per conversation and level, under an advisory lock, so a
// closed span never changes and a stale call never replaces a newer one. A claim whose model never answered is
// released, so the message or span can be made once a model can, and one left behind by a closed tab may be taken again
// after ten minutes.
//
// A claim belongs to its `owner`, the durable run that took it: only that run records or releases it, so a run that lost
// its claim after ten minutes is fenced out, and the same run after a crash resumes it, free, and records what its journal
// kept. Every other claim reserves one of the person's daily attempts in the same transaction, under a lock on the person,
// and leaves an attempt record that is never changed, so concurrent claims can't overspend the cap and a reclaim moves
// nobody's history.

const Id = Schema.String.check(Schema.isUUID())
const Revision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16,128}$/))
/** The durable run holding a claim. */
const Owner = Id
const Level = Schema.Literals([1, 2])
/** How many of the conversation's items a segmentation stands for. */
const Read = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MOST_COVERED))
/** What a person may hand this route: the largest record, twelve spans' words. */
const Request = Schema.Union([
  Schema.Struct({ op: Schema.Literal("claim"), messageId: Id, revision: Revision, owner: Owner, reason: Schema.Literals(SUMMARY_REASONS) }),
  Schema.Struct({
    op: Schema.Literal("record"), messageId: Id, revision: Revision, owner: Owner,
    summary: Schema.String.check(Schema.isPattern(/^[^\n\r<>`]{1,96}$/)),
  }),
  Schema.Struct({ op: Schema.Literal("release"), messageId: Id, revision: Revision, owner: Owner }),
  Schema.Struct({ op: Schema.Literal("claim_spans"), messageId: Id, level: Level, revision: Revision, owner: Owner, read: Read }),
  Schema.Struct({
    op: Schema.Literal("record_spans"), messageId: Id, level: Level, revision: Revision, owner: Owner, read: Read,
    spans: Schema.Array(Schema.Struct({
      id: Id,
      title: Schema.String.check(Schema.isMaxLength(TITLE_LENGTH)),
      summary: Schema.String.check(Schema.isMaxLength(MARK_SUMMARY_LENGTH)),
    })).check(Schema.isMinLength(1), Schema.isMaxLength(SEGMENT_SPANS)),
  }),
  Schema.Struct({ op: Schema.Literal("release_spans"), messageId: Id, level: Level, revision: Revision, owner: Owner }),
])
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Request))
const headers = { "cache-control": "no-store" }
/** A response and its outcome, for the metric and the log: the refusal's `code`, or what the request did. */
const answer = (status: number, body: Record<string, unknown>, outcome = String(body.code)) =>
  ({ response: HttpServerResponse.jsonUnsafe(body, { status, headers }), outcome })

/** The person's claims in any 24 hours that start a model call: `TIMELINE_SUMMARY_DAILY_CAP`, 200 unless set. */
export const dailyCap = (unset: number = SUMMARY_DAILY_CAP) =>
  Config.schema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), "TIMELINE_SUMMARY_DAILY_CAP").pipe(Config.withDefault(unset))
/** Each request's outcome: `claimed`, `resumed`, `taken`, `capped`, `recorded`, `unclaimed`, or a refusal's code. */
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
      const body = yield* readBounded(request, MAX_SUMMARY_BODY_BYTES).pipe(Effect.option)
      const parsed = Option.isNone(body) ? Option.none() : yield* decode(body.value).pipe(Effect.option)
      if (Option.isNone(parsed)) return answer(400, { code: "invalid_request" })
      const p = parsed.value
      if (p.op === "claim") reason = p.reason
      const person = actor.value.subject.id
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const messageId = p.messageId.toLowerCase()
        /** The conversation's items at `level`, in order, as the server holds them. */
        const unitsOf = (conversationId: string, level: 1 | 2) => sql<PhaseRow & { readonly arc: string | null }>`
          SELECT id, role, status, '' AS text, question_id AS "questionId", phase, arc
          FROM messages WHERE conversation_id = ${conversationId} AND role IN ('user', 'assistant') ORDER BY position`.pipe(
          Effect.map(rows => level === 1 ? exchangeUnits(rows) : phaseUnits(rows)),
        )
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
              WHERE message_id = ${messageId} AND revision = ${p.revision} AND person_id = ${person} AND owner = ${p.owner} AND released_at IS NULL
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
            WHERE message_id = ${messageId} AND revision = ${p.revision} AND person_id = ${person} AND owner = ${p.owner} AND recorded_at IS NULL`
          return answer(200, { released: true }, "released")
        }
        if (p.op === "release_spans") {
          yield* sql`
            UPDATE timeline_phase_claims SET released_at = now()
            WHERE anchor_id = ${messageId} AND level = ${p.level} AND revision = ${p.revision} AND person_id = ${person} AND owner = ${p.owner} AND recorded_at IS NULL`
          return answer(200, { released: true }, "released")
        }
        if (p.op === "record_spans") {
          const column = sql(p.level === 1 ? "phase" : "arc")
          if (p.revision !== segmentRevision(messageId, p.level, p.read)) return answer(400, { code: "invalid_request" })
          return yield* sql.withTransaction(Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`timeline:${message.conversationId}:${p.level}`}, 0))`
            const [claim] = yield* sql<{ readonly recorded: boolean }>`
              SELECT recorded_at IS NOT NULL AS recorded FROM timeline_phase_claims
              WHERE anchor_id = ${messageId} AND level = ${p.level} AND revision = ${p.revision} AND person_id = ${person} AND owner = ${p.owner} AND released_at IS NULL
              FOR UPDATE`
            if (claim === undefined) return answer(409, { code: "unclaimed" })
            // A replay of what was recorded: it stands.
            if (claim.recorded) return answer(200, { recorded: true }, "recorded")
            const ids = checkPlan(yield* unitsOf(message.conversationId, p.level), messageId, p.read)
            if (typeof ids === "string") return answer(409, { code: ids })
            const marks = sealSpans(p.spans.map(span => ({ ...span, id: span.id.toLowerCase() })), ids)
            if (marks === undefined) return answer(400, { code: "invalid_request" })
            // Everything from the anchor on is open: `checkPlan` says so under the lock.
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
        if (p.op === "claim_spans") {
          if (p.revision !== segmentRevision(messageId, p.level, p.read)) return answer(400, { code: "invalid_request" })
          // No call is spent on a plan the record would refuse.
          const ids = checkPlan(yield* unitsOf(message.conversationId, p.level), messageId, p.read)
          if (typeof ids === "string") return answer(409, { code: ids })
        }
        return yield* sql.withTransaction(Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`timeline:cap:${person}`}, 0))`
          // The run that holds it, back after a crash: it resumes what it claimed, and it costs nothing more.
          const [held] = p.op === "claim_spans"
            ? yield* sql`
                SELECT 1 AS held FROM timeline_phase_claims
                WHERE anchor_id = ${messageId} AND level = ${p.level} AND revision = ${p.revision} AND person_id = ${person} AND owner = ${p.owner} AND released_at IS NULL`
            : yield* sql`
                SELECT 1 AS held FROM timeline_summaries
                WHERE message_id = ${messageId} AND revision = ${p.revision} AND person_id = ${person} AND owner = ${p.owner} AND released_at IS NULL`
          if (held !== undefined) return answer(200, { claimed: true }, "resumed")
          // Every attempt counts, released or not: an outage must not re-claim the same messages for ever.
          const [spent] = yield* sql<{ readonly n: number }>`
            SELECT count(*)::int AS n FROM timeline_attempts WHERE person_id = ${person} AND claimed_at > now() - interval '1 day'`
          if (spent!.n >= cap) return answer(429, { code: "capped" })
          const [claimed] = p.op === "claim_spans"
            ? yield* sql`
                INSERT INTO timeline_phase_claims (anchor_id, level, revision, person_id, owner)
                VALUES (${messageId}, ${p.level}, ${p.revision}, ${person}, ${p.owner})
                ON CONFLICT (anchor_id, level, revision) DO UPDATE
                  SET person_id = EXCLUDED.person_id, owner = EXCLUDED.owner, claimed_at = now(), released_at = NULL
                  WHERE timeline_phase_claims.recorded_at IS NULL
                    AND (timeline_phase_claims.released_at IS NOT NULL OR timeline_phase_claims.claimed_at < now() - interval '10 minutes')
                RETURNING anchor_id`
            : yield* sql`
                INSERT INTO timeline_summaries (message_id, revision, person_id, reason, owner)
                VALUES (${messageId}, ${p.revision}, ${person}, ${p.reason}, ${p.owner})
                ON CONFLICT (message_id, revision) DO UPDATE
                  SET person_id = EXCLUDED.person_id, owner = EXCLUDED.owner, claimed_at = now(), released_at = NULL, reason = EXCLUDED.reason
                  WHERE timeline_summaries.recorded_at IS NULL
                    AND (timeline_summaries.released_at IS NOT NULL OR timeline_summaries.claimed_at < now() - interval '10 minutes')
                RETURNING message_id`
          if (claimed === undefined) return answer(200, { claimed: false }, "taken")
          const kind = p.op === "claim_spans" ? "spans" : "summary"
          yield* sql`
            INSERT INTO timeline_attempts (person_id, kind, message_id, revision, owner)
            VALUES (${person}, ${kind}, ${messageId}, ${p.revision}, ${p.owner})`
          return answer(200, { claimed: true }, "claimed")
        }))
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
