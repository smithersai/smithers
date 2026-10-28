import * as Pins from "./Pins.ts"
import * as TimelineSummaries from "./TimelineSummaries.ts"
import { PIN_ROUTE, PINS_SHAPE_ROUTE } from "../src/features/pins/contract.ts"
import { ShapeProxy } from "@smthrs/effect-electric"
import { OtlpRelay } from "@smthrs/observability"
import { Interactions, type PresentationRealm } from "@smthrs/views"
import { Clock, Data, Effect, type Layer, Metric, Option, Schema, Tracer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { type SqlClient, SqlError } from "effect/sql"
import {
  LOCAL_ELECTRIC_URL,
  MAX_QUESTION_LENGTH,
  MESSAGES_TABLE,
  QUESTIONS_ROUTE,
  SHAPE_ROUTE,
  TELEMETRY_ROUTE,
} from "../src/features/chat/contract.ts"
import { ANSWERS_ROUTE } from "../src/features/agent/contract.ts"
import { MODEL_ROLES, MODEL_ROUTE, type ModelRole } from "../src/features/model/contract.ts"
import { VIEWS_ROUTE, VIEWS_SHAPE_ROUTE } from "../src/features/views/contract.ts"
import { FormValues } from "../src/features/views/schema.ts"
import { WEB_PREVIEW_ROUTE } from "../src/features/web/contract.ts"
import { RUNS_ROUTE, RUNS_SHAPE_ROUTE } from "../src/features/status/contract.ts"
import { ACK_ROUTE, NOTIFICATIONS_SHAPE_ROUTE, WATCHES_ROUTE } from "../src/features/attention/contract.ts"
import {
  ALERT_CHANNELS_ROUTE,
  ALERT_CHANNELS_SHAPE_ROUTE,
  SANDBOX_LIMITS_ROUTE,
  SANDBOX_LIMITS_SHAPE_ROUTE,
  ALERT_DELIVERIES_SHAPE_ROUTE,
  SPEND_ALERTS_SHAPE_ROUTE,
} from "../src/features/spend/contract.ts"
import {
  FLOW_DRAFTS_ROUTE,
  FLOW_DRAFTS_SHAPE_ROUTE,
  FLOWS_ROUTE,
  FLOWS_SHAPE_ROUTE,
} from "../src/features/flows-ui/contract.ts"
import { BROWSER_TELEMETRY, TELEMETRY_LIMITS } from "../src/telemetry.ts"
import { type Actor, refusesPersonOnly, Sessions } from "./Actor.ts"
import * as Answers from "./Answers.ts"
import { askingOf, branchAccess, canView } from "./branch/Access.ts"
import * as ConversationPeople from "./branch/ConversationPeople.ts"
import * as Conversations from "./branch/Conversations.ts"
import { readBounded } from "./Body.ts"
import * as ChatMetrics from "./ChatMetrics.ts"
import { codeOf } from "./ErrorCode.ts"
import * as Flows from "./Flows.ts"
import * as Expire from "./flows/Expire.ts"
import * as Messages from "./Messages.ts"
import * as ModelEndpoint from "./ModelEndpoint.ts"
import * as Notifications from "./Notifications.ts"
import * as PersonalFlows from "./PersonalFlows.ts"
import * as Runs from "./Runs.ts"
import * as ShapeAccess from "./ShapeAccess.ts"
import * as AlertChannels from "./AlertChannels.ts"
import * as BudgetApi from "./branch/BudgetApi.ts"
import * as SpendAlerts from "./SpendAlerts.ts"
import * as Views from "./Views.ts"
import * as WebPreview from "./WebPreview.ts"

// ChatApi's routes (docs/features/chat.md#contract). ChatApi.ts runs them on Cloudflare; the tests run them as they
// are. ChatApi only stores a question and its empty `streaming` answer: the browser's agent answers it, through the
// model endpoint and the answer routes (docs/features/agent.md).

/** The largest `POST /api/questions` body: 64 KiB. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * The `messages` columns every device syncs: all of them but `asked_by`, the asker's person id, which only the answer
 * routes read (worker/Answers.ts). A column a migration adds stays on the server until it is listed here.
 * `conversation_id` names the branch's conversation each row belongs to (decision 0013 §1).
 */
export const SYNCED_MESSAGE_COLUMNS = [
  "id",
  "conversation_id",
  "role",
  "text",
  "status",
  "question_id",
  "failure",
  "model_id",
  "stop_reason",
  "input_tokens",
  "output_tokens",
  "position",
  "created_at",
  "updated_at",
  "parts",
  // An answer's one-line summary, made once for every device (worker/TimelineSummaries.ts).
  "summary",
  "summary_revision",
]

/**
 * A W3C `traceparent` of version `00` as the spec writes it: 55 characters of lowercase hex, neither id all zeros.
 * Anything else, a `b3` header included, parents nothing.
 */
const TRACEPARENT = /^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-[0-9a-f]{2}$/

/**
 * The span a request's `traceparent` names, so ChatApi's spans join the browser's trace. The browser picks the ids
 * but not whether ChatApi records the request: its sampled flag is ignored.
 */
const parentOf = (header: string | undefined) =>
  header !== undefined && header.length === 55 && TRACEPARENT.test(header)
    ? Tracer.externalSpan({ traceId: header.slice(3, 35), spanId: header.slice(36, 52), sampled: true })
    : undefined

const Question = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  answerId: Schema.String.check(Schema.isUUID()),
  // The branch's conversation (decision 0013 §1). For one release, a question without one belongs to the home
  // conversation, so an ask queued by the build before branches still lands.
  conversationId: Schema.optional(Schema.String.check(Schema.isUUID())),
  text: Schema.Trim.check(Schema.isBetweenLength(1, MAX_QUESTION_LENGTH)),
  // A question sent from a view (docs/features/views.md): the view and its event, and the values sent with it.
  source: Schema.optional(Schema.Struct({ viewId: Schema.String.check(Schema.isUUID()), event: Interactions.Name })),
  data: Schema.optional(FormValues),
}).check(Schema.makeFilter((question) => question.id.toLowerCase() !== question.answerId.toLowerCase()))

const decodeQuestion = Schema.decodeUnknownEffect(Schema.fromJsonString(Question))

/** What the person reads when ChatApi won't take a question sent from a view, by code. */
const refusedSource: Readonly<Record<string, string>> = {
  view_not_found: "That form or view isn't in this conversation.",
  undeclared: "That view doesn't send this.",
  invalid_values: "Those values don't fit the form.",
  submitted: "This form was already sent.",
}

const invalid = `Send JSON { id, answerId, conversationId, text }: two different UUIDs, a conversation's id and 1 to ${
  MAX_QUESTION_LENGTH.toLocaleString("en-US")
} characters of text.`

/**
 * A request answered with an error `status` and `errorCode` in its log line, and `{ message: explanation }` when there
 * is one, shown as written.
 */
class Refusal extends Data.TaggedError("Refusal")<{
  readonly status: number
  readonly errorCode: string
  readonly explanation?: string
}> {}

/**
 * Reads the configuration (`ShapeProxy.config`, `ModelEndpoint.make`, with `spendAlerts` as `MODEL_SPEND_ALERTS`'
 * default, `Answers.make`, `Views.make` and `WebPreview.make`, with `localHttp` as `WEB_PAGES_LOCAL_HTTP`'s default) and
 * returns ChatApi's `fetch` handler, which checks pages through the host's `HttpClient` and keeps their answers in its
 * `ImmutableCache`. `database` opens a Postgres client for the scope that builds it: one per request. `fetch` reads who is
 * asking from `Sessions`, and starts each answer's `chat/Expire` through `Flows.FlowStarter`.
 */
export const make = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  options: {
    readonly localHttp?: boolean
    readonly spendAlerts?: boolean
    /** `HOSTED_MODEL_ENABLED`'s default: on only under `alchemy dev` (decision 0099). */
    readonly hostedModel?: boolean
    /** The realm generated views render in (worker/ViewRealm.ts): `load` on Cloudflare, `loadNode` in the tests. */
    readonly realm: Effect.Effect<PresentationRealm.Realm, PresentationRealm.RealmError>
  },
) =>
  Effect.gen(function* () {
    // POST /api/model/<role>: the metered model endpoint (docs/features/model-endpoint.md), which starts the spend
    // alerts (docs/features/spend-alerts.md).
    const model = yield* ModelEndpoint.make(database, {
      ...(options.spendAlerts === undefined ? {} : { alerts: options.spendAlerts }),
      ...(options.hostedModel === undefined ? {} : { hosted: options.hostedModel }),
    })
    // GET and POST /api/answers/<id>: the write path for the browser's agent (docs/features/agent.md).
    const answers = yield* Answers.make(database)
    const pins = yield* Pins.make(database)
    // POST /api/timeline/summaries: an answer's one summary, claimed once and recorded on the message (docs/features/timeline.md#cost).
    const timelineSummaries = yield* TimelineSummaries.make(database)
    // POST /api/views and GET /api/shapes/views: the conversation's views (docs/features/web-pages.md).
    const views = yield* Views.make(database, options)
    // POST /api/web/preview: a page checked before it is framed (docs/features/web-pages.md#before-a-page-is-framed).
    const webPreview = yield* WebPreview.make(options)
    // POST /api/runs/<id>[/answer] and GET /api/shapes/runs: agent status (docs/features/agent-status.md).
    const runs = yield* Runs.make(database)
    // POST /api/watches, POST /api/notifications/ack and GET /api/shapes/notifications: the personal feed
    // (docs/features/notifications.md).
    const notifications = yield* Notifications.make(database)
    // GET /api/shapes/spend-alerts: the model spend alerts, for Admins (docs/features/spend-alerts.md).
    const spendAlerts = yield* SpendAlerts.make
    // POST /api/alert-channels and the channels' and receipts' shapes: where Admins send spend alerts outside the app
    // (docs/features/spend-alerts.md#channels).
    const alertChannels = yield* AlertChannels.make(database)
    // POST /api/sandbox-limits and its shape: the sandbox limits Admins set (docs/features/sandbox-budgets.md#the-limits).
    const sandboxLimits = yield* BudgetApi.make(database)
    // /api/flows, /api/flow-drafts and their shapes: a person's own flows (docs/features/flows.md#your-own-flows).
    const personalFlows = yield* PersonalFlows.make(database)
    // GET /api/shapes/messages?conversation=<id>: one conversation's `messages` (decision 0013 §1), which the browser
    // pages by `position` a window at a time. The server fixes the table, the columns and the `where`; the browser
    // names only the conversation. Anyone who may not watch the branch gets a shape with no rows; a request the server
    // can't decide, because sessions or the home conversation can't be read, is 503 (worker/ShapeAccess.ts).
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })
    const shape = ShapeProxy.make({
      ...connection,
      shape: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const named = new URL(request.url, "http://localhost").searchParams.get("conversation")
        const conversation = named !== null && isUuid(named)
          ? named.toLowerCase()
          : named === null
          ? yield* Conversations.home.pipe(Effect.provide(database), Effect.mapError(() => ShapeAccess.unavailable))
          : undefined
        const actor = yield* ShapeAccess.actor
        // Only someone who may view the conversation's branch gets its rows (worker/branch/Access.ts). Losing the
        // branch while synced swaps the `where` under the device's handle: Electric answers it `409 must-refetch`, and
        // the device's copy empties.
        const found = conversation === undefined
          ? undefined
          : yield* branchAccess(actor, conversation, "conversation").pipe(
            Effect.provide(database),
            Effect.mapError(() => ShapeAccess.unavailable),
          )
        const watched = found !== undefined && canView(found.access) ? found.conversationId : NO_CONVERSATION
        return {
          table: MESSAGES_TABLE,
          columns: SYNCED_MESSAGE_COLUMNS,
          where: "conversation_id = $1",
          params: { "1": watched },
        }
      }),
      name: "chat.shape",
      metric: ChatMetrics.shapes,
    })
    const telemetry = OtlpRelay.serve({
      // The browser's exporters split their batches under the same limits (src/telemetry.ts).
      maxBodyBytes: TELEMETRY_LIMITS.maxRequestBytes,
      maxRecords: TELEMETRY_LIMITS.maxRecords,
      // Exactly the records and fields the browser's features declare (src/telemetry.ts); the rest is dropped.
      allow: BROWSER_TELEMETRY,
    })

    const questions = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const startedAt = yield* Clock.currentTimeMillis
      const fields: Record<string, string | number | boolean> = {}
      const response = yield* Effect.gen(function* () {
        if (request.method !== "POST") return yield* new Refusal({ status: 405, errorCode: "method" })
        const asker = yield* signedIn
        // Asking starts the agent's run, and the agent never asks itself (decision 0017 slice 0).
        if (yield* refusesPersonOnly(asker, "chat/Answer")) {
          return yield* new Refusal({ status: 403, errorCode: "person_only", explanation: "Only the person asks." })
        }
        const body = yield* readBody(request, fields)
        const decoded = yield* decodeQuestion(body).pipe(
          Effect.mapError(() => new Refusal({ status: 400, errorCode: "invalid", explanation: invalid })),
        )
        // Lowercase, as Postgres prints a uuid: one answer has one id in rows, logs and the browser's agent.
        // The asker is the session's person, never the body's: only they may write the answer (worker/Answers.ts).
        const conversationId = yield* conversationOf(decoded.conversationId, asker, fields)
        const question = {
          id: decoded.id.toLowerCase(),
          answerId: decoded.answerId.toLowerCase(),
          conversationId,
          text: decoded.text,
          askedBy: asker.subject.id,
        }
        fields.questionId = question.id
        // Asked from a view: logged as that alone, never by the view's event, which a module names.
        if (decoded.source !== undefined) fields.source = "view"
        fields.answerId = question.answerId
        fields.conversationId = conversationId
        yield* Effect.annotateCurrentSpan({
          "smithers.chat.question_id": question.id,
          "smithers.chat.answer_id": question.answerId,
        })
        // The ask is acknowledged only once its expiry is admitted, so no answer is left with neither a device nor a
        // server to settle it. A start the host refuses is a 503, which the outbox sends again: the resend finds the
        // question stored and starts the same execution, a no-op once one started. The write and the start run as one
        // uninterruptible unit, so a caller that goes away between them can't leave a stored ask without its expiry.
        const asked = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const asked = yield* (decoded.source === undefined
              ? Messages.ask(question)
              : Views.askFrom(
                question,
                { viewId: decoded.source.viewId.toLowerCase(), event: decoded.source.event },
                decoded.data,
              )).pipe(
                Effect.provide(database),
                Effect.mapError((error) =>
                  error instanceof Views.SourceRefused
                    ? new Refusal({ status: error.status, errorCode: error.code, explanation: refusedSource[error.code] })
                    : refuseStore(error)
                ),
              )
            yield* ConversationPeople.asked(conversationId, asker.subject.id).pipe(
              Effect.provide(database),
              Effect.catchCause(() => Effect.logWarning("conversation.asked.failed")),
            )
            if (asked.txid === null) fields.existing = true
            fields.expiry = yield* expire(question.answerId)
            return asked
          }),
        )
        return asked.txid === null
          ? HttpServerResponse.jsonUnsafe({ txid: null, existing: true }, { status: 200, headers: noStore })
          : HttpServerResponse.jsonUnsafe({ txid: asked.txid }, { status: 202, headers: noStore })
      }).pipe(
        Effect.catchTag("Refusal", (refusal) => {
          fields.errorCode = refusal.errorCode
          return Effect.succeed(
            refusal.explanation === undefined
              ? HttpServerResponse.empty({
                status: refusal.status,
                headers: refusal.status === 405 ? { allow: "POST" } : {},
              })
              : HttpServerResponse.jsonUnsafe(
                { message: refusal.explanation },
                { status: refusal.status, headers: noStore },
              ),
          )
        }),
        // A bug: 500, logged by the defect's name, and the span ends without the defect, whose message can quote
        // what someone wrote.
        Effect.catchDefect((defect) => {
          Object.assign(fields, { errorCode: "defect", defect: nameOf(defect) })
          return Effect.succeed(HttpServerResponse.empty({ status: 500 }))
        }),
      )
      fields.status = response.status
      fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
      yield* Metric.update(Metric.withAttributes(ChatMetrics.questions, { status: String(response.status) }), 1)
      yield* Effect.annotateCurrentSpan({
        "http.response.status_code": response.status,
        ...(response.status >= 500 ? { "error.type": fields.errorCode } : {}),
      })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
        "chat.question",
      ).pipe(Effect.annotateLogs(fields))
      return response
    })

    /**
     * The conversation a question belongs to: the one it names, which must exist (404 otherwise), or the home
     * conversation when it names none (503 when there is none to bind it to). The asker must be a Member or above on
     * its branch's repository (`repo:ask`, decision 0007; ruling AUTH-8), never by their role on another (403
     * `forbidden` otherwise), and able to edit its branch (403 `view_only` otherwise): someone it is shared with to view
     * reads the conversation, never asks in it. Nothing is written for any of them: a Guest's question would leave a
     * `streaming` answer that no agent may answer, which holds up every later answer's turn.
     */
    const conversationOf = (named: string | undefined, asker: Actor, fields: Record<string, string | number | boolean>) =>
      Effect.gen(function* () {
        const id = named !== undefined
          ? named.toLowerCase()
          : yield* Conversations.home.pipe(Effect.provide(database), Effect.mapError(refuseStore))
        if (id === undefined) {
          return yield* new Refusal({ status: 503, errorCode: "no_home", explanation: unreachable })
        }
        const found = yield* branchAccess(Option.some(asker), id, "conversation").pipe(
          Effect.provide(database),
          Effect.mapError(refuseStore),
        )
        if (found === undefined) {
          return yield* new Refusal({
            status: 404,
            errorCode: "conversation_not_found",
            explanation: "No such conversation.",
          })
        }
        // The role the asker holds there, by which they ask: never their role on the deployment's own repository.
        fields.role = found.role ?? "none"
        const asking = askingOf(found)
        if (asking === "forbidden") {
          return yield* new Refusal({
            status: 403,
            errorCode: "forbidden",
            explanation: "Asking Smithers needs the Member role.",
          })
        }
        if (asking === "view_only") {
          return yield* new Refusal({ status: 403, errorCode: "view_only", explanation: "You can view this branch." })
        }
        return found.conversationId
      })

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = request.url.split("?")[0]!
      if (path === QUESTIONS_ROUTE) {
        const parent = parentOf(request.headers.traceparent)
        return yield* questions.pipe(Effect.withSpan("chat.question", { kind: "server", parent }))
      }
      if (path === PIN_ROUTE || path === `${PIN_ROUTE}/stamp`) return yield* pins.write
      if (path === PINS_SHAPE_ROUTE) return yield* pins.shape
      if (path === timelineSummaries.route) return yield* timelineSummaries.write
      if (path === SHAPE_ROUTE) return yield* shape
      if (path === VIEWS_ROUTE) return yield* views.add
      const stateOf = Views.stateViewId(path)
      if (stateOf !== undefined) return yield* views.state(stateOf)
      if (path === VIEWS_SHAPE_ROUTE) return yield* views.shape
      if (path === WEB_PREVIEW_ROUTE) return yield* webPreview.preview
      if (path === RUNS_SHAPE_ROUTE) return yield* runs.shape
      if (path === NOTIFICATIONS_SHAPE_ROUTE) return yield* notifications.shape
      if (path === WATCHES_ROUTE) return yield* notifications.watch
      if (path === ACK_ROUTE) return yield* notifications.ack
      if (path === SPEND_ALERTS_SHAPE_ROUTE) return yield* spendAlerts
      if (path === ALERT_CHANNELS_ROUTE) return yield* alertChannels.set
      if (path === ALERT_CHANNELS_SHAPE_ROUTE) return yield* alertChannels.channels
      if (path === ALERT_DELIVERIES_SHAPE_ROUTE) return yield* alertChannels.deliveries
      if (path === SANDBOX_LIMITS_ROUTE) return yield* sandboxLimits.set
      if (path === SANDBOX_LIMITS_SHAPE_ROUTE) return yield* sandboxLimits.limits
      if (path === FLOWS_SHAPE_ROUTE) return yield* personalFlows.flowsShape
      if (path === FLOW_DRAFTS_SHAPE_ROUTE) return yield* personalFlows.draftsShape
      if (path === FLOWS_ROUTE) return yield* personalFlows.flows("")
      if (path.startsWith(`${FLOWS_ROUTE}/`)) return yield* personalFlows.flows(path.slice(FLOWS_ROUTE.length + 1))
      if (path === FLOW_DRAFTS_ROUTE) return yield* personalFlows.drafts("")
      if (path.startsWith(`${FLOW_DRAFTS_ROUTE}/`)) {
        return yield* personalFlows.drafts(path.slice(FLOW_DRAFTS_ROUTE.length + 1))
      }
      if (path.startsWith(`${RUNS_ROUTE}/`)) return yield* runs.route(path.slice(RUNS_ROUTE.length + 1))
      if (path.startsWith(`${TELEMETRY_ROUTE}/`)) return yield* telemetry
      if (path.startsWith(`${MODEL_ROUTE}/`)) {
        const role = path.slice(MODEL_ROUTE.length + 1)
        if (isModelRole(role)) return yield* model(role)
      }
      if (path.startsWith(`${ANSWERS_ROUTE}/`)) {
        return yield* answers(path.slice(ANSWERS_ROUTE.length + 1))
      }
      return HttpServerResponse.empty({ status: 404 })
    })

    return { fetch }
  })

/**
 * Starts `chat/Expire` for an answer ChatApi took (worker/flows/Expire.ts), on the remote host through
 * `Flows.FlowStarter`, without waiting for it: one execution per answer, so starting it again is a no-op. It settles
 * the answer if no device ever does. A start the host can't record is a `chat.answer.expire` line and a count,
 * `not_started`, and refuses the ask with a 503, so the outbox sends it again.
 */
const expire = (answerId: string) =>
  Effect.flatMap(
    Flows.FlowStarter,
    (starter) => starter.start(Expire.Expire, { executionId: Expire.executionId(answerId), payload: { answerId } }),
  ).pipe(
    Effect.as("started"),
    Effect.catch((error) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(Expire.expiries, { outcome: "not_started" }), 1),
        Effect.logWarning("chat.answer.expire").pipe(
          Effect.annotateLogs({
            answerId,
            outcome: "not_started",
            errorCode: error._tag === "@smthrs/mvp/flows/StartUnavailable" ? error.errorCode : "conflict",
          }),
          Effect.andThen(
            new Refusal({ status: 503, errorCode: "expiry_not_started", explanation: notTaken }),
          ),
        ),
      )
    ),
  )

/** The 503 message when ChatApi stored a question but couldn't start its expiry. */
const notTaken = "Smithers couldn't take the question. Try again."

/** The 503 message when Postgres, or the sessions in it, can't be read. */
const unreachable = "Smithers can't reach its database. Try again."

/**
 * The actor asking, or a refusal of a caller who may not: signed out (401), or whose session can't be read (503). Who
 * may ask in the conversation, by their role on its repository, `conversationOf` decides (ruling AUTH-8).
 */
const signedIn = Effect.gen(function* () {
  const actor = yield* (yield* Sessions).resolve.pipe(
    Effect.mapError((error) => new Refusal({ status: 503, errorCode: codeOf(error), explanation: unreachable })),
  )
  if (Option.isNone(actor)) {
    return yield* new Refusal({ status: 401, errorCode: "authentication", explanation: "Sign in to ask Smithers." })
  }
  return actor.value
})

const noStore = { "cache-control": "no-store" }

/** What a shape filters on for someone who may not watch a conversation: no conversation's id, so it holds no rows. */
const NO_CONVERSATION = "00000000-0000-0000-0000-000000000000"

const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))

const isModelRole = (value: string): value is ModelRole => (MODEL_ROLES as ReadonlyArray<string>).includes(value)

/**
 * Reads at most `MAX_BODY_BYTES` as UTF-8 (`readBounded`): a larger body is 413, and malformed UTF-8 or a body that
 * breaks off is 400. Records how many bytes it read.
 */
const readBody = (request: HttpServerRequest.HttpServerRequest, fields: Record<string, string | number | boolean>) =>
  readBounded(request, MAX_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(
    Effect.mapError((refused) =>
      refused.reason === "too_large"
        ? new Refusal({ status: 413, errorCode: "too_large" })
        : new Refusal({ status: 400, errorCode: refused.reason, explanation: invalid })
    ),
  )

/**
 * A Postgres failure: the question's id is another message's (409), the answer's id is (409), or Postgres can't be
 * used (503): unreachable, or refusing the insert some other way, such as a position taken on a database missing
 * `0003_paired_positions`.
 */
const refuseStore = (error: unknown) => {
  if (error instanceof Messages.IdTaken) {
    return new Refusal({ status: 409, errorCode: "id_taken", explanation: "id belongs to another message." })
  }
  return SqlError.isSqlError(error) && error.reason._tag === "UniqueViolation" &&
      error.reason.constraint === "messages_pkey"
    ? new Refusal({ status: 409, errorCode: "answer_id_taken", explanation: "answerId belongs to another message." })
    : new Refusal({
      status: 503,
      errorCode: SqlError.isSqlError(error) ? `sql:${error.reason._tag}` : "database",
      explanation: unreachable,
    })
}

/**
 * A thrown value's name: a tagged value's `_tag`, an error's `name`, otherwise its type. A name that isn't an
 * identifier of at most 64 characters is `unknown`, so no message rides in as a name.
 */
const nameOf = (value: unknown): string => {
  const name = typeof value === "object" && value !== null
    ? "_tag" in value ? String(value._tag) : value instanceof Error ? value.name : "object"
    : typeof value
  return /^[A-Za-z_$][\w$.]{0,63}$/.test(name) ? name : "unknown"
}
