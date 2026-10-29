/**
 * A server-side proxy for Electric shape requests, as an `effect/http`
 * handler.
 *
 * A browser that syncs with Electric should reach it through your own server,
 * so Electric's URL and secret stay there and the server, not the browser,
 * decides what a request may read. `make` returns a handler for one shape.
 * Mount it on a route such as `GET /api/shapes/items`. It:
 *
 * - forwards only the Electric client's protocol parameters, so a browser
 *   can follow the shape but not change it;
 * - sets the table, and optionally a `where`, its `params` and the `columns`
 *   a browser receives, from the host, fixed or decided per request; a host
 *   that can't decide refuses the request (`Refused`) rather than serve
 *   another shape under the same URL;
 * - drops every other parameter, subset requests' (`subset__*`) included, so
 *   a browser reads the whole shape or nothing;
 * - adds Electric's `secret`, as a parameter or a bearer token, and Electric
 *   Cloud's `source_id`;
 * - sends one canonical URL per request (parameters sorted by name, each
 *   encoded once), so the same shape at the same point of its log is the same
 *   URL whatever order the browser sent, for a cache between the proxy and
 *   Electric to key on;
 * - calls Electric with the host's `Upstream` client when it provides one,
 *   for example a platform's private binding to Electric's gateway;
 * - tells browsers and CDNs not to keep a response (`cache-control: private,
 *   no-store`), unless the host opts a public shape in with `cache`;
 * - records one span, one log line and one count per request with plain
 *   Effect, so the host's own logger, tracer and metric exporters pick them up.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"

/**
 * Where Electric is, and the credentials the proxy adds to every request.
 * `url` is Electric's origin; the proxy calls its `/v1/shape`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Connection {
  readonly url: string
  /** Electric's secret, sent as `secretAs` says. */
  readonly secret?: Redacted.Redacted<string> | undefined
  /**
   * How `secret` is sent: `"parameter"` (the default) or `"bearer"`.
   *
   * @since 0.2.0
   */
  readonly secretAs?: SecretAs | undefined
  /** Electric Cloud's source id, sent as `source_id`. */
  readonly sourceId?: string | undefined
}

/**
 * How the proxy sends Electric's secret.
 *
 * - `"parameter"`, the default: as Electric's `secret` query parameter, the
 *   only way Electric itself takes it.
 * - `"bearer"`: as `authorization: Bearer <secret>`, for an Electric behind
 *   your own gateway that checks the header and doesn't pass it on. A URL is
 *   what platforms log and trace (Cloudflare's invocation logs and its
 *   subrequest spans' `url.full` and `url.query`); an `authorization` header
 *   is not.
 *
 * @category models
 * @since 0.2.0
 */
export type SecretAs = "parameter" | "bearer"

/**
 * The shape every request reads, chosen by the host. `where` and `params`
 * narrow it for every request, for example to one account's rows, and
 * `columns` to the columns a browser may see.
 *
 * @category models
 * @since 0.1.0
 */
export interface Shape {
  readonly table: string
  readonly where?: string | undefined
  /** The values of `where`'s `$1`, `$2`, ... placeholders, keyed `"1"`, `"2"`, ... */
  readonly params?: Readonly<Record<string, string>> | undefined
  /**
   * The only columns Electric sends, sent as `columns`; every column when
   * omitted. Name each as Electric quotes it, and include the primary key.
   * A column added to the table later stays on the server until the host
   * lists it.
   *
   * @since 0.2.0
   */
  readonly columns?: ReadonlyArray<string> | undefined
}

/**
 * Whether a browser or CDN may keep a shape's responses.
 *
 * - `"no-store"`, the default: every response carries `cache-control:
 *   private, no-store`, and Electric's `cache-control`, `etag`,
 *   `surrogate-control`, `cdn-cache-control` and `expires` are dropped. Use it
 *   for every shape whose rows depend on who asks: a `where` built from the
 *   session, or a shape served only after a session check. The browser's URL
 *   doesn't name the person, so a cached response would answer the next
 *   person in that browser, or anyone after sign-out.
 * - `"public"`: Electric's caching headers pass through, for a shape that is
 *   the same for everyone and served without a session check.
 *
 * @category models
 * @since 0.2.0
 */
export type Cache = "no-store" | "public"

/**
 * A host's refusal to serve a shape for one request, from a `shape` Effect:
 * `401` signed out, `403` not allowed, `503` when the host can't tell right
 * now, for example because its session store is down. The proxy answers it
 * without calling Electric, with `retry-after: retryAfter` (seconds) when
 * set.
 *
 * Refuse rather than serve a narrower shape under the same URL. A device
 * holds the shape's `handle` and `offset`, and a definition that changes
 * under them makes Electric answer `409 must-refetch`, which empties the
 * device's copy. On a refusal the device keeps its rows: an Electric
 * collection retries a `503` under its sync policy and stops on a `401` or
 * `403`.
 *
 * @category errors
 * @since 0.2.0
 */
export class Refused extends Data.TaggedError("Refused")<{
  readonly status: 401 | 403 | 503
  readonly retryAfter?: number | undefined
  /** The failed dependency when the host cannot decide access; defaults to `access`. */
  readonly upstream?: "database" | "access" | undefined
}> {}

/**
 * Everything `make` needs: Electric's connection, the shape, whether its
 * responses may be kept (`cache`, default `"no-store"`), and optionally the
 * name of its span and log line (default `electric.shape`) and the counter it
 * updates (default `electric_shape_requests`).
 *
 * `shape` is fixed, or an Effect that decides it for each request, after the
 * method check and before Electric is called, and may fail with `Refused`.
 * Its requirements `R` become the handler's.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options<R = never> extends Connection {
  readonly shape: Shape | Effect.Effect<Shape, Refused, R>
  /**
   * Whether a browser or CDN may keep the shape's responses; `"no-store"`
   * unless the host opts a public shape in.
   *
   * @since 0.2.0
   */
  readonly cache?: Cache | undefined
  readonly name?: string | undefined
  readonly metric?: Metric.Counter<number> | undefined
}

// How a request ended: its response sent in full; `aborted` by the browser, before Electric answered (status 499) or
// mid-body; or `failed` reading Electric's body.
type Outcome = "complete" | "aborted" | "failed"

// The Electric client's protocol parameters: the only browser parameters the proxy forwards. Every other one is
// dropped, a subset request's `subset__*` included.
const protocolParameters: ReadonlyArray<string> = [
  "offset",
  "handle",
  "live",
  "live_sse",
  "experimental_live_sse",
  "cursor",
  "expired_handle",
  "log",
  "cache-buster"
]

/**
 * The `HttpClient` the proxy calls Electric with, when the host provides one;
 * otherwise the proxy uses the request's own `HttpClient`.
 *
 * Provide it when Electric is reached another way than the rest of the
 * host's requests, for example through a platform's private binding to a
 * gateway in front of Electric, while every other call keeps the host's
 * `HttpClient`.
 *
 * @category services
 * @since 0.2.0
 */
export class Upstream extends Context.Service<Upstream, HttpClient.HttpClient>()(
  "@smthrs/effect-electric/ShapeProxy/Upstream"
) {}

/**
 * The counter `make` updates when `Options.metric` is omitted:
 * `electric_shape_requests`, by `status` and `live`.
 *
 * @category observability
 * @since 0.1.0
 */
export const defaultMetric: Metric.Counter<number> = Metric.counter("electric_shape_requests", {
  description: "Electric shape requests the proxy answered, by status and live",
  incremental: true
})

/**
 * Responses across all shapes, by the host's fixed name and HTTP status class.
 *
 * @category observability
 * @since 0.1.0
 */
export const responses = Metric.counter("electric_shape_responses", { incremental: true })

/**
 * Reads Electric's connection from `ELECTRIC_URL`, `ELECTRIC_SECRET` (as a
 * redacted value), `ELECTRIC_SECRET_AS` (`parameter` or `bearer`) and
 * `ELECTRIC_SOURCE_ID`. `url` is the default for `ELECTRIC_URL`; without one,
 * `ELECTRIC_URL` is required.
 *
 * @category configuration
 * @since 0.1.0
 */
export const config = (options: { readonly url?: string } = {}): Config.Config<Connection> =>
  Config.all({
    url: options.url === undefined
      ? Config.String("ELECTRIC_URL")
      : Config.String("ELECTRIC_URL").pipe(Config.withDefault(options.url)),
    secret: Config.option(Config.Redacted("ELECTRIC_SECRET")),
    secretAs: Config.option(Config.Literals(["parameter", "bearer"], "ELECTRIC_SECRET_AS")),
    sourceId: Config.option(Config.String("ELECTRIC_SOURCE_ID"))
  }).pipe(Config.map(({ url, secret, secretAs, sourceId }) => ({
    url,
    secret: Option.getOrUndefined(secret),
    secretAs: Option.getOrUndefined(secretAs),
    sourceId: Option.getOrUndefined(sourceId)
  })))

/**
 * Electric's headers that aren't passed on: `fetch` has already decoded the
 * body, so its encoding and length no longer hold, and the proxy is the
 * browser's own origin, so Electric's CORS headers would only open it to
 * other sites.
 */
const dropped = (name: string) =>
  name === "content-encoding" || name === "content-length" || name.startsWith("access-control-")

/** Electric's headers that let a browser or CDN keep a response; a `"no-store"` shape drops them. */
const caching: ReadonlySet<string> = new Set([
  "cache-control",
  "etag",
  "surrogate-control",
  "cdn-cache-control",
  "expires"
])

/** What a `"no-store"` shape's every response says instead. */
const noStore = { "cache-control": "private, no-store" } as const

/**
 * The handler for one shape. Requires the `HttpServerRequest` it answers and
 * the `HttpClient` it calls Electric with, unless the context holds an
 * `Upstream`, which the proxy calls instead.
 *
 * - `GET` only; another method is 405.
 * - The browser's parameters outside the Electric client's protocol are
 *   dropped, never forwarded: the shape's own (`table`, `where`, `params`,
 *   `columns`, `replica`), the credentials, and a subset request's
 *   `subset__*`.
 * - Electric's URL is canonical: the first value of each protocol parameter
 *   and the host's shape and credentials, sorted by name and each encoded
 *   once, so two requests for the same shape at the same `handle`, `offset`
 *   and `cursor` send the same URL, and two different shapes never do.
 * - A `shape` Effect that fails with `Refused` is answered with its status,
 *   and Electric is never called.
 * - Electric unreachable is 502. Otherwise Electric's status, headers and body
 *   stream back.
 * - A refusal, and unless `cache` is `"public"` every other response, a 405
 *   and a 502 included, carries `cache-control: private, no-store` in place
 *   of Electric's caching
 *   headers. Electric's `cursor` and `cache-buster` already keep its protocol
 *   correct without a cache.
 *
 * Each request records one span, `name`, and once its body has ended one log
 * line, `name`, and one count on `metric`. None of them carries the secret, a
 * where clause or a parameter value.
 *
 * @category handlers
 * @since 0.1.0
 */
export const make = <R = never>(
  options: Options<R>
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | HttpClient.HttpClient | R
> => {
  const name = options.name ?? "electric.shape"
  const metric = options.metric ?? defaultMetric
  const shapeUrl = new URL("/v1/shape", options.url).toString()
  const keeps = options.cache === "public"
  const own = keeps ? {} : noStore

  /** Records a request once it has ended: its count and one log line. */
  const record = (request: {
    readonly status: number
    readonly live: boolean
    readonly phase: "first" | "catch-up" | "live"
    readonly startedAt: number
    readonly bytes: number
    readonly outcome: Outcome
    readonly correlationId: string
    readonly upstream: string
  }) =>
    Effect.gen(function*() {
      const { status, live, phase, bytes, outcome } = request
      const { correlationId, upstream } = request
      const statusClass = `${Math.floor(status / 100)}xx`
      yield* Metric.update(Metric.withAttributes(responses, { name, statusClass }), 1)
      const durationMs = (yield* Clock.currentTimeMillis) - request.startedAt
      yield* Metric.update(Metric.withAttributes(metric, { status: String(status), live: String(live) }), 1)
      const level = status >= 500 || outcome === "failed"
        ? "Error"
        : status >= 400 && outcome !== "aborted"
        ? "Warn"
        : "Info"
      yield* Effect.logWithLevel(level)(name).pipe(
        Effect.annotateLogs({
          route: name,
          correlationId,
          upstream,
          status,
          statusClass,
          live,
          phase,
          durationMs,
          bytes,
          outcome
        })
      )
    })

  return Effect.gen(function*() {
    const span = yield* Effect.orDie(Effect.currentSpan)
    const correlationId = span.spanId
    const ownHeaders = { ...own, "x-request-id": correlationId }
    const request = yield* HttpServerRequest.HttpServerRequest
    const startedAt = yield* Clock.currentTimeMillis
    const incoming = new URL(request.url, "http://localhost").searchParams
    const live = incoming.get("live") === "true"
    const phase = live ? "live" : incoming.get("offset") === "-1" ? "first" : "catch-up"
    const answered = (status: number, upstream: string) =>
      Effect.annotateCurrentSpan({
        "http.response.status_code": status,
        "electric.shape.live": live,
        "electric.shape.phase": phase,
        route: name,
        correlationId,
        upstream
      })
    const ended = (status: number, upstream: string, outcome: Outcome = "complete") =>
      Effect.andThen(
        answered(status, upstream),
        record({ status, live, phase, startedAt, bytes: 0, outcome, correlationId, upstream })
      )

    if (request.method !== "GET") {
      yield* ended(405, "proxy")
      return HttpServerResponse.empty({ status: 405, headers: { allow: "GET", ...ownHeaders } })
    }

    const decided = yield* Effect.result(Effect.isEffect(options.shape) ? options.shape : Effect.succeed(options.shape))
      .pipe(
        Effect.catchDefect(() => Effect.succeed(undefined)),
        Effect.onInterrupt(() => ended(499, "access", "aborted"))
      )
    if (decided === undefined) {
      yield* ended(500, "access")
      return HttpServerResponse.empty({ status: 500, headers: ownHeaders })
    }
    if (Result.isFailure(decided)) {
      const { status, retryAfter } = decided.failure
      yield* ended(status, decided.failure.upstream ?? "access")
      return HttpServerResponse.empty({
        status,
        headers: {
          ...noStore,
          "x-request-id": correlationId,
          ...(retryAfter === undefined ? {} : { "retry-after": String(retryAfter) })
        }
      })
    }
    const shape = decided.success

    // The first value of each protocol parameter, then the host's shape and credentials. The two sets of names never
    // overlap, so every name appears once and sorting them gives one URL per request whatever the browser's order.
    const parameters: Array<readonly [string, string | Redacted.Redacted<string>]> = []
    for (const [key, value] of incoming) {
      if (protocolParameters.includes(key) && !parameters.some(([name]) => name === key)) parameters.push([key, value])
    }
    parameters.push(
      ["table", shape.table],
      ...(shape.where === undefined ? [] : [["where", shape.where] as const]),
      ...Object.entries(shape.params ?? {}).map(([key, value]) => [`params[${key}]`, value] as const),
      ...(shape.columns === undefined ? [] : [["columns", shape.columns.join(",")] as const]),
      // Redacted, so the client span's `url.full` shows `secret=REDACTED`; the request carries the value.
      ...(options.secret === undefined || options.secretAs === "bearer" ? [] : [["secret", options.secret] as const]),
      ...(options.sourceId === undefined ? [] : [["source_id", options.sourceId] as const])
    )
    parameters.sort(([a], [b]) => (a < b ? -1 : 1))
    // Keep the gateway's record joinable to this proxy's response, including a gateway refusal before Electric runs.
    // Generated here, never copied from a browser header or added to a cache-key URL.
    let upstream = HttpClientRequest.get(shapeUrl).pipe(HttpClientRequest.setHeader("x-request-id", correlationId))
    for (const [key, value] of parameters) upstream = HttpClientRequest.appendUrlParam(upstream, key, value)
    // The client span records an `authorization` header redacted.
    if (options.secret !== undefined && options.secretAs === "bearer") {
      upstream = HttpClientRequest.bearerToken(upstream, options.secret)
    }

    const injected = yield* Effect.serviceOption(Upstream)
    const client = Option.isSome(injected) ? injected.value : yield* HttpClient.HttpClient
    const response = yield* client.execute(upstream).pipe(
      Effect.option,
      // The browser went away before Electric answered, as it does with a live request it no longer needs.
      Effect.onInterrupt(() => ended(499, "electric", "aborted"))
    )
    if (Option.isNone(response)) {
      yield* ended(502, "electric")
      return HttpServerResponse.empty({ status: 502, headers: ownHeaders })
    }
    const { status, headers, stream } = response.value
    yield* answered(status, "electric")
    const responseHeaders = {
      ...Object.fromEntries(
        Object.entries(headers).filter(([key]) => !dropped(key) && (keeps || !caching.has(key)))
      ),
      ...ownHeaders
    }
    // These statuses cannot carry a response body, including an empty ReadableStream.
    if ([204, 205, 304].includes(status)) {
      yield* record({
        status,
        live,
        phase,
        startedAt,
        bytes: 0,
        outcome: "complete",
        correlationId,
        upstream: "electric"
      })
      return HttpServerResponse.empty({ status, headers: responseHeaders })
    }
    // The body streams after this handler and its span end, outside its services, so the record runs with them.
    const context = yield* Effect.context<never>()
    let bytes = 0
    const body = stream.pipe(
      // Fetch represents a bodyless answer as null; Effect's stream adapter reports EmptyBodyError for it.
      // Preserve that valid empty answer (notably a gateway's 503), while retaining real mid-body failures.
      Stream.catch((error) => error.reason._tag === "EmptyBodyError" ? Stream.empty : Stream.fail(error)),
      Stream.tap((chunk) => Effect.sync(() => (bytes += chunk.byteLength))),
      Stream.onExit((exit) =>
        record({
          status,
          correlationId,
          upstream: "electric",
          live,
          phase,
          startedAt,
          bytes,
          outcome: Exit.isSuccess(exit) ? "complete" : Exit.hasInterrupts(exit) ? "aborted" : "failed"
        }).pipe(Effect.provideContext(context))
      )
    )
    return HttpServerResponse.stream(body, {
      status,
      headers: responseHeaders
    })
  }).pipe(Effect.withSpan(name, { kind: "server" }))
}
