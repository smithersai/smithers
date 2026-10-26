/**
 * Records every request a program's `fetch` sends that fails: by its route
 * template, its status class and whether it repeats a request that failed.
 *
 * {@link layer} wraps the `fetch` in Effect's `FetchHttpClient.Fetch`, which
 * Effect's `HttpClient` and anything else that reads that reference (such as
 * `@smthrs/effect-electric`'s shape source) send through. So a program that
 * retries quietly, as a sync client does, still leaves a record: each failed
 * request adds one to {@link failures}, and a run of failures of one request
 * writes two log lines, `http.request.failed` when it starts (and again when
 * its status changes) and `http.request.recovered` when the request succeeds
 * again, instead of a line per retry.
 *
 * Nothing it records can carry a URL's private parts: a request is named by
 * the template the program's `route` gives it, never its path or query, and
 * the request's full URL is kept in memory only to tell a retry from a first
 * failure.
 *
 * @since 1.0.0-rc.17
 */

import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"

/**
 * Which requests {@link layer} records, and how it names them.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Options {
  /**
   * The route template of a request it records, such as
   * `/api/repos/:owner/:repo/stack`, or `undefined` for a request it leaves
   * alone, such as the exporter's own. The template is a record's only name
   * for the request, so it must hold no id, name or query value.
   */
  readonly route: (url: URL) => string | undefined
  /**
   * How many requests' failures it remembers to tell a retry from a first
   * failure; past it the oldest is forgotten. Defaults to 256.
   */
  readonly remember?: number | undefined
}

/**
 * A failed request's status class: `4xx`, `5xx`, or `network` when no answer
 * came (the request failed on the network, or was answered with status 0).
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type StatusClass = "4xx" | "5xx" | "network"

/**
 * Failed requests, by `route`, `method`, `statusClass` and `retried` (`true`
 * when the same request failed before and had not succeeded since).
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const failures = Metric.counter("flows_observability_http_failures", {
  description: "Failed HTTP requests, by route template, method, status class and whether they repeat a failed one",
  incremental: true
})

/**
 * The status class of a response's status, or `undefined` when it didn't
 * fail: below 400, or an opaque redirect a caller asked to see (status 0 with
 * `redirect: "manual"`).
 *
 * @category utilities
 * @since 1.0.0-rc.17
 */
export const statusClass = (response: Pick<Response, "status" | "type">): StatusClass | undefined =>
  response.type === "opaqueredirect"
    ? undefined
    : response.status === 0
    ? "network"
    : response.status >= 500
    ? "5xx"
    : response.status >= 400
    ? "4xx"
    : undefined

interface Streak {
  readonly status: number
  readonly failures: number
}

const methodOf = (input: RequestInfo | URL, init: RequestInit | undefined): string =>
  (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase()

// A relative request resolves against the page's location where there is one, as `fetch` resolves it.
const base = (): string => {
  const location = (globalThis as { readonly location?: { readonly href?: unknown } }).location
  return typeof location?.href === "string" ? location.href : "http://localhost"
}

const urlOf = (input: RequestInfo | URL): URL =>
  new URL(typeof input === "object" && "url" in input ? input.url : String(input), base())

const signalOf = (input: RequestInfo | URL, init: RequestInit | undefined): AbortSignal | null | undefined =>
  init?.signal ?? (typeof input === "object" && "signal" in input ? input.signal : undefined)

/**
 * Replaces the `fetch` in `FetchHttpClient.Fetch` with one that records the
 * failures of the requests `route` names, through the services the layer is
 * built with: its loggers and its metrics. A request its caller aborted is
 * not a failure.
 *
 * Provide it above the exporter's layer, so the exporter keeps the `fetch`
 * below and its own requests are never recorded through themselves.
 *
 * @category layers
 * @since 1.0.0-rc.17
 */
export const layer = (options: Options): Layer.Layer<never> =>
  Layer.effect(
    FetchHttpClient.Fetch,
    Effect.gen(function*() {
      const send = yield* FetchHttpClient.Fetch
      const run = Effect.runSyncWith(yield* Effect.context<never>())
      const remember = Math.max(1, Math.floor(options.remember ?? 256))
      // A request by its method and full URL, whose last answer was a failure. In memory only.
      const streaks = new Map<string, Streak>()

      const failed = (key: string, route: string, method: string, status: number, statusClass: StatusClass) => {
        const before = streaks.get(key)
        streaks.delete(key)
        streaks.set(key, { status, failures: (before?.failures ?? 0) + 1 })
        if (streaks.size > remember) streaks.delete(streaks.keys().next().value!)
        const retried = before !== undefined
        run(Effect.gen(function*() {
          yield* Metric.update(Metric.withAttributes(failures, { route, method, statusClass, retried: String(retried) }), 1)
          if (before !== undefined && before.status === status) return
          // A 5xx is the server's failure; a 4xx is the request's, and no answer is most often a device offline.
          yield* (statusClass === "5xx" ? Effect.logError : Effect.logWarning)("http.request.failed").pipe(
            Effect.annotateLogs({ route, method, status, statusClass, retried, failures: (before?.failures ?? 0) + 1 })
          )
        }))
      }

      const succeeded = (key: string, route: string, method: string) => {
        const before = streaks.get(key)
        if (before === undefined) return
        streaks.delete(key)
        run(Effect.logInfo("http.request.recovered").pipe(
          Effect.annotateLogs({ route, method, failures: before.failures })
        ))
      }

      const observed = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input)
        const route = options.route(url)
        if (route === undefined) return send(input, init)
        const method = methodOf(input, init)
        const key = `${method} ${url.href}`
        return send(input, init).then(
          (response) => {
            const failure = statusClass(response)
            if (failure === undefined) succeeded(key, route, method)
            else failed(key, route, method, response.status, failure)
            return response
          },
          (error: unknown) => {
            if (signalOf(input, init)?.aborted !== true) failed(key, route, method, 0, "network")
            throw error
          }
        )
      }) as typeof globalThis.fetch
      return Object.assign(observed, send)
    })
  )
