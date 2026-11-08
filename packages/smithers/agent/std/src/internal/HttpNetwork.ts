/**
 * Destination policy shared by the web tools, including every redirect hop.
 *
 * @since 1.0.0
 */

import { Capability, GrantStore, HttpClient as KernelHttpClient } from "@smthrs/kernel"
import { Context, Effect, Option } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as StdError from "../StdError.ts"
import * as IpAddress from "./IpAddress.ts"
import { parseHttpUrl } from "./Url.ts"

const failure = (code: StdError.Code, message: string, path: string) => new StdError.StdError({ code, message, path })

const check = Effect.fn("HttpNetwork.check")(function*(value: string, client: HttpClient.HttpClient) {
  const url = parseHttpUrl(value)
  if (url === undefined) {
    return yield* Effect.fail(failure("invalid_input", "URL must use http or https without user information", value))
  }
  if (!KernelHttpClient.supportsDestinationPinning(client)) {
    return yield* Effect.fail(failure("unsupported", "HTTP host must support destination pinning", value))
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const local = hostname.replace(/\.$/, "").toLowerCase()
  const literal = IpAddress.family(hostname) !== 0
  const localhost = local === "localhost" || local.endsWith(".localhost")
  // The host's resolver: every address must be public before an unprivileged request.
  const resolve = yield* KernelHttpClient.ResolveHost
  // Refuse localhost before DNS unless the origin is explicitly authorized.
  const privateGrant = Effect.gen(function*() {
    const store = yield* GrantStore.GrantStore
    const capability = yield* Effect.try({
      try: () => Capability.make("net:private", url.origin),
      catch: () => failure("invalid_input", "Private HTTP origin exceeds the capability resource limit", value)
    })
    yield* store.check(capability).pipe(
      Effect.mapError(() =>
        failure("permission_denied", "Private HTTP destination requires a net:private grant", value)
      )
    )
  })
  if (localhost) yield* privateGrant
  const addresses = literal ? [hostname] : [
    ...yield* resolve(hostname).pipe(
      Effect.mapError((cause) =>
        cause instanceof KernelHttpClient.ResolveHostUnavailable
          ? failure("unsupported", `HTTP host cannot resolve ${cause.hostname}: ${cause.reason}`, value)
          : failure("request_failed", "Could not resolve HTTP destination", value)
      )
    )
  ]
  if (addresses.length === 0 || addresses.some((address) => IpAddress.family(address) === 0)) {
    return yield* Effect.fail(failure("request_failed", "HTTP destination has no valid addresses", value))
  }
  if (!localhost && !addresses.every(IpAddress.isPublic)) yield* privateGrant
  return Object.freeze({ origin: url.origin, addresses: Object.freeze(addresses) })
})

/** Decorates the supplied client before following redirects through the guard.
 * The transport must honor manual redirects, as required by the kernel client.
 * @since 1.0.0
 * @private
 */
export const guarded = (
  client: HttpClient.HttpClient,
  follow = true
): HttpClient.HttpClient.With<HttpClientError.HttpClientError, GrantStore.GrantStore> => {
  const checked = HttpClient.transform(
    client,
    (execute, request) =>
      KernelHttpClient.authorizePreflight(
        request,
        check(request.url, client).pipe(
          Effect.mapError((cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause, description: cause.message })
            })
          ),
          Effect.flatMap((destination) =>
            Effect.updateContext(execute, (context: Context.Context<never>) =>
              Context.add(
                Context.add(context, KernelHttpClient.Destination, destination),
                FetchHttpClient.RequestInit,
                {
                  ...Context.getOrUndefined(context, FetchHttpClient.RequestInit),
                  redirect: "manual"
                }
              ))
          )
        )
      )
  )
  return follow ? HttpClient.followRedirects(checked) : checked
}

/** Recovers the typed refusal carried through Effect's HTTP error channel.
 * @since 1.0.0
 * @private
 */
export const refusal = (error: unknown): StdError.StdError | undefined => {
  if (!(error instanceof HttpClientError.HttpClientError) || error.reason._tag !== "TransportError") return undefined
  if (error.reason.cause instanceof StdError.StdError) return error.reason.cause
  if (Option.isSome(KernelHttpClient.fromHttpClientError(error))) {
    return failure(
      "permission_denied",
      error.reason.description ?? "HTTP permission was refused",
      error.reason.request.url
    )
  }
  return undefined
}
