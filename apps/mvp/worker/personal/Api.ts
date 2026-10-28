import { ShapeProxy } from "@smthrs/effect-electric"
import { ModelError, ModelEvent, ModelProxy, ModelRequest } from "@smthrs/model"
import { Binding } from "@smthrs/secrets"
import { Cause, Clock, Duration, Effect, Exit, type Layer, Metric, Option, Redacted, Schema, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../../src/features/chat/contract.ts"
import { MODEL_TIERS, type ModelTier } from "../../src/features/model/contract.ts"
import {
  checkSave,
  keyTail,
  MAX_PUT_BODY_BYTES,
  PERSONAL_MODEL_ROUTE,
  PERSONAL_MODEL_SHAPE_COLUMNS,
  PERSONAL_MODEL_SHAPE_ROUTE,
  PERSONAL_MODEL_TEST_ROUTE,
  PERSONAL_MODELS_TABLE,
  type Refusal,
  TEST_MAX_TOKENS,
  TEST_PROMPT,
  type TestResult,
  writeExecutionId,
} from "../../src/features/personal-model/contract.ts"
import { refusesPersonOnly, Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Flows from "../Flows.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import * as ShapeAccess from "../ShapeAccess.ts"
import * as ModelFlows from "./ModelFlows.ts"
import { type Opened, PersonalModels, PersonalModelUnusable, sealContext } from "./Models.ts"
import * as Store from "./Store.ts"
import * as PersonalUsage from "./Usage.ts"

// A person's own models' routes (decisions 0096 and 0107, docs/features/personal-model.md). Keys are write-only: no
// route answers one.
//
// - `PUT /api/me/model { keys, models }`: saves the person's keys, one per protocol, and the models their tiers use,
//   replacing what they saved. It admits the write (anyone signed in, ruling AUTH-8, the person in person: never an agent,
//   flow or sandbox, since a key would pass through them), checks every field (`checkSave`), seals each key typed under
//   SECRETS_KEY and starts `model/Put` with only ciphertext. A key's base URL changes only with the key, so nobody
//   points a saved key at another host.
// - `DELETE /api/me/model`: removes every key through `model/Delete`, for anyone signed in. The agent may, for the
//   person (FLOW-3).
// - `POST /api/me/model/test`: one tiny real call with each key the tiers use, answered as one `TestResult`, for anyone
//   signed in. The agent may.
// - `GET /api/shapes/personal-model`: the person's own rows, never another's, never a sealed key.
//
// No log line, span, metric or answer carries a key, and a refusal names a code, never the input.

/** Requests to the personal model routes, by `op` (`put`, `delete`, `test`) and `outcome`. */
export const requests = Metric.counter("smithers_personal_model_requests", {
  description: "Requests to the personal model routes, by op and outcome",
  incremental: true,
})

/** `GET /api/shapes/personal-model` requests, by `status` and `live`. */
export const shapes = Metric.counter("smithers_personal_model_shape_requests", {
  description: "GET /api/shapes/personal-model requests, by status and live",
  incremental: true,
})

/** How long a test's call may take, start to end. */
export const TEST_WITHIN = Duration.seconds(30)

/** Whether a path is one of the personal model routes. */
export const handles = (path: string): boolean =>
  path === PERSONAL_MODEL_ROUTE || path === PERSONAL_MODEL_TEST_ROUTE || path === PERSONAL_MODEL_SHAPE_ROUTE

const PutBody = Schema.Struct({
  keys: Schema.Array(Schema.Struct({ protocol: Schema.String, baseUrl: Schema.String, key: Schema.optional(Schema.String) })),
  models: Schema.Record(Schema.String, Schema.Struct({ protocol: Schema.String, modelId: Schema.String })),
})
const decodePut = Schema.decodeUnknownEffect(Schema.fromJsonString(PutBody))

/** What a shape filters on for someone signed out: no person, so it holds no rows. */
const NOBODY = ""

const noStore = { "cache-control": "no-store" }

type Fields = Record<string, string | number | boolean>

/** The model's first words, one line, cut to what a test shows. */
const sampleOf = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 80)

/**
 * The personal model routes over `database`. They read who is asking from `Sessions`, the keys from `SecretKeys`, the
 * people's models from `PersonalModels`, and start the flows through `Flows.FlowStarter`. A test's call ends after
 * `testWithin`, {@link TEST_WITHIN} unless set.
 */
export const make = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  options: { readonly testWithin?: Duration.Input } = {},
) => Effect.gen(function* () {
  const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })
  // What the database layer needs, captured here, so a test's ledger write needs nothing of the request.
  const context = yield* Effect.context<R>()

  /** `GET /api/shapes/personal-model`: the person's own row; sessions unreadable, 503. */
  const shape = ShapeProxy.make({
    ...connection,
    shape: Effect.gen(function* () {
      const actor = yield* ShapeAccess.actor
      const person = Option.isSome(actor) ? actor.value.subject.id : NOBODY
      return {
        table: PERSONAL_MODELS_TABLE,
        where: "person_id = $1",
        params: { "1": person },
        columns: PERSONAL_MODEL_SHAPE_COLUMNS,
      }
    }),
    name: "personal_model.shape",
    metric: shapes,
  })

  /**
   * One tiny real call with each of the person's keys the tiers use, the first tier on each key, each settled in their
   * ledger as any of their calls is: the first failure, else the `fast` tier's answer. None when they saved no key.
   */
  const test = (personId: string) =>
    Effect.gen(function* () {
      const personal = yield* PersonalModels
      const startedAt = yield* Clock.currentTimeMillis
      const latency = Effect.map(Clock.currentTimeMillis, (now) => now - startedAt)
      const calls: Array<Opened> = []
      for (const tier of MODEL_TIERS) {
        const opened = yield* personal.open(personId, tier).pipe(Effect.result)
        if (opened._tag === "Failure") {
          const failure = opened.failure
          // Postgres couldn't say: the route answers 503.
          if (!(failure instanceof PersonalModelUnusable)) return yield* failure
          return Option.some<TestResult>({
            ok: false,
            latencyMs: yield* latency,
            code: "unusable",
            status: null,
            host: failure.host,
          })
        }
        if (Option.isNone(opened.success)) return Option.none<TestResult>()
        const model = opened.success.value
        if (!calls.some((call) => call.protocol === model.protocol)) calls.push(model)
      }
      let first: TestResult | undefined
      for (const opened of calls) {
        const result = yield* testCall(personId, opened, latency)
        if (!result.ok) return Option.some(result)
        first ??= result
      }
      return Option.some(first!)
    })

  /** One tiny real call with `opened`, settled in the person's ledger: how it went. */
  const testCall = (personId: string, opened: Opened, latency: Effect.Effect<number>) =>
    Effect.gen(function* () {
      const { model, modelId, host, protocol } = opened
      const invocationId = crypto.randomUUID()
      const call: PersonalUsage.Call = {
        invocationId,
        requestId: invocationId,
        personId,
        role: "test",
        modelId,
        host,
        protocol,
        tier: undefined,
      }
      yield* PersonalUsage.begin(call).pipe(Effect.provide(database), Effect.provideContext(context))
      let usage: ModelEvent.Usage = {}
      let text = ""
      const request = ModelRequest.ModelRequest.make({
        modelId,
        system: [],
        messages: [ModelRequest.Message.user(TEST_PROMPT)],
        tools: [],
        params: ModelRequest.GenerationParams.make({ maxTokens: TEST_MAX_TOKENS }),
      })
      const exit = yield* model.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            usage = ModelEvent.settledMessage([{ type: "usage", ...usage }, event]).usage
            if (event.type === "text-delta") text += event.text
          })
        ),
        Effect.timeoutOrElse({
          duration: options.testWithin ?? TEST_WITHIN,
          orElse: () => Effect.fail(new ModelError.ModelError({ code: "call_timeout", message: "The test timed out." })),
        }),
        // A request cancelled while the provider answers settles its row too, as interrupted.
        Effect.onInterrupt(() =>
          PersonalUsage.end(call, { outcome: "interrupted", usage }, database).pipe(Effect.provideContext(context))
        ),
        Effect.exit,
      )
      const failure = Exit.isFailure(exit) ? ModelProxy.failureOf(exit.cause) : undefined
      yield* PersonalUsage.end(call, {
        outcome: failure === undefined ? "success" : "failed",
        usage,
        ...(failure ?? {}),
      }, database).pipe(Effect.provideContext(context))
      const latencyMs = yield* latency
      return failure === undefined
        ? { ok: true, latencyMs, sample: sampleOf(text) } satisfies TestResult
        : { ok: false, latencyMs, code: failure.errorCode, status: failure.httpStatus ?? null, host } satisfies TestResult
    })

  /** `PUT`, `DELETE /api/me/model` and `POST /api/me/model/test`. */
  const route = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const sessions = yield* Sessions
    const starter = yield* Flows.FlowStarter
    const keys = yield* SecretKeys
    const startedAt = yield* Clock.currentTimeMillis
    const path = request.url.split("?")[0]!
    const op = path === PERSONAL_MODEL_TEST_ROUTE ? "test" : request.method === "DELETE" ? "delete" : "put"
    const fields: Fields = { op }
    const refuse = (status: number, code: Refusal) => {
      fields.code = code
      return HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
    }
    const response = yield* Effect.gen(function* () {
      if (op === "test" ? request.method !== "POST" : request.method !== "PUT" && request.method !== "DELETE") {
        return HttpServerResponse.empty({ status: 405, headers: { allow: op === "test" ? "POST" : "PUT, DELETE" } })
      }
      const actor = yield* sessions.resolve
      if (Option.isNone(actor)) return refuse(401, "authentication")
      const personId = actor.value.subject.id
      const executionId = writeExecutionId(op === "delete" ? "delete" : "put", crypto.randomUUID())
      // Anyone signed in removes their own model, a person who lost their role included.
      if (op === "delete") {
        const started = yield* starter.start(ModelFlows.Delete, { executionId, payload: { personId } }).pipe(
          Effect.result,
        )
        if (started._tag === "Failure") return refuse(503, "unavailable")
        fields.outcome = "deleting"
        return HttpServerResponse.jsonUnsafe({}, { status: 202, headers: noStore })
      }
      // Anyone signed in saves and tests a model of their own: it is their key, and it answers only their calls (ruling
      // AUTH-8). Where they may ask, ChatApi decides by their role on each conversation's repository.
      if (op === "test") {
        const result = yield* test(personId)
        if (Option.isNone(result)) return refuse(404, "none")
        fields.outcome = result.value.ok ? "ok" : "failed"
        if (!result.value.ok) {
          fields.failure = result.value.code
          if (result.value.status !== null) fields.providerStatus = result.value.status
        }
        return HttpServerResponse.jsonUnsafe(result.value, { status: 200, headers: noStore })
      }
      // The key would pass through whoever acts for the person: only the person saves one (decision 0017).
      if (yield* refusesPersonOnly(actor.value, "model")) return refuse(403, "forbidden")
      if (Option.isNone(keys)) return refuse(503, "off")
      const body = yield* readBounded(request, MAX_PUT_BODY_BYTES).pipe(Effect.result)
      if (body._tag === "Failure") {
        return body.failure.reason === "too_large" ? refuse(413, "too_large") : refuse(400, "invalid")
      }
      // A decoding failure would quote its input, the key: it is dropped whole.
      const decoded = yield* decodePut(body.success).pipe(Effect.option)
      if (Option.isNone(decoded)) return refuse(400, "invalid")
      // A key kept without its value must be the one saved at the same base URL: read what the person saved.
      const saved = yield* Store.saved(personId).pipe(Effect.provide(database), Effect.provideContext(context))
      // The browser sees each key's last characters again: they must be a small part of it (`too_short`).
      const checked = checkSave(decoded.value, saved, Binding.valueProblem)
      if (typeof checked === "string") return refuse(400, checked)
      const { cipher, version } = keys.value
      const writes = yield* Effect.forEach(checked.keys, ({ protocol, baseUrl, key }) =>
        key === undefined
          ? Effect.succeed({ protocol, baseUrl })
          : Effect.map(
            cipher.seal(Redacted.make(key), sealContext(personId, version)),
            (sealed) => ({ protocol, baseUrl, sealed: { ...sealed, keyVersion: version, keyLast4: keyTail(key) } }),
          ))
      const started = yield* starter.start(ModelFlows.Put, {
        executionId,
        payload: { personId, keys: writes, models: checked.models },
      }).pipe(Effect.result)
      if (started._tag === "Failure") return refuse(503, "unavailable")
      fields.outcome = "putting"
      fields.keys = checked.keys.length
      fields.tiers = (Object.keys(checked.models) as ReadonlyArray<ModelTier>).join(",")
      return HttpServerResponse.jsonUnsafe({}, { status: 202, headers: noStore })
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
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, outcome })
    yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
      "personal_model.request",
    ).pipe(Effect.annotateLogs({ ...fields, outcome }))
    return response
  }).pipe(Effect.withSpan("personal_model.request", { kind: "server" }))

  const fetch = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    return request.url.split("?")[0] === PERSONAL_MODEL_SHAPE_ROUTE ? yield* shape : yield* route
  })

  return { fetch }
})
