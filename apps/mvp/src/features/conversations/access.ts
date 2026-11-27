import { Context, type Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ACCESS_WITHIN, accessPath } from "./contract"

// ChatApi's word on whether the person may read a conversation now, as the data gate asks it of a conversation their
// list names and nothing says is open (owners.ts `verify`, docs/features/conversations.md#the-routes): one `GET`,
// through Effect's HttpClient, with one deadline covering the whole exchange. The route reads only.

/**
 * What ChatApi said: `allowed`, its `200 { allowed: true }`; `refused`, its `200 { allowed: false, code }` or its `401`, `403` or `404` with the code
 * it gives each; `unanswered` for anything else, offline, a deadline passed, a `5xx`, or an answer that is not
 * ChatApi's own, such as a deployment that has no such route yet. Only its own word opens or refuses anything.
 */
export type Access = "allowed" | "refused" | "unanswered"

const Answer = Schema.Union([
  Schema.Struct({ allowed: Schema.Literal(true) }),
  Schema.Struct({ allowed: Schema.Literal(false), code: Schema.optional(Schema.Literals(["forbidden", "not_found"])) }),
])
const Refused = Schema.Struct({ code: Schema.String })
const decodeAnswer = Schema.decodeUnknownEffect(Answer, { onExcessProperty: "error" })
const decodeRefused = Schema.decodeUnknownEffect(Refused)

/** The code ChatApi gives each refusal, by its status. */
const REFUSALS: Readonly<Record<number, string>> = { 401: "sign_in", 403: "forbidden", 404: "not_found" }

/** The access route on ChatApi at `origin`. */
export class ConversationAccess extends Context.Service<
  ConversationAccess,
  {
    /** `GET /api/conversations/<conversationId>/access`: whether the person may read the conversation now. */
    readonly check: (conversationId: string) => Effect.Effect<Access>
  }
>()("@smthrs/mvp/conversations/ConversationAccess") {
  /** The client over the host's `HttpClient`. */
  static readonly layer = (options: { readonly origin: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      ConversationAccess,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        return ConversationAccess.of({
          check: Effect.fn("conversation.access.get")(function* (conversationId) {
            const response = yield* client.execute(HttpClientRequest.get(`${options.origin}${accessPath(conversationId)}`))
            yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
            const body = yield* response.json
            if (response.status === 200) {
              const answer = yield* decodeAnswer(body)
              return answer.allowed ? "allowed" as const : "refused" as const
            }
            const refusal = yield* decodeRefused(body)
            return refusal.code === REFUSALS[response.status] ? "refused" as const : "unanswered" as const
          }, (effect) =>
            // Interrupting the request aborts its fetch, so a stalled body stops too. No answer, however it failed,
            // is no word of ChatApi's: said, and asked again later.
            Effect.timeout(effect, options.within ?? ACCESS_WITHIN).pipe(
              Effect.catch((failure) =>
                Effect.as(
                  Effect.logWarning("conversation.access.unanswered").pipe(Effect.annotateLogs({ reason: failure._tag })),
                  "unanswered" as const,
                )),
            )),
        })
      }),
    )
}
