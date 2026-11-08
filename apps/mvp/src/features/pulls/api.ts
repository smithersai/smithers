import { Context, Data, type Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { writesRoute } from "../issues/contract"
import { WriteTaken } from "../issues/schema"
import { compareRoute, type MergeMethod, reviewRoute } from "./contract"
import { type ReviewRequest, ReviewTaken } from "./flows"
import { Compared } from "./schema"

// ChatApi's pull request routes as the browser calls them (docs/features/pulls.md#routes), through Effect's HttpClient,
// with one deadline covering each whole exchange: a person's merge, sent in their own session and never queued (decision
// 0012 decision 6), and a comparison's files.

/**
 * ChatApi didn't answer the request: no whole answer within the deadline, no network (`status` absent), or any other
 * status, with ChatApi's `code` when its body had one.
 */
export class PullsRequestFailed extends Data.TaggedError("PullsRequestFailed")<{
  readonly status?: number
  readonly code?: string
}> {}

const decodeTaken = Schema.decodeUnknownEffect(WriteTaken)
const decodeCompared = Schema.decodeUnknownEffect(Compared)
const decodeReviewTaken = Schema.decodeUnknownEffect(ReviewTaken)
const decodeRefusal = Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.String }))

/** A merge as the writes route takes it: the pull request, bound to the head and base the person saw. */
export interface MergeRequest {
  readonly writeId: string
  readonly number: number
  readonly headSha: string
  readonly baseSha: string
  readonly method: MergeMethod
}

/** ChatApi's pull request routes, as a service. Tests of a route that fails provide a faulty one. */
export class PullsClient extends Context.Service<
  PullsClient,
  {
    /** `POST .../writes` with `op: "pr/merge"`, in the person's session: `202` took it, `200` had it already. */
    readonly merge: (owner: string, name: string, merge: MergeRequest) => Effect.Effect<WriteTaken, PullsRequestFailed>
    /** `GET .../compare/<base>...<head>`: the files two commits differ by. */
    readonly compare: (owner: string, name: string, base: string, head: string) => Effect.Effect<Compared, PullsRequestFailed>
    /** `POST .../pulls/<number>/review { headSha? }`: ask Smithers to review the head; `202` took it. */
    readonly review: (request: ReviewRequest) => Effect.Effect<ReviewTaken, PullsRequestFailed>
  }
>()("@smthrs/mvp/pulls/PullsClient") {
  /** The real client: ChatApi at `origin`, with `within` for each whole request. */
  static readonly layer = (options: { readonly origin: string; readonly within: Duration.Input }) =>
    Layer.effect(
      PullsClient,
      Effect.map(HttpClient.HttpClient, (client) => {
        const send = <A>(request: HttpClientRequest.HttpClientRequest, decode: (body: unknown) => Effect.Effect<A, unknown>, ok: ReadonlyArray<number>) =>
          Effect.gen(function* () {
            const response = yield* client.execute(request).pipe(Effect.mapError(() => new PullsRequestFailed({})))
            if (!ok.includes(response.status)) {
              const refusal = yield* response.json.pipe(Effect.flatMap(decodeRefusal), Effect.option)
              return yield* new PullsRequestFailed({
                status: response.status,
                ...(refusal._tag === "Some" ? { code: refusal.value.code } : {}),
              })
            }
            return yield* response.json.pipe(
              Effect.flatMap(decode),
              Effect.mapError(() => new PullsRequestFailed({ status: response.status })),
            )
          }).pipe(Effect.timeoutOrElse({ duration: options.within, orElse: () => Effect.fail(new PullsRequestFailed({})) }))
        return PullsClient.of({
          merge: (owner, name, merge) =>
            send(
              HttpClientRequest.post(`${options.origin}${writesRoute(owner, name)}`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ ...merge, op: "pr/merge" }),
              ),
              decodeTaken,
              [200, 202],
            ).pipe(Effect.withSpan("pulls.merge.post")),
          compare: (owner, name, base, head) =>
            send(HttpClientRequest.get(`${options.origin}${compareRoute(owner, name, base, head)}`), decodeCompared, [200])
              .pipe(Effect.withSpan("pulls.compare.get")),
          review: ({ repo, number, headSha }) => {
            const [owner = "", name = ""] = repo.split("/")
            return send(
              HttpClientRequest.post(`${options.origin}${reviewRoute(owner, name, number)}`).pipe(
                HttpClientRequest.bodyJsonUnsafe(headSha === undefined ? {} : { headSha }),
              ),
              decodeReviewTaken,
              [202],
            ).pipe(Effect.withSpan("pulls.review.post"))
          },
        })
      }),
    )
}
