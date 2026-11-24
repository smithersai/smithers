/**
 * Redirect handling for requests that carry a credential.
 *
 * A fetch transport that follows a 3xx re-sends the request, and its
 * `Authorization` header, to an origin the host never named. Every credentialed
 * request this package sends therefore runs with `redirect: "manual"`, and its
 * caller refuses the 3xx instead of following it.
 *
 * @since 0.2.0
 */

import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Option from "effect/Option"

/**
 * Runs `effect` with redirect following switched off at the fetch transport,
 * keeping every other fetch default the host set.
 *
 * @category redirects
 * @since 0.2.0
 */
export const withoutRedirects = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Effect.serviceOption(FetchHttpClient.RequestInit),
    (init) =>
      Effect.provideService(effect, FetchHttpClient.RequestInit, {
        ...(Option.isSome(init) ? init.value : {}),
        redirect: "manual"
      })
  )

/**
 * Whether `status` is a redirect the transport did not follow: any 3xx, or the
 * status 0 a browser gives an opaque redirect.
 *
 * @category redirects
 * @since 0.2.0
 */
export const isRedirect = (status: number): boolean => status === 0 || (status >= 300 && status < 400)
