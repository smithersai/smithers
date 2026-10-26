import { Context, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { FLOW_DRAFTS_ROUTE, FLOWS_ROUTE } from "./contract"
import { FlowNotFound, FlowsRefused, FlowsUnavailable } from "./reference"
import {
  Draft,
  type DraftAnswers,
  DraftList,
  type DraftWrite,
  FlowList,
  FlowSource,
  FlowsRefusal,
  Saved,
  type SaveRequest,
  type WriteRequest,
  Written,
} from "./schema"

// ChatApi's flows and drafts routes as `flow/*`'s steps call them (worker/PersonalFlows.ts), through Effect's
// HttpClient, each exchange under one deadline. A refusal (4xx) is `FlowsRefused` with ChatApi's code, final; no answer,
// a deadline or a 5xx is `FlowsUnavailable`, which a step's retry policy tries again.

/** How long a step gives ChatApi to answer. */
export const REQUEST_WITHIN = "15 seconds"

const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(FlowsRefusal))

/** Reads ChatApi's personal flows routes on `origin`. */
export class FlowsClient extends Context.Service<
  FlowsClient,
  {
    readonly list: Effect.Effect<FlowList, FlowsUnavailable | FlowsRefused>
    /**
     * One revision of the flow `name`, the latest unless `revision`, of the flow `flowId` when set (deleted or not);
     * `FlowNotFound` when there is none.
     */
    readonly source: (
      name: string,
      revision?: number,
      flowId?: string,
    ) => Effect.Effect<FlowSource, FlowsUnavailable | FlowsRefused | FlowNotFound>
    readonly draft: (draftId: string) => Effect.Effect<Draft, FlowsUnavailable | FlowsRefused>
    /** The person's drafts not saved yet, newest first. */
    readonly drafts: Effect.Effect<DraftList, FlowsUnavailable | FlowsRefused>
    readonly writeDraft: (draftId: string, write: DraftWrite) => Effect.Effect<void, FlowsUnavailable | FlowsRefused>
    readonly answer: (draftId: string, answers: DraftAnswers) => Effect.Effect<void, FlowsUnavailable | FlowsRefused>
    readonly save: (request: SaveRequest) => Effect.Effect<Saved, FlowsUnavailable | FlowsRefused>
    /** Code the person wrote as their flow's next revision; `FlowNotFound` when they have no such flow. */
    readonly write: (request: WriteRequest) => Effect.Effect<Saved, FlowsUnavailable | FlowsRefused | FlowNotFound>
    readonly remove: (flowId: string) => Effect.Effect<boolean, FlowsUnavailable | FlowsRefused>
    /** Deletes the draft `draftId`: `false` when it isn't the person's or is gone already. */
    readonly deleteDraft: (draftId: string) => Effect.Effect<boolean, FlowsUnavailable | FlowsRefused>
  }
>()("@smthrs/mvp/flows/FlowsClient") {
  /** The client over the host's `HttpClient`, each request answered within `within`. */
  static readonly layer = (options: { readonly origin: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      FlowsClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const within = options.within ?? REQUEST_WITHIN

        /** One exchange: `request`'s answer decoded by `schema`, a 404 as `notFound` when given. */
        const exchange = <A, E = never>(
          request: HttpClientRequest.HttpClientRequest,
          schema: Schema.Decoder<A>,
          notFound?: E,
        ): Effect.Effect<A, FlowsUnavailable | FlowsRefused | E> =>
          // Every route answers JSON: a `{ code }` refusal, or the value `schema` reads.
          Effect.gen(function* () {
            const response = yield* client.execute(request).pipe(Effect.mapError(() => new FlowsUnavailable({})))
            yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
            if (response.status === 404 && notFound !== undefined) return yield* Effect.fail(notFound)
            if (response.status >= 400 && response.status < 500) {
              // A body that can't be read reads as no code.
              const body = decodeRefusal(Option.getOrUndefined(yield* Effect.option(response.text)))
              return yield* new FlowsRefused({
                status: response.status,
                code: Option.match(body, { onNone: () => "refused", onSome: ({ code }) => code }),
              })
            }
            if (response.status !== 200) return yield* new FlowsUnavailable({ status: response.status })
            return yield* response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(schema)),
              Effect.mapError(() => new FlowsUnavailable({ status: response.status })),
            )
          }).pipe(
            // Interrupting the request aborts its fetch, so a stalled body stops too.
            Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new FlowsUnavailable({})) }),
          )

        const post = (path: string, body: unknown) =>
          HttpClientRequest.post(`${options.origin}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body))
        const get = (path: string) => HttpClientRequest.get(`${options.origin}${path}`)

        return FlowsClient.of({
          list: exchange(get(FLOWS_ROUTE), FlowList).pipe(Effect.withSpan("flow.client.list")),
          source: (name, revision, flowId) =>
            exchange(
              get(
                `${FLOWS_ROUTE}/source?name=${encodeURIComponent(name)}${
                  revision === undefined ? "" : `&revision=${revision}`
                }${flowId === undefined ? "" : `&flowId=${flowId}`}`,
              ),
              FlowSource,
              new FlowNotFound(),
            ).pipe(Effect.withSpan("flow.client.source")),
          draft: (draftId) => exchange(get(`${FLOW_DRAFTS_ROUTE}/${draftId}`), Draft).pipe(Effect.withSpan("flow.client.draft")),
          drafts: exchange(get(FLOW_DRAFTS_ROUTE), DraftList).pipe(Effect.withSpan("flow.client.drafts")),
          writeDraft: (draftId, write) =>
            exchange(post(`${FLOW_DRAFTS_ROUTE}/${draftId}`, write), Written).pipe(
              Effect.asVoid,
              Effect.withSpan("flow.client.write_draft"),
            ),
          answer: (draftId, answers) =>
            exchange(post(`${FLOW_DRAFTS_ROUTE}/${draftId}/answers`, answers), Written).pipe(
              Effect.asVoid,
              Effect.withSpan("flow.client.answer"),
            ),
          save: (request) => exchange(post(`${FLOWS_ROUTE}/save`, request), Saved).pipe(Effect.withSpan("flow.client.save")),
          write: (request) =>
            exchange(post(`${FLOWS_ROUTE}/write`, request), Saved, new FlowNotFound()).pipe(
              Effect.withSpan("flow.client.write"),
            ),
          remove: (flowId) =>
            exchange(post(`${FLOWS_ROUTE}/${flowId}/delete`, {}), Written, new FlowNotFound()).pipe(
              Effect.as(true),
              // Not the person's, or deleted already: nothing to delete.
              // expected: a flow already gone answers false
              Effect.catchTag("@smthrs/mvp/flows/FlowNotFound", () => Effect.succeed(false)),
              Effect.withSpan("flow.client.delete"),
            ),
          deleteDraft: (draftId) =>
            exchange(post(`${FLOW_DRAFTS_ROUTE}/${draftId}/delete`, {}), Written, new FlowNotFound()).pipe(
              Effect.as(true),
              // Gone already, or never the person's to read.
              // expected: a draft already gone answers false
              Effect.catchTag("@smthrs/mvp/flows/FlowNotFound", () => Effect.succeed(false)),
              Effect.withSpan("flow.client.delete_draft"),
            ),
        })
      }),
    )
}
