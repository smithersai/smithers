import { forgeOf, namespaceOf } from "./Conversations.ts"
import { Cause, Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import {
  callExecutionId,
  COMMAND_LIMIT_SECONDS,
  MAX_CALL_BODY_BYTES,
  SANDBOX_CALLS_ROUTE,
} from "../../src/features/sandbox/contract.ts"
import type { Actor } from "../Actor.ts"
import { boundTo, canAsk, Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Flows from "../Flows.ts"
import { SandboxCall } from "../flows/SandboxCall.ts"
import { ToolCall } from "../flows/SandboxCommand.ts"
import { branchAccess, canEdit } from "./Access.ts"

// The sandbox tools' routes (decision 0005 §5, docs/features/sandbox-tools.md#the-routes):
//
// - `POST /api/sandbox/calls { callId, call, conversationId? | answerId? }`: the write path of every sandbox tool's client
//   flow, whoever runs it: a person's slash command names the conversation their tab showed, and the agent's call
//   names the answer it works on, whose conversation it stays in. It admits the call for the person signed in (they
//   asked the answer, may edit the conversation's branch, and the branch isn't locked), records the `running` row,
//   and starts the remote `sandbox/Call`, one execution per call. The same call again is answered as it stands. A
//   command runs up to the deployment's `SANDBOX_COMMAND_MAX_SECONDS` (an hour unless set); one past it is refused
//   `too_long` with that limit (`maxSeconds`), which the agent reads.
// - `GET /api/sandbox/calls/<id>`: how the call stands: `running`, `done` with the tool's result, or `failed` with why.
//   Only the person who asked reads it.
//
// The agent acts for the person who asked and never above them: every call checks that person's role and the branch's
// sharing now (worker/branch/Access.ts). Nothing here logs a command, a path, a file's content or output.

/** Sandbox call route requests, by `route` (`call`, `result`) and `outcome`. */
export const requests = Metric.counter("smithers_sandbox_call_requests", {
  description: "Requests to the sandbox call routes, by route and outcome",
  incremental: true,
})

const Uuid = Schema.String.check(Schema.isUUID())
/** A call's request decoded against the command job's own limit, before deployment admission. */
const callRequest = Schema.Struct({
  callId: Uuid,
  call: ToolCall(COMMAND_LIMIT_SECONDS),
  conversationId: Schema.optional(Uuid),
  answerId: Schema.optional(Uuid),
})
const isUuid = Schema.is(Uuid)

const noStore = { "cache-control": "no-store" }
const refusal = (status: number, code: string) => HttpServerResponse.jsonUnsafe({ code, ...(code === "members_only" ? { message: "Members can run machines." } : {}) }, { status, headers: noStore })

type Fields = Record<string, string | number | boolean>

/** A repository id's owner and name: `github/<owner>/<name>`. */
const partsOf = (repoId: string) => {
  const [, owner = "", name = ""] = repoId.split("/")
  return { owner, name }
}

/** A call's row as the routes read it. */
interface CallRow {
  readonly branchId: string
  readonly personId: string
  readonly tool: string
  readonly status: "running" | "done" | "failed"
  readonly failure: string | null
  readonly result: unknown
}

const rowOf = (callId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<CallRow>`
      SELECT branch_id AS "branchId", person_id AS "personId", tool, status, failure, result
      FROM sandbox_calls WHERE id = ${callId}`).pipe(Effect.map((rows) => rows[0]))

/** How a call stands, as the client reads it. The driver parses `result`, a `jsonb` column. */
const standing = (row: CallRow) =>
  row.status === "done"
    ? { status: "done" as const, result: row.result }
    : row.status === "failed"
    ? { status: "failed" as const, failure: row.failure }
    : { status: "running" as const }

/**
 * The conversation an agent's call works in: its answer's, when `actor` asked that answer's question. `forbidden` when
 * someone else asked it; nothing when there is no such answer.
 */
export const answerConversation = (answerId: string, actor: Actor) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly conversationId: string; readonly askedBy: string | null }>`
      SELECT a.conversation_id AS "conversationId", q.asked_by AS "askedBy"
      FROM messages a JOIN messages q ON q.id = a.question_id
      WHERE a.id = ${answerId} AND a.role = 'assistant'`
    if (row === undefined) return undefined
    return row.askedBy === actor.subject.id ? row.conversationId : ("forbidden" as const)
  })

/**
 * Reads the routes over `database`, which opens a Postgres client for each request's scope, admitting commands of up to
 * `commandSeconds` (`SANDBOX_COMMAND_MAX_SECONDS`). They read who is asking from `Sessions` and start `sandbox/Call`
 * through `Flows.FlowStarter`.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, commandSeconds: number) => {
  const decodeCall = Schema.decodeUnknownEffect(Schema.fromJsonString(callRequest))
  /** One request's records: a log line `sandbox.<route>`, its span's status, and a count. */
  const recorded = <RR>(
    route: "call" | "result",
    run: (fields: Fields) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, RR>,
  ) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const fields: Fields = {}
      const response = yield* run(fields)
      fields.status = response.status
      fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
      const outcome = String(fields.outcome ?? fields.code ?? "refused")
      yield* Metric.update(Metric.withAttributes(requests, { route, outcome }), 1)
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, outcome })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
        `sandbox.${route}`,
      ).pipe(Effect.annotateLogs({ ...fields, outcome }))
      return response
    }).pipe(Effect.withSpan(`sandbox.${route}`, { kind: "server" }))

  const refuse = (fields: Fields, status: number, code: string) => {
    fields.code = code
    return refusal(status, code)
  }

  const failed = (fields: Fields) => (cause: Cause.Cause<unknown>) =>
    Effect.sync(() => {
      fields.errorCode = codeOf(Cause.squash(cause))
      return refuse(fields, 503, "unavailable")
    })

  /** `POST /api/sandbox/calls`. */
  const call = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const sessions = yield* Sessions
    const starter = yield* Flows.FlowStarter
    return yield* recorded("call", (fields) =>
      Effect.gen(function* () {
        if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
        const actor = yield* sessions.resolve.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
        if (Option.isNone(actor)) return refuse(fields, 401, "authentication")
        const body = yield* readBounded(request, MAX_CALL_BODY_BYTES).pipe(Effect.result)
        if (body._tag === "Failure") return refuse(fields, body.failure.reason === "too_large" ? 413 : 400, "invalid")
        const decoded = yield* decodeCall(body.success).pipe(Effect.option)
        if (Option.isNone(decoded)) return refuse(fields, 400, "invalid")
        const { answerId, call } = decoded.value
        const callId = decoded.value.callId.toLowerCase()
        fields.callId = callId
        fields.tool = call.tool
        // Who calls is the request's to say (decision 0017 slice 0): the person, or the run its credential names, which
        // targets only the answer its chain started from.
        fields.door = actor.value.act?.kind ?? "person"
        if ((answerId === undefined) === (decoded.value.conversationId === undefined)) return refuse(fields, 400, "invalid")
        if (answerId !== undefined && !boundTo(actor.value, answerId)) return refuse(fields, 403, "other_run")
        const conversationId = answerId === undefined
          ? decoded.value.conversationId!.toLowerCase()
          : yield* answerConversation(answerId.toLowerCase(), actor.value).pipe(Effect.provide(database))
        if (conversationId === "forbidden") return refuse(fields, 403, "forbidden")
        if (conversationId === undefined) return refuse(fields, 404, "not_found")
        const branch = yield* branchAccess(actor, conversationId, "conversation").pipe(Effect.provide(database))
        if (branch === undefined) return refuse(fields, 404, "not_found")
        fields.branchId = branch.branchId
        if (!canEdit(branch.access)) return refuse(fields, 403, "forbidden")
        if (!canAsk(actor.value)) return refuse(fields, 403, "members_only")
        if (branch.mode === "locked") return refuse(fields, 409, "locked")
        if (call.tool === "run" && (call.timeoutSeconds ?? 60) > commandSeconds) {
          fields.code = "too_long"
          return HttpServerResponse.jsonUnsafe(
            { code: "too_long", maxSeconds: commandSeconds },
            { status: 400, headers: noStore },
          )
        }
        const ownerId = actor.value.subject.id
        const inserted = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`
            INSERT INTO sandbox_calls (id, branch_id, person_id, answer_id, tool)
            VALUES (${callId}, ${branch.branchId}, ${ownerId}, ${answerId?.toLowerCase() ?? null}, ${call.tool})
            ON CONFLICT (id) DO NOTHING RETURNING id`).pipe(Effect.provide(database))
        const row = yield* rowOf(callId).pipe(Effect.provide(database))
        if (row === undefined || row.personId !== ownerId || row.branchId !== branch.branchId || row.tool !== call.tool) {
          return refuse(fields, 409, "id_taken")
        }
        if (row.status === "running") {
          const { owner, name } = partsOf(branch.repoId)
          const namespace = yield* namespaceOf(branch.branchId).pipe(Effect.provide(database))
          const forge = yield* forgeOf(branch.branchId).pipe(Effect.provide(database))
          // A resend starts the same execution, a no-op, so a call whose first start was lost still gets one.
          const started = yield* starter.start(SandboxCall, {
            executionId: callExecutionId(callId),
            payload: { callId, ownerId, branch: { branchId: branch.branchId, owner, name, branch: branch.name, ...(namespace === "ephemeral" ? { namespace } : {}), ...(forge === undefined ? {} : { forge }) }, call },
          }).pipe(Effect.result)
          if (started._tag === "Failure") {
            fields.errorCode = started.failure._tag
            return refuse(fields, started.failure._tag === "@smthrs/mvp/flows/StartConflict" ? 409 : 503, "unavailable")
          }
        }
        fields.outcome = inserted.length > 0 ? "running" : "existing"
        return HttpServerResponse.jsonUnsafe(
          { callId, ...standing(row) },
          { status: inserted.length > 0 ? 202 : 200, headers: noStore },
        )
      }).pipe(Effect.catchCause(failed(fields))))
  })

  /** `GET /api/sandbox/calls/<id>`. */
  const result = (callId: string) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const sessions = yield* Sessions
      return yield* recorded("result", (fields) =>
        Effect.gen(function* () {
          if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
          if (!isUuid(callId)) return refuse(fields, 404, "not_found")
          fields.callId = callId.toLowerCase()
          const actor = yield* sessions.resolve.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
          if (Option.isNone(actor)) return refuse(fields, 401, "authentication")
          const row = yield* rowOf(callId.toLowerCase()).pipe(Effect.provide(database))
          // Someone else's call is not found: its existence is theirs.
          if (row === undefined || row.personId !== actor.value.subject.id) return refuse(fields, 404, "not_found")
          fields.tool = row.tool
          fields.outcome = row.status
          return HttpServerResponse.jsonUnsafe({ callId: callId.toLowerCase(), ...standing(row) }, { headers: noStore })
        }).pipe(Effect.catchCause(failed(fields))))
    })

  const fetch = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = request.url.split("?")[0]!
    if (path === SANDBOX_CALLS_ROUTE) return yield* call
    return yield* result(path.slice(SANDBOX_CALLS_ROUTE.length + 1))
  })

  return { fetch }
}

/** Whether a path is one of these routes. */
export const handles = (path: string): boolean =>
  path === SANDBOX_CALLS_ROUTE || path.startsWith(`${SANDBOX_CALLS_ROUTE}/`)
