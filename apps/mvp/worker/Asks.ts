import { Cause, Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { MAX_OPTION_LENGTH, MAX_OPTIONS, MAX_PROMPT_LENGTH, MAX_RUN_BODY_BYTES } from "../src/features/status/contract.ts"
import { readBounded } from "#vibelang/emitted/worker/Body"
import { Directory } from "#vibelang/emitted/worker/branch/People"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import { FlowStarter } from "#vibelang/emitted/worker/Flows"
import { Ask, ASK_FLOW, askExecutionId, AskId } from "./flows/Ask.ts"
import { repositoryOf } from "#vibelang/emitted/worker/github/Config"
import { type Machine, machineOf, type MachineScope } from "./github/MachineWrite.ts"
import { rowIdOf } from "./RepoRuns.ts"

// An agent asks a person (decision 0031, docs/features/agent-status.md#addressed-waits). With a machine token holding
// `ask/create` on the repository, and no person behind it:
//
// - `POST /api/repos/<owner>/<name>/asks` `{ id, to, prompt, options? }`: `to` is the GitHub login of someone who has
//   signed in. Starts `queue/ask` once per repository and id (worker/flows/Ask.ts), whose run waits for that person's
//   answer: the same body again answers the same, another under the id is `409 conflict`. `202 { runId }`.
// - `GET /api/repos/<owner>/<name>/asks/<id>`: the ask's `{ status, answer?, answeredAt? }`, read from its run's row,
//   for the token's own agent and lane only; another lane's is `404`.
//
// Each request is a log line `queue.ask.request` or `queue.ask.read`, a span and a count. None carries the prompt, an
// option, the answer, the addressee's login or the token.

/** The scope a machine token needs to ask. */
export const ASK_SCOPE: MachineScope = "ask/create"

/** Asks requests, by `op` (`create`, `read`) and `outcome` (`started`, `read`, or the refusal's code). */
export const requests = Metric.counter("smithers_ask_requests", {
  description: "Requests to a repository's asks routes, by op and outcome",
  incremental: true,
})

const PATH = /^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/asks(?:\/([^/]+))?$/

/** `/api/repos/<owner>/<name>/asks[/<id>]` as its parts, or `undefined` for any other path. */
export const parseAsksPath = (path: string) => {
  const match = PATH.exec(path)
  return match === null ? undefined : { owner: match[1]!, name: match[2]!, id: match[3] }
}

/** Whether a path is one of the asks routes. */
export const handles = (path: string): boolean => parseAsksPath(path) !== undefined

/** What an agent asks: `to` is a GitHub login. */
export const AskBody = Schema.Struct({
  id: AskId,
  to: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)),
  prompt: Schema.Trim.check(Schema.isBetweenLength(1, MAX_PROMPT_LENGTH)),
  options: Schema.optional(
    Schema.Array(Schema.Trim.check(Schema.isBetweenLength(1, MAX_OPTION_LENGTH))).check(Schema.isMaxLength(MAX_OPTIONS)),
  ),
})

const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(AskBody))
const isAskId = Schema.is(AskId)

const noStore = { "cache-control": "no-store" }

type Fields = Record<string, string | number>

/** Who asks: the token's pair. */
const askerOf = (machine: Machine) => `machine:${machine.agent}/${machine.lane}`

/** An ask's state, read from its run's row: open until answered; closed when it ended without an answer. */
const askOf = (rowId: string, asker: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly status: string
      readonly answer: { readonly value: string } | null
      readonly answeredAt: string | null
    }>`
      SELECT status, answer, to_char(answered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "answeredAt"
      FROM runs WHERE id = ${rowId}::uuid AND flow = ${ASK_FLOW} AND launched_by = ${asker}`
    return Option.map(Option.fromNullishOr(row), (found) =>
      found.answer !== null
        ? { status: "answered" as const, answer: found.answer.value, answeredAt: found.answeredAt! }
        : found.status === "needs_you"
        ? { status: "open" as const }
        : { status: "closed" as const })
  })

/**
 * The asks routes over `database`. Starting a run needs `FlowStarter`; finding the person a login names, `Directory`:
 * the people who have signed in to this deployment.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const route = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const startedAt = yield* Clock.currentTimeMillis
    const target = parseAsksPath(request.url.split("?")[0]!)!
    const op = target.id === undefined ? "create" : "read"
    const repo = repositoryOf(`${target.owner}/${target.name}`)
    /** `<owner>/<name>`, lower case: what an ask's execution id and payload name. */
    const full = `${repo.owner}/${repo.name}`.toLowerCase()
    const fields: Fields = { op, repoId: repo.id }
    const refuse = (status: number, code: string) => {
      fields.outcome = code
      return HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
    }
    const response = yield* Effect.gen(function* () {
      const method = op === "create" ? "POST" : "GET"
      if (request.method !== method) {
        fields.outcome = "method"
        return HttpServerResponse.empty({ status: 405, headers: { allow: method, ...noStore } })
      }
      const machine = yield* machineOf(request, repo.id).pipe(Effect.provide(database))
      if (Option.isNone(machine)) return refuse(401, "authentication")
      fields.agent = machine.value.agent
      fields.lane = machine.value.lane
      if (!machine.value.scope.includes(ASK_SCOPE)) return refuse(403, "forbidden")
      const asker = askerOf(machine.value)
      if (target.id !== undefined) {
        if (!isAskId(target.id)) return refuse(404, "not_found")
        fields.askId = target.id
        const found = yield* askOf(yield* rowIdOf(askExecutionId(full, target.id)), asker).pipe(Effect.provide(database))
        if (Option.isNone(found)) return refuse(404, "not_found")
        fields.outcome = found.value.status
        return HttpServerResponse.jsonUnsafe(found.value, { status: 200, headers: noStore })
      }
      const body = yield* readBounded(request, MAX_RUN_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(Effect.result)
      if (body._tag === "Failure") {
        return body.failure.reason === "too_large" ? refuse(413, "too_large") : refuse(400, "invalid")
      }
      // A decoding failure would quote the body: it is dropped whole.
      const decoded = yield* decodeBody(body.success).pipe(Effect.option)
      if (Option.isNone(decoded)) return refuse(400, "invalid")
      const ask = decoded.value
      fields.askId = ask.id
      const person = yield* (yield* Directory).find(ask.to)
      if (Option.isNone(person)) return refuse(422, "unknown_person")
      const executionId = askExecutionId(full, ask.id)
      const started = yield* (yield* FlowStarter).start(Ask, {
        executionId,
        payload: {
          repo: full,
          id: ask.id,
          to: person.value.id,
          askedBy: asker,
          prompt: ask.prompt,
          ...(ask.options === undefined ? {} : { options: ask.options }),
        },
      }).pipe(Effect.result)
      if (started._tag === "Failure") {
        if (started.failure._tag === "@smthrs/mvp/flows/StartConflict") return refuse(409, "conflict")
        fields.errorCode = started.failure.errorCode
        return refuse(503, "unavailable")
      }
      fields.outcome = "started"
      return HttpServerResponse.jsonUnsafe({ runId: yield* rowIdOf(executionId) }, { status: 202, headers: noStore })
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
    const outcome = String(fields.outcome)
    yield* Metric.update(Metric.withAttributes(requests, { op, outcome }), 1)
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, op, outcome })
    yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
      op === "create" ? "queue.ask.request" : "queue.ask.read",
    ).pipe(Effect.annotateLogs(fields))
    return response
  })

  return { fetch: route.pipe(Effect.withSpan("queue.ask.request", { kind: "server" })) }
}
