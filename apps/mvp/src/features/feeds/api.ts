import { Context, Data, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { FEED_ANSWER_WITHIN, feedAnswersRoute } from "./contract"
import { Answered, type FeedAnswerPayload } from "./schema"

// ChatApi's answer route as `feed/answer`'s step calls it (docs/features/feeds.md), through Effect's HttpClient, with one
// deadline covering the whole exchange.

/**
 * ChatApi didn't record the answer: no whole answer within the deadline, or no network (`status` absent), or a refusal
 * (`status`, with ChatApi's `code` when its body had one).
 */
export class AnswerNotTaken extends Data.TaggedError("AnswerNotTaken")<{
  readonly status?: number
  readonly code?: string
}> {}

const Refusal = Schema.Struct({ code: Schema.String })
const decodeRefusal = Schema.decodeUnknownEffect(Refusal)
const decodeAnswered = Schema.decodeUnknownEffect(Answered)

/** The feeds' answer route on ChatApi at `origin`. */
export class FeedsClient extends Context.Service<
  FeedsClient,
  {
    /** `POST /api/repos/<owner>/<name>/feeds/answers { id, item, choice, text }`. */
    readonly answer: (payload: FeedAnswerPayload) => Effect.Effect<Answered, AnswerNotTaken>
  }
>()("@smthrs/mvp/feeds/FeedsClient") {
  /** The client over the host's `HttpClient`: a `200` recorded the answer; anything else didn't. */
  static readonly layer = (options: { readonly origin: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      FeedsClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        return FeedsClient.of({
          answer: ({ owner, name, id, item, choice, text }) =>
            Effect.gen(function* () {
              const request = HttpClientRequest.post(`${options.origin}${feedAnswersRoute(owner, name)}`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ id, item, choice: choice ?? null, text: text ?? null }),
              )
              const response = yield* client.execute(request).pipe(Effect.mapError(() => new AnswerNotTaken({})))
              yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
              if (response.status !== 200) {
                const refusal = yield* response.json.pipe(Effect.flatMap(decodeRefusal), Effect.option)
                return yield* new AnswerNotTaken({
                  status: response.status,
                  ...Option.match(refusal, { onNone: () => ({}), onSome: ({ code }) => ({ code }) }),
                })
              }
              return yield* response.json.pipe(
                Effect.flatMap(decodeAnswered),
                Effect.mapError(() => new AnswerNotTaken({ status: response.status })),
              )
            }).pipe(
              // Interrupting the request aborts its fetch, so a stalled body stops too.
              (effect) =>
                Effect.timeoutOrElse(effect, {
                  duration: options.within ?? FEED_ANSWER_WITHIN,
                  orElse: () => Effect.fail(new AnswerNotTaken({})),
                }),
              Effect.withSpan("feed.answer.send", { kind: "client" }),
            ),
        })
      }),
    )
}
