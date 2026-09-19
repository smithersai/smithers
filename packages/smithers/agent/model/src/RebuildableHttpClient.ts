/**
 * A stable HTTP client over a replaceable, scoped connection pool.
 *
 * @since 1.0.0
 */
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import { Effect, Option, ScopedRef, Semaphore } from "effect"
import type * as Scope from "effect/Scope"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

/**
 * Acquires a client and replaces it before the next request after a transport
 * failure. The caller owns retries: a failed request is never replayed here.
 *
 * Each acquisition owns its resources in a fresh scope. Replacement acquires
 * the new client before closing the old pool; host teardown closes the last.
 * A generation check keeps late failures on a discarded pool from invalidating
 * its successor. HTTP statuses and kernel permission refusals leave it alone.
 *
 * Compose capability middleware above this client to check every request and
 * redirect, including requests on replacement pools.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  acquire: Effect.Effect<HttpClient.HttpClient, never, Scope.Scope>
): Effect.Effect<HttpClient.HttpClient, never, Scope.Scope> =>
  Effect.gen(function*() {
    const held = yield* ScopedRef.fromAcquire(acquire)
    const gate = yield* Semaphore.make(1)
    let generation = 0
    let failed = false
    const current = gate.withPermit(
      Effect.gen(function*() {
        if (failed) {
          yield* ScopedRef.set(held, acquire)
          generation += 1
          failed = false
        }
        return { client: yield* ScopedRef.get(held), generation }
      }).pipe(Effect.uninterruptible)
    )

    return HttpClient.makeWith(
      (request: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpClientError.HttpClientError>) =>
        Effect.gen(function*() {
          const wire = yield* request
          const on = yield* current
          return yield* on.client.execute(wire).pipe(Effect.tapError((error) =>
            Effect.sync(() => {
              if (
                on.generation === generation && error.reason._tag === "TransportError" &&
                Option.isNone(KernelHttpClient.fromHttpClientError(error))
              ) failed = true
            })
          ))
        }),
      Effect.succeed
    )
  })
