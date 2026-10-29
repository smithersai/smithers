// What the Electric gateway (infra/ElectricGateway.ts) answers for a request it admitted, and the record it keeps. Every
// shape request of every device goes through one Durable Object, which runs one request at a time on its thread. When
// requests arrive faster than it gets through them, Cloudflare refuses the call into it with "Durable Object is
// overloaded" before the object's code runs. On smithers.sh on 2026-10-26, 8 signed-out browsers at once got that as a
// 500 on about 3% of shape requests, while every request the object itself answered was a 200
// (docs/infrastructure.md#electric). Answered `503` with `retry-after`, a device keeps its rows and tries again later
// (decision 0008 §5), as it does for any shape Electric can't answer right now.
import { Cause, Clock, Effect } from "effect"
import { HttpServerResponse } from "effect/http"
import { tagOf } from "./ElectricAwake.ts"

/** How long a device waits after an overloaded answer, in seconds: about a quarter of Electric's 20 s long poll. */
export const RETRY_AFTER_SECONDS = 5

/** What Cloudflare's runtime rejects a call into an overloaded Durable Object with (its `overloaded` property is set). */
export const isOverloaded = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { readonly overloaded?: unknown }).overloaded === true

/**
 * Calls the object, recording one log line `electric.gateway.request`: whether the request is live, the status the
 * gateway answers, its `outcome` (`answered`, `overloaded` or `failed`), `durationMs`, and for a refusal or failure the
 * error's tag. `correlationId` is the proxy's generated span id, or `unavailable` for an absent or invalid id;
 * never a URL, a parameter, arbitrary header content or a body. Its duration minus the object's own
 * (`electric.object.request`) is how long the request waited to reach the object. An overloaded object is answered
 * `503` with `retry-after` and `cache-control: no-store`; any other failure fails as it did, which the Worker answers 500.
 */
export const relay = <E, R>(
  call: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  live: boolean,
  requestId?: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
  Effect.gen(function* () {
    const correlationId = requestId !== undefined && /^[a-f0-9]{16}$/.test(requestId) ? requestId : "unavailable"
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
          if (!isOverloaded(error)) {
            yield* Effect.logError("electric.gateway.request").pipe(
              Effect.annotateLogs({ correlationId, live, status: 500, outcome: "failed", durationMs, errorTag: tagOf(error) }),
            )
            return yield* Effect.failCause(cause)
          }
          yield* Effect.logWarning("electric.gateway.request").pipe(
            Effect.annotateLogs({ correlationId, live, status: 503, outcome: "overloaded", durationMs, errorTag: tagOf(error) }),
          )
          return HttpServerResponse.empty({
            status: 503,
            headers: { "retry-after": String(RETRY_AFTER_SECONDS), "cache-control": "no-store" },
          })
        })
      ),
    )
  })
