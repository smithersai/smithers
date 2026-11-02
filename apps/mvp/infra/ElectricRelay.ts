// What the Electric gateway (infra/ElectricGateway.ts) answers for a request it admitted, and the record it keeps. Every
// shape request of every device goes through one Durable Object, which runs one request at a time on its thread. When
// requests arrive faster than it gets through them, Cloudflare refuses the call into it with "Durable Object is
// overloaded" before the object's code runs. On smithers.sh on 2026-10-26, 8 signed-out browsers at once got that as a
// 500 on about 3% of shape requests, while every request the object itself answered was a 200
// (docs/infrastructure.md#electric). Answered `503` with `retry-after`, a device keeps its rows and tries again later
// (decision 0008 §5), as it does for any shape Electric can't answer right now.
//
// Cloudflare also marks a call that failed for a passing reason `retryable` (Durable Objects: Error handling), as when
// the gateway's connection to the object drops mid-call. On smithers.sh on 2026-11-02 at 10:00:07Z, 17 held live shape
// requests from two colos failed that way at once: the object recorded each as `clientDisconnected`, the gateway
// answered each 500, and every page holding one counted an error. 12:49:58Z and 13:35:11Z did the same to 1 and 2
// (docs/infrastructure.md#electric). Such a call is answered as an overloaded one.
import { Cause, Clock, Effect } from "effect"
import { HttpServerResponse } from "effect/http"
import { correlationOf, RETRY_AFTER_SECONDS, tagOf, unavailable } from "./ElectricAwake.ts"

/** How long a device waits after an overloaded answer, in seconds (infra/ElectricAwake.ts). */
export { RETRY_AFTER_SECONDS }

/** What Cloudflare's runtime rejects a call into an overloaded Durable Object with (its `overloaded` property is set). */
export const isOverloaded = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { readonly overloaded?: unknown }).overloaded === true

/**
 * What Cloudflare's runtime rejects a call into a Durable Object with when the failure is transient, such as a lost
 * connection to the object or a reset of it (its `retryable` property is `true`), and not an overload, whose caller must
 * back off rather than try again at once.
 */
export const isTransient = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { readonly retryable?: unknown }).retryable === true &&
  !isOverloaded(error)

/**
 * Calls the object, recording one log line `electric.gateway.request`: whether the request is live, the status the
 * gateway answers, its `outcome` (`answered`, `overloaded`, `transient` or `failed`), `durationMs`, and for a refusal or failure the
 * error's tag. `correlationId` is the proxy's generated span id, or `unavailable` for an absent or invalid id;
 * never a URL, a parameter, arbitrary header content or a body. Its duration minus the object's own
 * (`electric.object.request`) is how long the request waited to reach the object. An overloaded object, and a call
 * Cloudflare marks retryable (`isTransient`), is answered `503` with `retry-after` and `cache-control: no-store`; any
 * other failure fails as it did, which the Worker answers 500.
 */
export const relay = <E, R>(
  call: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  live: boolean,
  requestId?: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
  Effect.gen(function* () {
    const correlationId = correlationOf(requestId)
    const startedAt = yield* Clock.currentTimeMillis
    const since = Effect.map(Clock.currentTimeMillis, (now) => now - startedAt)
    return yield* call.pipe(
      Effect.tap((response) =>
        Effect.flatMap(since, (durationMs) =>
          Effect.logInfo("electric.gateway.request").pipe(
            Effect.annotateLogs({ correlationId, live, status: response.status, outcome: "answered", durationMs }),
          )
        )
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const error = Cause.squash(cause)
          const durationMs = yield* since
          const outcome = isOverloaded(error) ? "overloaded" : isTransient(error) ? "transient" : "failed"
          if (outcome === "failed") {
            yield* Effect.logError("electric.gateway.request").pipe(
              Effect.annotateLogs({ correlationId, live, status: 500, outcome, durationMs, errorTag: tagOf(error) }),
            )
            return yield* Effect.failCause(cause)
          }
          yield* Effect.logWarning("electric.gateway.request").pipe(
            Effect.annotateLogs({ correlationId, live, status: 503, outcome, durationMs, errorTag: tagOf(error) }),
          )
          return unavailable()
        })
      ),
    )
  })
