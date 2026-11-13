import { Context, Data, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { SandboxTools } from "@smthrs/sandbox"
import { SANDBOX_CALLS_ROUTE } from "./contract"
import { Refused, Standing } from "./schema"

// ChatApi's sandbox call routes as the tools' steps call them (docs/features/sandbox-tools.md#the-routes), through
// Effect's HttpClient, with one deadline covering each exchange.

/** ChatApi didn't take or answer the call: a refusal (`status`, `code`, optional `maxSeconds`), or no whole answer in time. */
export class CallRefused extends Data.TaggedError("CallRefused")<{
  readonly status?: number
  readonly code?: string
  readonly maxSeconds?: number
}> {}

/** How long one request may take. The machine runs the tool after, in the remote `sandbox/Call`. */
export const REQUEST_WITHIN = "15 seconds"

const decodeRefused = Schema.decodeUnknownOption(Schema.fromJsonString(Refused))
const decodeStanding = Schema.decodeUnknownEffect(Standing)

/** Whom a call is for: the conversation the person's tab showed, or the agent's answer. */
export type Target = { readonly conversationId: string } | { readonly answerId: string }

/** Runs sandbox tools through ChatApi on `origin`. */
export class SandboxClient extends Context.Service<
  SandboxClient,
  {
    /** Starts call `callId`, or reads how it stands when it started before: `202` running, `200` as it stands. */
    readonly start: (
      request: { readonly callId: string; readonly call: SandboxTools.Call; readonly save?: boolean } & Target,
    ) => Effect.Effect<Standing, CallRefused>
    /** How call `callId` stands. */
    readonly result: (callId: string) => Effect.Effect<Standing, CallRefused>
  }
>()("@smthrs/mvp/sandbox/SandboxClient") {
  /** The client over the host's `HttpClient`. */
  static readonly layer = (options: { readonly origin: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      SandboxClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const exchange = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.gen(function* () {
            const response = yield* client.execute(request).pipe(Effect.mapError(() => new CallRefused({})))
            yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
            if (response.status !== 200 && response.status !== 202) {
              const body = decodeRefused(yield* Effect.orElseSucceed(response.text, () => ""))
              return yield* new CallRefused({
                status: response.status,
                ...Option.match(body, { onNone: () => ({}), onSome: (refused) => refused }),
              })
            }
            return yield* response.json.pipe(
              Effect.flatMap(decodeStanding),
              Effect.mapError(() => new CallRefused({ status: response.status })),
            )
          }).pipe((effect) =>
            Effect.timeoutOrElse(effect, {
              duration: options.within ?? REQUEST_WITHIN,
              orElse: () => Effect.fail(new CallRefused({})),
            })
          )
        return SandboxClient.of({
          start: Effect.fn("sandbox.call.post")(function* (request) {
            return yield* exchange(
              HttpClientRequest.post(`${options.origin}${SANDBOX_CALLS_ROUTE}`).pipe(
                HttpClientRequest.bodyJsonUnsafe(request),
              ),
            )
          }),
          result: Effect.fn("sandbox.call.result")(function* (callId) {
            return yield* exchange(HttpClientRequest.get(`${options.origin}${SANDBOX_CALLS_ROUTE}/${callId}`))
          }),
        })
      }),
    )
}
