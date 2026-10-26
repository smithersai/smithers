import { Context, Data, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { BUG_REPORTS_ROUTE, BUGS_WITHIN } from "./contract"
import { Filed, Listed, Refused, type ReportRequest } from "./schema"

// ChatApi's bug report routes as the flows' steps call them (docs/features/bugs.md#the-routes), through Effect's
// HttpClient, with one deadline covering each whole exchange.

/**
 * ChatApi didn't take the request: no whole answer within the deadline, or no network (`status` absent), or a refusal
 * (`status`, with ChatApi's `code` when its body had one).
 */
export class BugsNotTaken extends Data.TaggedError("BugsNotTaken")<{
  readonly status?: number
  readonly code?: string
}> {}

const decodeRefused = Schema.decodeUnknownEffect(Refused)
const decodeFiled = Schema.decodeUnknownEffect(Filed)
const decodeListed = Schema.decodeUnknownEffect(Listed)

/** The bug report routes on ChatApi at `origin`. */
export class BugsClient extends Context.Service<
  BugsClient,
  {
    /** `POST /api/bugs`: files one report; filing it again answers the same id. */
    readonly file: (report: ReportRequest) => Effect.Effect<Filed, BugsNotTaken>
    /** `GET /api/bugs?limit=`: the latest reports, newest first, for an Admin. */
    readonly list: (limit: number | undefined) => Effect.Effect<Listed, BugsNotTaken>
  }
>()("@smthrs/mvp/bugs/BugsClient") {
  /** The client over the host's `HttpClient`: a `200` with its body took the request; anything else is refused. */
  static readonly layer = (options: { readonly origin: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      BugsClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const exchange = <A>(
          request: HttpClientRequest.HttpClientRequest,
          decode: (body: unknown) => Effect.Effect<A, unknown>,
        ) =>
          Effect.gen(function* () {
            const response = yield* client.execute(request).pipe(Effect.mapError(() => new BugsNotTaken({})))
            yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
            if (response.status !== 200) {
              const refusal = yield* response.json.pipe(Effect.flatMap(decodeRefused), Effect.option)
              return yield* new BugsNotTaken({
                status: response.status,
                ...Option.match(refusal, { onNone: () => ({}), onSome: ({ code }) => ({ code }) }),
              })
            }
            return yield* response.json.pipe(
              Effect.flatMap(decode),
              Effect.mapError(() => new BugsNotTaken({ status: response.status })),
            )
          }).pipe((effect) =>
            // Interrupting the request aborts its fetch, so a stalled body stops too.
            Effect.timeoutOrElse(effect, {
              duration: options.within ?? BUGS_WITHIN,
              orElse: () => Effect.fail(new BugsNotTaken({})),
            })
          )
        return BugsClient.of({
          file: (report) =>
            exchange(
              HttpClientRequest.post(`${options.origin}${BUG_REPORTS_ROUTE}`).pipe(HttpClientRequest.bodyJsonUnsafe(report)),
              decodeFiled,
            ).pipe(Effect.withSpan("bug.file", { kind: "client" })),
          list: (limit) =>
            exchange(
              HttpClientRequest.get(`${options.origin}${BUG_REPORTS_ROUTE}${limit === undefined ? "" : `?limit=${limit}`}`),
              decodeListed,
            ).pipe(Effect.withSpan("bug.read", { kind: "client" })),
        })
      }),
    )
}
