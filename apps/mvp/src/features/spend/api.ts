import { Context, Data, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ALERT_CHANNELS_ROUTE, SANDBOX_LIMITS_ROUTE } from "./contract"
import type { SandboxLimitsRequest, SetChannelRequest } from "./schema"

// ChatApi's alert channel route as a flow step calls it (docs/features/spend-alerts.md#channels), through Effect's
// HttpClient, with one deadline covering the whole exchange.

/** How long the route gets to answer. */
export const CHANNEL_WITHIN: Duration.Input = "15 seconds"

/**
 * ChatApi didn't take the setting: no whole answer within the deadline, or no network (`status` absent), or a refusal
 * (`status`, with ChatApi's `code` when its body had one).
 */
export class ChannelNotTaken extends Data.TaggedError("ChannelNotTaken")<{
  readonly status?: number
  readonly code?: string
}> {}

const Refusal = Schema.Struct({ code: Schema.String })
const Taken = Schema.Struct({ txid: Schema.NullOr(Schema.Number) })
const decodeRefusal = Schema.decodeUnknownEffect(Refusal)
const decodeTaken = Schema.decodeUnknownEffect(Taken)

/** The alert channel route on ChatApi at `origin`. */
export class AlertsClient extends Context.Service<
  AlertsClient,
  {
    /** `POST /api/alert-channels`: set one channel's destinations; none turns it off. */
    readonly set: (request: SetChannelRequest) => Effect.Effect<void, ChannelNotTaken>
    /** `POST /api/sandbox-limits`: set the sandbox limits. */
    readonly setLimits: (request: SandboxLimitsRequest) => Effect.Effect<void, ChannelNotTaken>
  }
>()("@smthrs/mvp/spend/AlertsClient") {
  /** The client over the host's `HttpClient`: a `200` took the setting; anything else is refused. */
  static readonly layer = (options: { readonly origin: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      AlertsClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        /** One `POST` of `body` to `route`: a `200` with a transaction took it; anything else is refused. */
        const post = (route: string, body: unknown) =>
          Effect.gen(function* () {
            const response = yield* client.execute(
              HttpClientRequest.post(`${options.origin}${route}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
            ).pipe(Effect.mapError(() => new ChannelNotTaken({})))
            yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
            if (response.status !== 200) {
              const refusal = yield* response.json.pipe(Effect.flatMap(decodeRefusal), Effect.option)
              return yield* new ChannelNotTaken({
                status: response.status,
                ...Option.match(refusal, { onNone: () => ({}), onSome: ({ code }) => ({ code }) }),
              })
            }
            yield* response.json.pipe(
              Effect.flatMap(decodeTaken),
              Effect.mapError(() => new ChannelNotTaken({ status: response.status })),
            )
          }).pipe((effect) =>
            // Interrupting the request aborts its fetch, so a stalled body stops too.
            Effect.timeoutOrElse(effect, {
              duration: options.within ?? CHANNEL_WITHIN,
              orElse: () => Effect.fail(new ChannelNotTaken({})),
            })
          )
        const set = (request: SetChannelRequest) =>
          post(ALERT_CHANNELS_ROUTE, request).pipe(
            Effect.withSpan("alerts.channel.set", { kind: "client", attributes: { "smithers.channel": request.channel } }),
          )
        const setLimits = (request: SandboxLimitsRequest) =>
          post(SANDBOX_LIMITS_ROUTE, request).pipe(Effect.withSpan("sandbox.limits.set", { kind: "client" }))
        return AlertsClient.of({ set, setLimits })
      }),
    )
}
