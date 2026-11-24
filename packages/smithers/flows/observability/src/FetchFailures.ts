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

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
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
   * failure; past it the oldest is forgotten. Defaults to 256. Invalid sizes retain one.
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

type RecordResult = (record: Effect.Effect<void>) => void | Promise<void>

const instrument = (options: Options) => {
  const limit = options.remember ?? 256
  const remember = Number.isSafeInteger(limit) && limit >= 1 ? limit : 1
  const streaks = new Map<string, Streak>()

  const outcome = (key: string, route: string, method: string, status: number, failure?: StatusClass) =>
    Effect.gen(function*() {
      const before = streaks.get(key)
      streaks.delete(key)
      if (failure === undefined) {
        if (before !== undefined) {
          yield* Effect.logInfo("http.request.recovered").pipe(
            Effect.annotateLogs({ route, method, failures: before.failures })
          )
        }
        return
      }
      const attempts = (before?.failures ?? 0) + 1
      streaks.set(key, { status, failures: attempts })
      if (streaks.size > remember) streaks.delete(streaks.keys().next().value!)
      const retried = before !== undefined
      yield* Metric.update(
        Metric.withAttributes(failures, { route, method, statusClass: failure, retried: String(retried) }),
        1
      )
      if (before?.status === status) return
      yield* (failure === "5xx" ? Effect.logError : Effect.logWarning)("http.request.failed").pipe(
        Effect.annotateLogs({ route, method, status, statusClass: failure, retried, failures: attempts })
      )
    }).pipe(Effect.ignoreCause)

  return (send: typeof globalThis.fetch, recorder: () => RecordResult): typeof globalThis.fetch => {
    const observed = async (input: RequestInfo | URL, init?: RequestInit) => {
      let url: URL
      let route: string | undefined
      let method: string
      try {
        url = urlOf(input)
        route = options.route(url)
        method = methodOf(input, init)
      } catch {
        return send(input, init)
      }
      if (route === undefined) return send(input, init)
      const record = recorder()
      const key = `${method} ${url.href}`
      let response: Response
      try {
        response = await send(input, init)
      } catch (error) {
        if (signalOf(input, init)?.aborted !== true) await record(outcome(key, route, method, 0, "network"))
        throw error
      }
      await record(outcome(key, route, method, response.status, statusClass(response)))
      return response
    }
    return Object.assign(observed, send)
  }
}

/**
 * Installs the observed fetch for raw consumers. Calls from an Effect inherit the
 * requesting fiber's context; calls from a host callback inherit the layer's
 * context. Recording settles before the original HTTP result is delivered.
 *
 * @category layers
 * @since 1.0.0-rc.17
 */
export const layer = (options: Options): Layer.Layer<never> =>
  Layer.effect(
    FetchHttpClient.Fetch,
    Effect.gen(function*() {
      const send = yield* FetchHttpClient.Fetch
      const context = yield* Effect.context<never>()
      return instrument(options)(send, () => {
        const caller = Fiber.getCurrent()
        return Effect.runPromiseWith(caller ? Context.merge(context, caller.context) : context)
      })
    })
  )

/**
 * A fetch-backed HttpClient that records failures and recoveries in the fiber
 * executing each request. It uses the fetch and request options supplied by the host.
 *
 * @category layers
 * @since 1.0.0-rc.18
 */
export const layerHttpClient = (options: Options): Layer.Layer<HttpClient.HttpClient> =>
  HttpClient.layerMergedContext(Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const observe = instrument(options)
    return HttpClient.transformResponse(client, (execute) =>
      Effect.gen(function*() {
        const send = yield* FetchHttpClient.Fetch
        let observation = Effect.void
        const observed = observe(send, () => (record) => {
          observation = record
        })
        return yield* execute.pipe(
          Effect.provideService(FetchHttpClient.Fetch, observed),
          Effect.ensuring(Effect.suspend(() => observation))
        )
      }))
  })).pipe(Layer.provide(FetchHttpClient.layer))
