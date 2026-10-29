// Workers Cache runs before the private gateway and uses the SDK's canonical upstream URL plus Worker version.
// ChatApi authorizes the exact shape before this boundary; person scopes remain in its definition parameters.
// Only the private hop retains Electric's public TTL. ShapeProxy still answers browsers private, no-store.
// The deployed S5b trial and its limits are recorded in decision 0114; edge collapse is not emulated in workerd.
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { admit } from "./ElectricAccess.ts"
import { isLive } from "./ElectricAwake.ts"
import { relay } from "./ElectricRelay.ts"

/** What the gateway's response says when Workers Cache must not keep it. */
export const NO_STORE = "no-store"

/** SSE is unbounded and must never enter the finite-response cache. */
export const enabledFor = (url: string): boolean => {
  const params = new URL(url, "http://electric").searchParams
  return params.get("live_sse") !== "true" && params.get("experimental_live_sse") !== "true"
}

/**
 * The `cache-control` the gateway answers Electric's response with. Electric marks the responses a CDN may keep
 * `public` with their own lifetimes (Electric: HTTP API, Caching): an initial read for an hour, a catch-up read for a
 * minute, a live long poll for 5 s keyed by its `cursor`, so identical live polls collapse into one. Those pass
 * through. Everything else is `no-store`: any status but 200 (a 409 must-refetch, a refusal, an overload, an error,
 * which must reach Electric again), and a 200 that Electric didn't mark `public`, which Workers Cache would otherwise
 * keep for its heuristic lifetime of 2 hours.
 */
export const cacheControl = (
  status: number,
  electric: string | undefined,
): string => {
  if (status !== 200 || electric === undefined) return NO_STORE
  const directives = electric.toLowerCase().split(",").map((directive) => directive.trim())
  const forbidden = directives.some((directive) => /^(private|no-store|no-cache)(=|$)/.test(directive))
  return directives.includes("public") && !forbidden ? electric : NO_STORE
}

/** `response` to a live request or not, with the `cache-control` the gateway answers it with (`cacheControl`). */
export const cachePolicy = (
  response: HttpServerResponse.HttpServerResponse,
  enabled = true,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setHeader(response, "cache-control", enabled ? cacheControl(response.status, headerOf(response)) : NO_STORE)

/** Electric's `cache-control`, from the response's own headers or, for a raw web `Response`, from its headers. */
const headerOf = (response: HttpServerResponse.HttpServerResponse): string | undefined => {
  const own = response.headers["cache-control"]
  if (own !== undefined) return own
  const body = response.body
  if (body._tag === "Raw" && body.body instanceof Response) return body.body.headers.get("cache-control") ?? undefined
  return undefined
}

/** The private entrypoint, with the host's object transport injected; admission and policy stay in one tested path. */
export const serve = <E, R>(
  fetch: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const admission = admit(yield* HttpServerRequest.HttpServerRequest)
    if (admission._tag === "Refused") return HttpServerResponse.empty({ status: admission.status, headers: { "cache-control": NO_STORE } })
    const response = yield* relay(fetch(admission.request), isLive(admission.request.url), admission.request.headers["x-request-id"])
    return cachePolicy(response, enabledFor(admission.request.url))
  })
