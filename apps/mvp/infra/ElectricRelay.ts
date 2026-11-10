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
import { Cause, Clock, Effect, Exit, Metric } from "effect"
import { HttpServerResponse } from "effect/http"
import { categoryOf, describe, flag } from "../worker/DurableObjectFailure.ts"
import { correlationOf, RETRY_AFTER_SECONDS, unavailable } from "#vibelang/emitted/infra/ElectricAwake"

/** How long a device waits after an overloaded answer, in seconds (infra/ElectricAwake.ts). */
export { RETRY_AFTER_SECONDS }

/** What Cloudflare's runtime rejects a call into an overloaded Durable Object with (its `overloaded` property is set). */
export const isOverloaded = (error: unknown): boolean => flag(error, "overloaded")

/**
 * What Cloudflare's runtime rejects a call into a Durable Object with when the failure is transient, such as a lost
 * connection to the object or a reset of it (its `retryable` property is `true`), and not an overload, whose caller must
 * back off rather than try again at once.
 */
export const isTransient = (error: unknown): boolean => flag(error, "retryable") && !isOverloaded(error)

/** A failed call's message category (worker/DurableObjectFailure.ts), never its text. */
export { categoryOf }

/**
 * Calls into the object that failed, by `outcome` (`overloaded`, `transient`, `failed`), `errorClass`, `category`,
 * `retryable`, `overloaded`, `remote` and `table`: all fixed vocabularies, no request content.
 */
export const failures = Metric.counter("electric_gateway_failures", {
  description: "Calls from the Electric gateway into its Durable Object that failed, by outcome and Cloudflare's error flags",
  incremental: true,
})

/** The shape's table, from the gateway's canonical URL: the host's fixed name, never a parameter value. */
export const tableOf = (url: string): string | undefined =>
  new URL(url, "http://electric").searchParams.get("table") ?? undefined

/**
 * Calls the object, recording one log line `electric.gateway.request`: whether the request is live, the shape's `table`,
 * the status the gateway answers, its `outcome` (`answered`, `overloaded`, `transient`, `aborted` or `failed`) and
 * `durationMs`. A call that failed also records the error's class (`errorTag`), Cloudflare's `retryable`,
 * `overloaded` and `remote` flags (`remote`: the object's own code threw it) and the message's `category`, never its
 * text, and counts once on `failures`; one the gateway's own caller abandoned is `aborted`. `correlationId` is the proxy's generated span id, or `unavailable` for an absent or
 * invalid id; never a URL, a parameter value, arbitrary header content or a body. Its duration minus the object's own
 * (`electric.object.request`) is how long the request waited to reach the object. An overloaded object, and a call
 * Cloudflare marks retryable (`isTransient`), is answered `503` with `retry-after` and `cache-control: no-store`; any
 * other failure fails as it did, which the Worker answers 500.
 */
export const relay = <E, R>(
  call: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  live: boolean,
  requestId?: string,
  table?: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
  Effect.gen(function* () {
    const correlationId = correlationOf(requestId)
    const shape = table === undefined ? {} : { table }
    const startedAt = yield* Clock.currentTimeMillis
    const since = Effect.map(Clock.currentTimeMillis, (now) => now - startedAt)
    // What the failure handler decided for a failed call: the record the exit handler writes for it.
    let decided: { readonly outcome: "overloaded" | "transient" | "failed"; readonly error: unknown } | undefined
    /** The one record of this call, written by the exit handler whatever ended it. Never fails. */
    const record = (exit: Exit.Exit<HttpServerResponse.HttpServerResponse, E>) =>
      Effect.gen(function* () {
        const durationMs = yield* since
        const base = { correlationId, live, ...shape, durationMs }
        if (Exit.isSuccess(exit) && decided === undefined) {
          return yield* Effect.logInfo("electric.gateway.request").pipe(
            Effect.annotateLogs({ ...base, status: exit.value.status, outcome: "answered" }),
          )
        }
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
          return yield* Effect.logInfo("electric.gateway.request").pipe(
            Effect.annotateLogs({ ...base, status: 499, outcome: "aborted" }),
          )
        }
        // A failure the handler decided, or one it never saw: a caller's interruption whose cleanup failed or died.
        const { outcome, error } = decided ??
          { outcome: "failed" as const, error: Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined }
        const flags = describe(error)
        yield* Metric.update(
          Metric.withAttributes(failures, {
            outcome,
            errorClass: flags.errorTag,
            category: flags.category,
            retryable: String(flags.retryable),
            overloaded: String(flags.overloaded),
            remote: String(flags.remote),
            table: table ?? "unknown",
          }),
          1,
        )
        const line = { ...base, outcome, ...flags }
        if (outcome === "failed") {
          return yield* Effect.logError("electric.gateway.request").pipe(Effect.annotateLogs({ ...line, status: 500 }))
        }
        yield* Effect.logWarning("electric.gateway.request").pipe(Effect.annotateLogs({ ...line, status: 503 }))
      }).pipe(Effect.catchCause(() => Effect.void))
    return yield* call.pipe(
      Effect.catchCause((cause) => {
        // A cancellation passes through; the exit handler records it.
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        const error = Cause.squash(cause)
        const outcome = isOverloaded(error) ? "overloaded" : isTransient(error) ? "transient" : "failed"
        decided = { outcome, error }
        return outcome === "failed" ? Effect.failCause(cause) : Effect.succeed(unavailable())
      }),
      // Uninterruptible and run on every exit, an interruption from outside included, which the handler above never
      // sees: exactly one record per call. Interruption alone is `aborted`; any cause with a failure or defect is one.
      Effect.onExit(record),
    )
  })
