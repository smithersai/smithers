import { ShapeProxy } from "@smthrs/effect-electric"
import { Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../src/features/chat/contract.ts"
import { PIN_ROUTE, PINS_SHAPE_ROUTE, PINS_TABLE } from "../src/features/pins/contract.ts"
import { boundTo, Sessions } from "./Actor.vibe"
import { branchAccess, canView } from "./branch/Access.ts"
import * as Conversations from "./branch/Conversations.ts"
import { answerConversation } from "./branch/SandboxCalls.ts"
import { readBounded } from "./Body.vibe"
import * as ShapeAccess from "./ShapeAccess.vibe"

const Id = Schema.String.check(Schema.isUUID())
const Request = Schema.Struct({
  conversationId: Schema.optional(Id), answerId: Schema.optional(Id),
  messageId: Schema.optional(Schema.NullOr(Id)), at: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  awaitAdmission: Schema.optional(Schema.Boolean),
  questionAnswerId: Schema.optional(Id),
})
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Request))
const headers = { "cache-control": "no-store" }
const refuse = (status: number) => HttpServerResponse.jsonUnsafe({ code: status === 503 ? "unavailable" : "refused" }, { status, headers })
export const writes = Metric.counter("smithers_message_pins", { incremental: true })
export const shapes = Metric.counter("smithers_pin_shape_requests", { incremental: true })

/** Authenticated personal state: shape filters and ownership always come from the session. */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => Effect.gen(function* () {
  const config = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })
  const shape = ShapeProxy.make({ ...config, name: "chat.pins.shape", metric: shapes,
    shape: Effect.map(ShapeAccess.actor, actor => ({ table: PINS_TABLE, where: "person_id = $1",
      params: { "1": Option.isSome(actor) ? actor.value.subject.id : "" },
      columns: ["conversation_id", "person_id", "message_id", "changed_at"],
    })),
  })
  const write = Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const response = yield* Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
      const stamping = request.url.split("?")[0] === `${PIN_ROUTE}/stamp`
      const actor = yield* (yield* Sessions).resolve
      if (Option.isNone(actor)) return refuse(401)
      const body = yield* readBounded(request, 512, () => {}).pipe(Effect.result)
      if (body._tag === "Failure") return refuse(body.failure.reason === "too_large" ? 413 : 400)
      const parsed = yield* decode(body.success).pipe(Effect.option)
      if (Option.isNone(parsed) || (parsed.value.at !== undefined && parsed.value.at > started + 86_400_000) || (!stamping && Option.isSome(parsed) && parsed.value.at === undefined)) return refuse(400)
      const p = parsed.value
      if (p.answerId !== undefined && !boundTo(actor.value, p.answerId)) return refuse(403)
      const root = actor.value.act?.root ?? actor.value.act?.id.split("/")[0]
      const credentialAnswer = root !== undefined && /^[0-9a-f-]{36}$/i.test(root) ? root : undefined
      const answerId = credentialAnswer ?? p.answerId
      if (actor.value.act?.kind === "agent" && answerId === undefined) return refuse(403)
      const bound = answerId === undefined ? undefined : yield* answerConversation(answerId.toLowerCase(), actor.value).pipe(Effect.provide(database))
      if (bound === "forbidden") return refuse(403)
      if (answerId !== undefined && bound === undefined) return refuse(404)
      // A run may only select messages in its own answer's conversation, even with an explicit payload.
      if (bound !== undefined && p.conversationId !== undefined && p.conversationId.toLowerCase() !== bound) return refuse(403)
      const conversationId = bound ?? p.conversationId?.toLowerCase() ?? (yield* Conversations.home.pipe(Effect.provide(database)))
      if (conversationId === undefined) return refuse(404)
      const access = yield* branchAccess(actor, conversationId, "conversation").pipe(Effect.provide(database))
      if (access === undefined) return refuse(404)
      if (!canView(access.access)) return refuse(403)
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        if (stamping) {
          const [row] = yield* sql<{ readonly at: number }>`SELECT (extract(epoch from changed_at) * 1000)::float8 AS at FROM message_pins
            WHERE conversation_id = ${conversationId} AND person_id = ${actor.value.subject.id}`
          return HttpServerResponse.jsonUnsafe({ ...p, conversationId, at: Math.max(started, row === undefined ? 0 : row.at + 1) }, { headers })
        }
        let messageId = p.messageId?.toLowerCase() ?? p.messageId
        if (messageId === undefined) {
          // Resolve once relative to the invoking answer, never to its new "Pinned" acknowledgement.
          const [row] = yield* sql<{ readonly id: string }>`SELECT id FROM messages
            WHERE conversation_id = ${conversationId} AND role = 'assistant' AND status = 'done'
              AND (${answerId ?? null}::uuid IS NULL OR position < (SELECT position FROM messages WHERE id = ${answerId ?? null}))
            ORDER BY position DESC LIMIT 1`
          if (row === undefined) return refuse(404)
          messageId = row.id
        } else if (messageId !== null) {
          if (p.awaitAdmission === true) {
            const [current] = yield* sql<{ readonly message_id: string | null }>`SELECT message_id FROM message_pins
              WHERE conversation_id = ${conversationId} AND person_id = ${actor.value.subject.id} AND changed_at >= ${new Date(p.at!)}`
            if (current !== undefined) return HttpServerResponse.jsonUnsafe({ messageId: current.message_id, conversationId }, { headers })
          }
          const [row] = yield* sql`SELECT id FROM messages WHERE id = ${messageId} AND conversation_id = ${conversationId}
            AND (${p.questionAnswerId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM messages a WHERE a.question_id = ${messageId} AND a.id = ${p.questionAnswerId ?? null}))`
          if (row === undefined) return refuse(p.awaitAdmission === true ? 425 : 404)
        }
        yield* sql`INSERT INTO message_pins (conversation_id, person_id, message_id, changed_at)
          VALUES (${conversationId}, ${actor.value.subject.id}, ${messageId}, ${new Date(p.at!)})
          ON CONFLICT (conversation_id, person_id) DO UPDATE SET message_id = EXCLUDED.message_id, changed_at = EXCLUDED.changed_at
          WHERE message_pins.changed_at < EXCLUDED.changed_at`
        return HttpServerResponse.jsonUnsafe({ messageId, conversationId }, { headers })
      }).pipe(Effect.provide(database))
    }).pipe(Effect.catchCause(() => Effect.succeed(refuse(503))))
    const outcome = response.status === 200 ? "saved" : "refused"
    yield* Metric.update(Metric.withAttributes(writes, { outcome }), 1)
    yield* Effect.annotateCurrentSpan({ status: response.status, outcome })
    yield* Effect.logInfo("chat.pin").pipe(Effect.annotateLogs({ status: response.status, outcome, durationMs: (yield* Clock.currentTimeMillis) - started }))
    return response
  }).pipe(Effect.withSpan("chat.pin", { kind: "server" }))
  return { write, shape }
})
