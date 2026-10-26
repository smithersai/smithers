import { Context, Data, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { RUNS_ROUTE, RUNS_WITHIN } from "./contract"
import { Refusal, type Report, type RunAnswer, Written } from "./schema"

// ChatApi's runs routes as a flow step calls them (docs/features/agent-status.md#the-routes), through Effect's
// HttpClient, with one deadline covering the whole exchange.

/**
 * ChatApi didn't take the write: no whole answer within the deadline, or no network (`status` absent), or a refusal
 * (`status`, with ChatApi's `code` when its body had one).
 */
export class RunsRefused extends Data.TaggedError("RunsRefused")<{
  readonly reason?: "unreachable" | "timeout"
  readonly status?: number
  readonly code?: string
}> {}

const decodeRefusal = Schema.decodeUnknownEffect(Refusal)
const decodeWritten = Schema.decodeUnknownEffect(Written)

/** The runs routes on ChatApi at `origin`. */
export class RunsClient extends Context.Service<
  RunsClient,
  {
    /** `POST /api/runs/<runId>`: the run's status. */
    readonly report: (runId: string, report: Report) => Effect.Effect<void, RunsRefused>
    /** `POST /api/runs/<runId>/answer`: the person's answer to the run's open question. */
    readonly answer: (runId: string, answer: RunAnswer) => Effect.Effect<void, RunsRefused>
  }
>()("@smthrs/mvp/status/RunsClient") {
  /** The client over the host's `HttpClient`: a `200` took the write; anything else is refused. */
  static readonly layer = (options: { readonly origin: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      RunsClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const post = (path: string, body: unknown) =>
          Effect.suspend(() => {
            let written = false
            // ChatApi took the write (200), but its receipt was unreadable or didn't arrive in time.
            const malformed = (errorCode: "decode" | "timeout_after_200") =>
              Effect.logWarning("agent.status.malformed").pipe(
                Effect.annotateLogs({ feature: "status", status: 200, outcome: "malformed", errorCode }),
              )
            return Effect.gen(function* () {
              const response = yield* client.execute(
                HttpClientRequest.post(`${options.origin}${RUNS_ROUTE}/${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
              ).pipe(Effect.mapError(() => new RunsRefused({ reason: "unreachable" })))
              written = response.status === 200
              yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
              if (response.status !== 200) {
                const refusal = yield* response.json.pipe(Effect.flatMap(decodeRefusal), Effect.option)
                return yield* new RunsRefused({
                  status: response.status,
                  ...Option.match(refusal, { onNone: () => ({}), onSome: ({ code }) => ({ code }) }),
                })
              }
              yield* response.json.pipe(
                Effect.flatMap(decodeWritten),
                Effect.catch(() => malformed("decode")),
              )
            }).pipe((effect) =>
              // Interrupting the request aborts its fetch, so a stalled body stops too.
              Effect.timeoutOrElse(effect, {
                duration: options.within ?? RUNS_WITHIN,
                orElse: () => written ? malformed("timeout_after_200") : Effect.fail(new RunsRefused({ reason: "timeout" })),
              })
            )
          })
        return RunsClient.of({
          report: (runId, report) =>
            post(runId, report).pipe(
              Effect.withSpan("agent.status.report", { kind: "client", attributes: { "smithers.run.id": runId } }),
            ),
          answer: (runId, answer) =>
            post(`${runId}/answer`, answer).pipe(
              Effect.withSpan("agent.status.answer", { kind: "client", attributes: { "smithers.run.id": runId } }),
            ),
        })
      }),
    )
}
