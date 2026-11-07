import { Context, Data, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { CONFIRM_401_HEADER, sessionCheckOf } from "../auth/contract"
import { type TextScope, textRoute } from "./contract"

// ChatApi's text route as the browser calls it (docs/features/coedit.md#routes), through Effect's HttpClient, with one
// deadline covering the whole exchange, its body included.

/**
 * ChatApi didn't take the update: no whole answer within the deadline, or no network (`status` absent), or any status
 * but 200 (`status`, and the refusal's `code` when its body names one), or a 200 whose body isn't the contract's. A
 * `401` the page's transport checked against the session carries what it found (`sessionCheck`).
 */
export class UpdateNotTaken extends Data.TaggedError("UpdateNotTaken")<{
  readonly status?: number
  readonly code?: string
  readonly sessionCheck?: "same_person"
}> {}

/** One update as the route takes it. */
export interface UpdateRequest {
  readonly scope: TextScope
  readonly id: string
  readonly update: string
  readonly seed?: boolean
}

const Taken = Schema.Struct({ txid: Schema.NullOr(Schema.Number) })
const decodeTaken = Schema.decodeUnknownEffect(Taken)
const decodeRefusal = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))

/** `POST /api/texts/<id>`: `{ txid }`, `null` when ChatApi had the update already. */
export const postUpdate = (origin: string, textId: string, request: UpdateRequest, within: Duration.Input) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${origin}${textRoute(textId)}`).pipe(
          HttpClientRequest.bodyJsonUnsafe(request),
          // A 401 is checked against the session first: an update is queued, so it can be held (writes.ts).
          HttpClientRequest.setHeader(CONFIRM_401_HEADER, "1"),
        ),
      )
      .pipe(Effect.catch(() => Effect.fail(new UpdateNotTaken({}))))
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    if (response.status !== 200) {
      const refused = yield* response.json.pipe(Effect.option, Effect.map(Option.flatMap(decodeRefusal)))
      return yield* new UpdateNotTaken({
        status: response.status,
        ...(Option.isSome(refused) ? { code: refused.value.code } : {}),
        ...sessionCheckOf(response.headers),
      })
    }
    return yield* response.json.pipe(
      Effect.flatMap(decodeTaken),
      Effect.catch(() => Effect.fail(new UpdateNotTaken({ status: response.status }))),
    )
  }).pipe(
    // Interrupting the request aborts its fetch, so a stalled body stops too.
    Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new UpdateNotTaken({})) }),
  )

/**
 * ChatApi's text route, as a service: the one way the browser writes to a text. Tests of a route that fails provide a
 * faulty one; every other test uses the real one.
 */
export class TextsClient extends Context.Service<
  TextsClient,
  {
    readonly write: (
      textId: string,
      request: UpdateRequest,
    ) => Effect.Effect<{ readonly txid: number | null }, UpdateNotTaken>
  }
>()("@smthrs/mvp/coedit/TextsClient") {
  /** The real client: ChatApi at `origin`, with `within` for each whole request. */
  static readonly layer = (options: { readonly origin: string; readonly within: Duration.Input }) =>
    Layer.effect(
      TextsClient,
      Effect.map(HttpClient.HttpClient, (client) =>
        TextsClient.of({
          write: (textId, request) =>
            postUpdate(options.origin, textId, request, options.within).pipe(
              Effect.provideService(HttpClient.HttpClient, client),
            ),
        })),
    )
}
