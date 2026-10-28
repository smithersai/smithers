import { Cause, Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { MAX_ANSWER_BODY_BYTES } from "../src/features/agent/contract.ts"
import { AnswerWrite, type Turn } from "../src/features/agent/schema.ts"
import { agentLiveSeconds } from "../src/features/model/contract.ts"
import { boundTo, Sessions } from "./Actor.ts"
import { askingOnAnswer } from "./branch/Access.ts"
import { readBounded } from "./Body.ts"
import { codeOf } from "./ErrorCode.ts"
import * as Notifications from "./Notifications.ts"
import * as Messages from "./Messages.ts"

// The answer routes (docs/features/agent.md#the-answer-routes): the server's write path for the answers the browser's
// agent gives (decision 0011). The agent reads its turn here, then writes its parts while it streams and its text or
// failure when it settles. Only the person who asked the question may (`asked_by`, recorded from their session when
// they asked), and only while they may still ask there (Member or above on the conversation's repository, decision 0007,
// ruling AUTH-8) and edit the conversation's branch (worker/branch/Access.ts `askingOnAnswer`): another Member, or an
// asker whose role there or access to the branch was taken away, can't read the turn, write, settle or learn whether a
// settle landed. An answer changes only while it is
// `streaming`; a settle sent again after it landed is answered as landed. Confirmed durable-engine heartbeats renew
// liveness independently of visible text. A later turn fences expired predecessors as abandoned before reading history.


/** Answer route requests, by `route` (`turn`, `write`) and `status`. */
export const requests = Metric.counter("smithers_answer_requests", {
  description: "Requests to the answer routes, by route and status",
  incremental: true,
})

const decodeWrite = Schema.decodeUnknownEffect(Schema.fromJsonString(AnswerWrite))

type Fields = Record<string, string | number | boolean>

/** A refusal: its status and code, logged and answered as `{ code }`. */
const refusal = (status: number, code: string) =>
  HttpServerResponse.jsonUnsafe({ code }, { status, headers: { "cache-control": "no-store" } })

const ok = (body: unknown) => HttpServerResponse.jsonUnsafe(body, { headers: { "cache-control": "no-store" } })

/** A person who didn't ask the question: `403 forbidden`, as for a role that may not ask, logged as `not_asker`. */
const notAsker = (fields: Fields) => {
  fields.errorCode = "not_asker"
  return refusal(403, "forbidden")
}

/**
 * The answer's row, who asked its question (`null` for a question asked before askers were recorded), and whether it
 * must wait: an earlier answer in its conversation still streams and has a live host lease or awaits a person.
 * Conversations never wait for each other (decision 0013 §1). Before admission the route fences expired predecessors;
 * human waits retain their place regardless of age. `chat/Expire` also settles answers without a later turn.
 * `waitedMs` is how long this turn has waited since the queue last moved: since the latest earlier answer settled,
 * or since it was asked if that is later, on Postgres' clock.
 */
const target = (answerId: string, liveSeconds: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly status: string
      readonly question: string
      readonly text: string
      readonly failure: string | null
      readonly askedBy: string | null
      readonly waiting: boolean
      readonly waitedMs: number
    }>`
      SELECT a.status, q.text || CASE WHEN q.data IS NULL THEN '' ELSE ${Messages.SENT_VALUES}::text || q.data::text END
        AS question, a.text, a.failure, q.asked_by AS "askedBy",
        EXISTS (
          SELECT 1 FROM messages e
          WHERE e.conversation_id = a.conversation_id AND e.role = 'assistant' AND e.status = 'streaming'
            AND e.position < a.position
            AND (EXISTS (SELECT 1 FROM runs r WHERE r.id = e.id AND r.status = 'needs_you')
              OR GREATEST(e.updated_at, (SELECT r.updated_at FROM runs r WHERE r.id = e.id AND r.status = 'working'))
                > now() - make_interval(secs => ${liveSeconds}))
        ) AS waiting,
        GREATEST(0, floor(extract(epoch FROM now() - GREATEST(a.created_at, (
          SELECT e.updated_at FROM messages e
          WHERE e.conversation_id = a.conversation_id AND e.role = 'assistant' AND e.status <> 'streaming'
            AND e.position < a.position
          ORDER BY e.position DESC LIMIT 1
        ))) * 1000))::float8 AS "waitedMs"
      FROM messages a JOIN messages q ON q.id = a.question_id
      WHERE a.id = ${answerId}`
    return row
  })

/** Fence silent predecessors before a later answer receives its history. */
const abandonEarlier = (answerId: string, liveSeconds: number) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly id: string }>`UPDATE messages e
    SET status = 'failed', failure = 'abandoned', updated_at = now()
    FROM messages a WHERE a.id = ${answerId} AND e.conversation_id = a.conversation_id
      AND e.role = 'assistant' AND e.position < a.position AND e.status = 'streaming'
      AND GREATEST(e.updated_at, (SELECT r.updated_at FROM runs r WHERE r.id = e.id AND r.status = 'working'))
        <= now() - make_interval(secs => ${liveSeconds})
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = e.id AND r.status = 'needs_you')
    RETURNING e.id`
  for (const row of rows) {
    yield* sql`UPDATE runs SET status = 'failed', waiting = NULL, updated_at = now()
      WHERE id = ${row.id} AND status NOT IN ('done', 'failed')`
    yield* Notifications.foldRun(row.id, undefined)
  }
  return rows.length
})

/**
 * Marks a streaming answer that is waiting its turn as live, so it keeps the answers after it in order: only once a
 * third of `liveSeconds` has passed since its last write. Every write reaches every device through Electric, and an
 * answer asked again at most every 4 s (`TURN_RETRY`) stays live with these alone.
 */
const touch = (answerId: string, liveSeconds: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`UPDATE messages SET updated_at = now()
        WHERE id = ${answerId} AND status = 'streaming' AND updated_at < now() - make_interval(secs => ${liveSeconds / 3})
        RETURNING id`.pipe(Effect.map((rows) => rows.length > 0)),
  )

/**
 * Writes `write` to a streaming answer whose question `askedBy` asked: whether it landed, and its transaction. The
 * asker is checked in the same statement as the write, so no other person's write lands.
 */
const apply = (answerId: string, askedBy: string, write: AnswerWrite) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const parts = write.parts === undefined ? null : JSON.stringify(write.parts)
    const rows = write.status === "streaming"
      ? yield* sql<{ readonly txid: string }>`
        UPDATE messages a SET parts = ${parts}::jsonb, text = COALESCE(${write.text ?? null}, a.text), updated_at = now()
        FROM messages q
        WHERE a.id = ${answerId} AND a.role = 'assistant' AND a.status = 'streaming'
          AND q.id = a.question_id AND q.asked_by = ${askedBy}
        RETURNING pg_current_xact_id()::xid::text AS txid`
      : write.status === "done"
      ? yield* sql<{ readonly txid: string }>`
        UPDATE messages a SET status = 'done', text = ${write.text}, parts = COALESCE(${parts}::jsonb, a.parts),
          input_tokens = ${write.inputTokens ?? null}, output_tokens = ${write.outputTokens ?? null}, updated_at = now()
        FROM messages q
        WHERE a.id = ${answerId} AND a.role = 'assistant' AND a.status = 'streaming'
          AND q.id = a.question_id AND q.asked_by = ${askedBy}
        RETURNING pg_current_xact_id()::xid::text AS txid`
      : yield* sql<{ readonly txid: string }>`
        UPDATE messages a SET status = 'failed', failure = ${write.failure}, parts = COALESCE(${parts}::jsonb, a.parts),
          updated_at = now()
        FROM messages q
        WHERE a.id = ${answerId} AND a.role = 'assistant' AND a.status = 'streaming'
          AND q.id = a.question_id AND q.asked_by = ${askedBy}
        RETURNING pg_current_xact_id()::xid::text AS txid`
    return rows[0] === undefined ? undefined : Number(rows[0].txid)
  })

/** Whether a settled answer already holds what `write` settles it as: the same write, landed before. */
const landed = (
  row: { readonly status: string; readonly text: string; readonly failure: string | null },
  write: AnswerWrite,
) =>
  write.status === "done"
    ? row.status === "done" && row.text === write.text
    : write.status === "failed" && row.status === "failed" && row.failure === write.failure

/**
 * Reads `ANSWER_TURN_LIVE_SECONDS` and returns the answer routes' handler for one answer id: `GET` reads its turn,
 * `POST` writes it. Each request is a log line `chat.answer.turn` or `chat.answer.write`, a span
 * `chat.answer.request` and a count. `database` opens a Postgres client for the scope of each request.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const liveSeconds = yield* agentLiveSeconds

    /**
     * `GET /api/answers/<id>`: the question and its history, once every earlier live answer has settled. While it
     * waits, a request from the asker marks this answer live (`touch`) and says how long its turn has waited.
     */
    const turn = (answerId: string, actorId: string, fields: Fields) =>
      Effect.gen(function* () {
        const row = yield* target(answerId, liveSeconds)
        if (row === undefined) return refusal(404, "not_found")
        if (row.askedBy !== actorId) return notAsker(fields)
        if (row.status !== "streaming") return refusal(409, "settled")
        if (row.waiting) {
          yield* touch(answerId, liveSeconds)
          fields.waitedMs = row.waitedMs
          return HttpServerResponse.jsonUnsafe(
            { code: "not_your_turn", waitedMs: row.waitedMs },
            { status: 409, headers: { "cache-control": "no-store" } },
          )
        }
        fields.abandonedPredecessors = yield* abandonEarlier(answerId, liveSeconds)
        yield* touch(answerId, liveSeconds)
        const history = yield* Messages.history(answerId)
        fields.historyExchanges = history.length
        return ok({ question: row.question, history } satisfies Turn)
      })

    /** A confirmed engine lease pulse; never reads or changes content. */
    const heartbeat = (answerId: string, actorId: string, fields: Fields) => Effect.gen(function* () {
      const row = yield* target(answerId, liveSeconds)
      if (row === undefined) return refusal(404, "not_found")
      if (row.askedBy !== actorId) return notAsker(fields)
      if (row.status !== "streaming") {
        fields.renewed = false
        return HttpServerResponse.empty({ status: 204 })
      }
      fields.renewed = yield* touch(answerId, liveSeconds)
      return ok({})
    })

    /** Read and decode the bounded HTTP body before holding a conversation lock. */
    const prepareWrite = (request: HttpServerRequest.HttpServerRequest, fields: Fields) => Effect.gen(function* () {
      const body = yield* readBounded(request, MAX_ANSWER_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(Effect.result)
      if (body._tag === "Failure") return yield* Effect.fail(
        body.failure.reason === "too_large" ? refusal(413, "too_large") : refusal(400, "invalid"),
      )
      const decoded = yield* decodeWrite(body.success).pipe(Effect.option)
      if (Option.isNone(decoded)) return yield* Effect.fail(refusal(400, "invalid"))
      fields.write = decoded.value.status
      fields.parts = decoded.value.parts?.length ?? -1
      return decoded.value
    })

    /** Apply only prepared content, after acquiring the shared conversation lock. */
    const write = (decoded: AnswerWrite, answerId: string, actorId: string, fields: Fields) =>
      Effect.gen(function* () {
        // A settle folds into the feed in its own transaction (worker/Notifications.ts): the answer's status is its
        // run's.
        const settles = decoded.status !== "streaming"
        const txid = yield* (yield* SqlClient.SqlClient).withTransaction(
          Effect.tap(apply(answerId, actorId, decoded), (landed) =>
            landed !== undefined && settles ? Notifications.foldRun(answerId, undefined) : Effect.void),
        )
        if (txid !== undefined) return ok({ txid })
        const row = yield* target(answerId, liveSeconds)
        if (row === undefined) return refusal(404, "not_found")
        if (row.askedBy !== actorId) return notAsker(fields)
        if (landed(row, decoded)) {
          fields.existing = true
          return ok({ txid: null })
        }
        return refusal(409, "settled")
      })

    return (answerId: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const route = request.method === "GET" ? "turn" : request.method === "PATCH" ? "heartbeat" : "write"
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Fields = { answerId }
        const response = yield* Effect.gen(function* () {
          if (request.method !== "GET" && request.method !== "POST" && request.method !== "PATCH") {
            return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, POST, PATCH" } })
          }
          if (!Schema.is(Schema.String.check(Schema.isUUID()))(answerId)) return refusal(404, "not_found")
          const actor = yield* (yield* Sessions).resolve
          if (Option.isNone(actor)) return refusal(401, "authentication")
          // A run's credential writes only the answer its chain started from (decision 0017 slice 0).
          if (!boundTo(actor.value, answerId.toLowerCase())) return refusal(403, "other_run")
          // Only a Member or above on the conversation's repository who may edit its branch asks there, so writes its
          // answers (ruling AUTH-8): a Guest there, or a person with no role there, never.
          const asking = yield* askingOnAnswer(actor.value, answerId).pipe(Effect.provide(database))
          if (asking !== undefined && asking !== "ask") {
            fields.errorCode = asking
            return refusal(403, "forbidden")
          }
          // Only the asker, or an agent acting for them, writes their answer.
          const actorId = actor.value.subject.id
          if (route === "write") {
            const prepared = yield* prepareWrite(request, fields).pipe(Effect.result)
            if (prepared._tag === "Failure") return prepared.failure
            return yield* Messages.withAnswerConversation(answerId, write(prepared.success, answerId, actorId, fields))
              .pipe(Effect.provide(database))
          }
          const handled = route === "turn" ? turn(answerId, actorId, fields) : heartbeat(answerId, actorId, fields)
          return yield* Messages.withAnswerConversation(answerId, handled).pipe(Effect.provide(database))
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
        yield* Metric.update(Metric.withAttributes(requests, { route, status: String(response.status) }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          `chat.answer.${route}`,
        ).pipe(Effect.annotateLogs(fields))
        return response
      }).pipe(
        Effect.withSpan("chat.answer.request", { kind: "server", attributes: { "smithers.chat.answer_id": answerId } }),
      )
  })
