import { Context, Data, type Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { PERSONAL_MODEL_ROUTE, PERSONAL_MODEL_TEST_ROUTE, type Protocol, REFUSALS, type Refusal } from "./contract"
import { RECORD } from "./metrics"
import { TestResult } from "./schema"

// ChatApi's routes for a person's own model as the browser calls them (docs/features/personal-model.md#the-routes),
// through Effect's HttpClient, with one deadline covering each whole exchange. Save is sent from the person's own tab,
// at once and never queued: the device's outbox and a browser flow would keep the key on the device (IndexedDB, the
// engine's journal). The key is `Redacted` until the request body is made, here, and nothing records a body: each
// request's span carries its op and status. Remove and Test are their flows' steps' calls (steps.ts).

/** How long a save or a remove gets to answer: each answers once its flow has started. */
export const MODEL_WITHIN: Duration.Input = "15 seconds"

/** How long a test gets: ChatApi makes one real call to the person's provider before it answers. */
export const TEST_WITHIN: Duration.Input = "45 seconds"

/**
 * ChatApi didn't take the request: no whole answer within the deadline, or no network (`status` absent); or it refused
 * (`status`, with its `code` when the body named one of `REFUSALS`).
 */
export class ModelNotTaken extends Data.TaggedError("ModelNotTaken")<{
  readonly status?: number
  readonly code?: Refusal
}> {}

/** What Save sends: the protocol, the base URL, the model id and the key, `Redacted` until the body is made. */
export interface ModelPut {
  readonly protocol: Protocol
  readonly baseUrl: string
  readonly modelId: string
  readonly key: Redacted.Redacted<string>
}

const Refused = Schema.Struct({ code: Schema.Literals(REFUSALS) })
const decodeRefused = Schema.decodeUnknownEffect(Refused)
const Saved = Schema.Struct({ baseUrl: Schema.String })
const decodeSaved = Schema.decodeUnknownEffect(Saved)
const decodeTested = Schema.decodeUnknownEffect(TestResult)

/** ChatApi's routes for a person's own model, as a service. Tests of a route that fails provide a faulty one. */
export class PersonalModelClient extends Context.Service<
  PersonalModelClient,
  {
    /** `PUT /api/me/model`: `202` took it, answering the base URL as ChatApi normalized it. */
    readonly put: (put: ModelPut) => Effect.Effect<{ readonly baseUrl: string }, ModelNotTaken>
    /** `DELETE /api/me/model`: `202` took it. */
    readonly remove: Effect.Effect<void, ModelNotTaken>
    /** `POST /api/me/model/test`: `200` with how one tiny call with the saved model went. */
    readonly test: Effect.Effect<TestResult, ModelNotTaken>
  }
>()("@smthrs/mvp/personal-model/PersonalModelClient") {
  /** The real client: ChatApi at `origin`, with `within` for a save or a remove and `testWithin` for a test. */
  static readonly layer = (options: {
    readonly origin: string
    readonly within?: Duration.Input
    readonly testWithin?: Duration.Input
  }) =>
    Layer.effect(
      PersonalModelClient,
      Effect.map(HttpClient.HttpClient, (client) => {
        /**
         * Sends `request`, answering what `read` makes of the response when its status is `expected`. Any other status
         * is a refusal with the body's code when it names one; a failure of the request itself names the request, body
         * included, so it is dropped whole.
         */
        const send = <A>(
          op: keyof typeof RECORD,
          request: HttpClientRequest.HttpClientRequest,
          expected: number,
          read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>,
          within: Duration.Input,
        ) =>
          Effect.gen(function* () {
            const response = yield* client.execute(request).pipe(Effect.mapError(() => new ModelNotTaken({})))
            yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
            if (response.status !== expected) {
              const refused = yield* response.json.pipe(Effect.flatMap(decodeRefused), Effect.option)
              return yield* new ModelNotTaken({
                status: response.status,
                ...Option.match(refused, { onNone: () => ({}), onSome: ({ code }) => ({ code }) }),
              })
            }
            return yield* read(response).pipe(Effect.mapError(() => new ModelNotTaken({ status: response.status })))
          }).pipe(
            // Interrupting the request aborts its fetch, so a stalled body stops too.
            Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new ModelNotTaken({})) }),
            Effect.withSpan(RECORD[op], { kind: "client" }),
          )
        const url = `${options.origin}${PERSONAL_MODEL_ROUTE}`
        const within = options.within ?? MODEL_WITHIN
        return PersonalModelClient.of({
          put: (put) =>
            send(
              "put",
              HttpClientRequest.put(url).pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  protocol: put.protocol,
                  baseUrl: put.baseUrl,
                  modelId: put.modelId,
                  key: Redacted.value(put.key),
                }),
              ),
              202,
              (response) => Effect.flatMap(response.json, decodeSaved),
              within,
            ),
          remove: send("delete", HttpClientRequest.delete(url), 202, () => Effect.void, within),
          test: send(
            "test",
            HttpClientRequest.post(`${options.origin}${PERSONAL_MODEL_TEST_ROUTE}`),
            200,
            (response) => Effect.flatMap(response.json, decodeTested),
            options.testWithin ?? TEST_WITHIN,
          ),
        })
      }),
    )
}
