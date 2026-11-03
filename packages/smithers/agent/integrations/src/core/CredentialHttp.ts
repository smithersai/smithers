/**
 * The HTTP client settings every credential-bearing request in this package
 * shares.
 *
 * The caller provides `HttpClient` through a layer, usually
 * `FetchHttpClient.layer`. This module narrows what that client may do with a
 * request that carries a token, a refresh token, or a client secret.
 *
 * @since 1.0.0
 */

import { Effect } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import type * as Headers from "effect/http/Headers"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"

const ANSWER_REDIRECTS: globalThis.RequestInit = { redirect: "manual" }

/**
 * `client`, configured for a request that carries a credential.
 *
 * - **Redirects are answered, not followed.** A followed redirect re-sends the
 *   credential, or the form that holds it, to whatever host its `Location`
 *   names. The fetch transport follows by default, so this sets its
 *   `RequestInit` to `redirect: "manual"`, replacing any `RequestInit` the
 *   caller provided. The other `effect` transports never follow. A client the
 *   caller wrapped in `HttpClient.followRedirects` would, so do not pass one.
 * - **No trace headers.** The `b3` and `traceparent` headers would hand our
 *   trace ids to GitHub or a token endpoint, and a browser preflight fails on
 *   them. The client span is still recorded.
 *
 * @since 1.0.0
 * @private
 */
export const forCredentials = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.transform(client, (effect) =>
    effect.pipe(
      Effect.provideService(FetchHttpClient.RequestInit, ANSWER_REDIRECTS),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false)
    ))

/**
 * The response headers as a web `Headers`, the type this package's header
 * readers take.
 *
 * @since 1.0.0
 * @private
 */
export const webHeaders = (headers: Headers.Headers): globalThis.Headers =>
  new globalThis.Headers(Object.entries(headers))

/**
 * What the transport itself reported, such as the rejection `fetch` threw,
 * rather than the client's wrapper around it.
 *
 * The wrapper's message names only the method and URL; the transport's says
 * why the request failed.
 *
 * @since 1.0.0
 * @private
 */
export const transportCause = (error: HttpClientError.HttpClientError): unknown => error.cause ?? error

/**
 * The longest server-named wait this package honors, in milliseconds, so a
 * hostile or clock-skewed header cannot park a step for hours.
 *
 * @since 1.0.0
 * @private
 */
export const MAX_RETRY_AFTER_MS = 60_000

/**
 * The response's `Retry-After` delay in milliseconds, capped at
 * {@link MAX_RETRY_AFTER_MS}, or `null` when it names none.
 *
 * Only RFC 9110 delay-seconds (`1*DIGIT`) counts: `Number` would read `""` as
 * 0 and `"0x10"` as 16, so a blank header would ask for no wait at all.
 *
 * @since 1.0.0
 * @private
 */
export const retryAfterHeader = (headers: globalThis.Headers): number | null => {
  const retryAfter = headers.get("retry-after")?.trim()
  return retryAfter !== undefined && /^\d+$/.test(retryAfter)
    ? Math.min(Number(retryAfter) * 1000, MAX_RETRY_AFTER_MS)
    : null
}
