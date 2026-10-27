import { Context, type Duration, Effect, Layer, Metric, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { ANSWERS_ROUTE } from "./contract"
import { type AnswerWrite, AnswerWrite as AnswerWriteSchema, Turn } from "./schema"

// Where the agent reads its turn and writes its answer (docs/features/agent.md#the-answer-routes): ChatApi's answer
// routes, through Effect `HttpClient`. The agent's flow reaches them only through `AnswerApi`, so the same flow runs in
// the browser's engine, on the Node host and later in the native app, each with its own `HttpClient`.

/**
 * An earlier answer is still streaming: this one waits its turn, and has waited `waitedMs` since the queue before it
 * last moved (an earlier answer settled, or this one was asked), by ChatApi's clock. The step's retry policy asks again.
 */
export class NotYourTurn extends Schema.TaggedError<NotYourTurn>()("@smthrs/mvp/agent/NotYourTurn", {
  waitedMs: Schema.Number,
}) {}

/**
 * The queue before this answer didn't move for the turn wait while it waited for its turn (`chat/LoadTurn`): the run
 * settles the answer `unfinished`, so this never ends a run.
 */
export class TurnOutOfTime extends Schema.TaggedError<TurnOutOfTime>()("@smthrs/mvp/agent/TurnOutOfTime", {}) {}

/** The answer has settled already, so nothing more is written to it. */
export class AnswerSettled extends Schema.TaggedError<AnswerSettled>()("@smthrs/mvp/agent/AnswerSettled", {}) {}

/** The routes refused or the exchange failed: `status` is absent for a transport failure or deadline. */
export class AnswersUnavailable extends Schema.TaggedError<AnswersUnavailable>()(
  "@smthrs/mvp/agent/AnswersUnavailable",
  { status: Schema.optional(Schema.Number) },
) {}

/** Exchanges whose request or response body exceeded the host's deadline. */
export const exchangeTimeouts = Metric.counter("smithers_answer_exchange_timeouts", { incremental: true })

/** The answer routes, as the agent's flow reaches them. */
export class AnswerApi extends Context.Service<
  AnswerApi,
  {
    /** The question and its history, once every earlier answer has settled. */
    readonly turn: (answerId: string) => Effect.Effect<Turn, NotYourTurn | AnswerSettled | AnswersUnavailable>
    /** Renews this owned run independently of answer text or tool progress. */
    readonly heartbeat: (answerId: string) => Effect.Effect<void, AnswerSettled | AnswersUnavailable>
    /** Writes the answer's parts, or settles it. A settle that already landed succeeds. */
    readonly write: (answerId: string, write: AnswerWrite) => Effect.Effect<void, AnswerSettled | AnswersUnavailable>
  }
>()("@smthrs/mvp/agent/AnswerApi") {
  /** ChatApi's answer routes on `origin`, with one deadline for the request and decoded body. */
  static readonly layerHttp = (origin: string, within: Duration.Input = "15 seconds") =>
    Layer.effect(
      AnswerApi,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const url = (answerId: string) => `${origin}${ANSWERS_ROUTE}/${answerId}`
        const send = (request: HttpClientRequest.HttpClientRequest) =>
          client.execute(request).pipe(Effect.mapError(() => new AnswersUnavailable({})))
        const exchange = <A, E>(operation: string, effect: Effect.Effect<A, E>) => effect.pipe(
          Effect.timeoutOrElse({
            duration: within,
            orElse: () => Effect.gen(function* () {
              yield* Metric.update(Metric.withAttributes(exchangeTimeouts, { operation }), 1)
              yield* Effect.logWarning("chat.answer.exchange.timeout").pipe(Effect.annotateLogs({ operation }))
              return yield* new AnswersUnavailable({})
            }),
          }),
          Effect.withSpan("chat.answer.exchange", { kind: "client", attributes: { operation } }),
        )
        return AnswerApi.of({
          turn: (answerId) =>
            exchange("turn", Effect.gen(function* () {
              const response = yield* send(HttpClientRequest.get(url(answerId)))
              if (response.status !== 200) return yield* refused(response)
              return yield* response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Turn)),
                Effect.mapError(() => new AnswersUnavailable({ status: response.status })),
              )
            })),
          heartbeat: (answerId) => exchange("heartbeat", Effect.gen(function* () {
            const response = yield* send(HttpClientRequest.patch(url(answerId)))
            // A confirmed late pulse needs no lease: settlement is normal, not an HTTP failure.
            if (response.status === 204) return yield* new AnswerSettled()
            if (response.status !== 200) return yield* refused(response).pipe(
              Effect.catchTag("@smthrs/mvp/agent/NotYourTurn", () => new AnswersUnavailable({ status: 409 })),
            )
          })),
          write: (answerId, write) =>
            exchange("write", Effect.gen(function* () {
              const body = Schema.encodeSync(AnswerWriteSchema)(write)
              const response = yield* send(
                HttpClientRequest.post(url(answerId)).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
              )
              if (response.status !== 200) {
                return yield* refused(response).pipe(
                  Effect.catchTag("@smthrs/mvp/agent/NotYourTurn", () => new AnswersUnavailable({ status: 409 })),
                )
              }
            })),
        })
      }),
    )
}

/** How long a `not_your_turn` refusal says the turn has waited: 0 unless it says so as a non-negative number. */
const waitedOf = (body: unknown): number => {
  // Only a refusal whose body is an object with its code reaches here.
  const waited = (body as { readonly waitedMs?: unknown }).waitedMs
  return typeof waited === "number" && waited >= 0 ? waited : 0
}

/** A refusal as the agent handles it: its turn hasn't come, the answer settled, or the routes are unavailable. */
const refused = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    if (response.status !== 409) return yield* new AnswersUnavailable({ status: response.status })
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null))
    const code = typeof body === "object" && body !== null && "code" in body ? body.code : undefined
    if (code === "not_your_turn") return yield* new NotYourTurn({ waitedMs: waitedOf(body) })
    if (code === "settled") return yield* new AnswerSettled()
    return yield* new AnswersUnavailable({ status: response.status })
  })
