/**
 * A `Model` served over HTTP, and a `Model` that reads one served elsewhere.
 *
 * {@link serve} is the host half: an `effect/http` handler that reads a
 * `ModelRequest`, lets the host's `prepare` hook enforce policy and choose the
 * `Model` that answers, calls it and streams its events back. {@link layerClient}
 * is the other half: a `Model` whose `stream` posts the request and decodes the
 * events, so a browser, another Worker or a CLI calls a remote model with the
 * same `model.stream(request)` it would use for a local one.
 *
 * The wire is NDJSON: one Schema-encoded {@link Line} per event, then exactly
 * one terminal line, `{"type":"end"}` on a clean finish or an {@link ErrorLine}
 * carrying a `ModelError` code and a safe message. A body that stops before its
 * terminal line was cut, and the client fails it as `transport`. A blank line
 * is a keep-alive: the server writes one when the model shows it is alive
 * without an event (a provider thinking in silence), and every client skips it,
 * so the format stays readable by a client that predates it.
 *
 * Both halves observe themselves: one span (`model.proxy.serve`,
 * `model.proxy.stream`), the request metrics below, and one structured log line
 * per request, joined by the `x-smithers-request-id` header and W3C trace
 * context. None of them carries prompt or response content.
 *
 * @since 1.0.0
 */

import { Fault } from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Ndjson from "effect/encoding/Ndjson"
import * as Exit from "effect/Exit"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as HttpTraceContext from "effect/http/HttpTraceContext"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Tracer from "effect/Tracer"
import * as Endpoint from "./Endpoint.ts"
import * as FailureCopy from "./FailureCopy.vibe"
import { classifyHttpStatus } from "./HttpStatusClassifier.ts"
import * as Model from "./Model.vibe"
import { faults, ModelError, ModelErrorCode } from "./ModelError.vibe"
import { ModelEvent, type Usage } from "./ModelEvent.ts"
import { ModelRequest } from "./ModelRequest.ts"
import type { PreparedRequest } from "./Route.ts"

/**
 * The header both halves read and write to correlate one request: the client
 * sends it, the server keeps a well-formed one (or mints its own) and echoes it.
 *
 * @category constants
 * @since 1.0.0
 */
export const requestIdHeader = "x-smithers-request-id"

/**
 * The media type of a served event stream.
 *
 * @category constants
 * @since 1.0.0
 */
export const contentType = "application/x-ndjson"

/**
 * The request body limit {@link serve} applies when the host names none: 1 MiB.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultMaxBodyBytes = 1_048_576

/**
 * The terminal line of a stream that finished cleanly.
 *
 * @category wire
 * @since 1.0.0
 */
export const EndLine = Schema.Struct({ type: Schema.Literal("end") })

/**
 * The decoded form of {@link EndLine}.
 *
 * @category wire
 * @since 1.0.0
 */
export type EndLine = typeof EndLine.Type

/**
 * The terminal line of a stream that failed after its headers were sent: the
 * `ModelError` code, a fixed message for that code, and the provider's
 * `retryAfterMillis` when it named one. Never provider text or credentials.
 *
 * @category wire
 * @since 1.0.0
 */
export const ErrorLine = Schema.Struct({
  type: Schema.Literal("error"),
  code: ModelErrorCode,
  message: Schema.String,
  retryAfterMillis: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)))
})

/**
 * The decoded form of {@link ErrorLine}.
 *
 * @category wire
 * @since 1.0.0
 */
export type ErrorLine = typeof ErrorLine.Type

/**
 * One NDJSON line of a served stream: a `ModelEvent`, or one of the two
 * terminal lines.
 *
 * @category wire
 * @since 1.0.0
 */
export const Line = Schema.Union([ModelEvent, EndLine, ErrorLine])

/**
 * The decoded form of {@link Line}.
 *
 * @category wire
 * @since 1.0.0
 */
export type Line = typeof Line.Type

/**
 * The JSON body of a request {@link serve} answered with an error status
 * instead of a stream: a bad method or body, an oversized body, a
 * {@link Refusal}, or a failed `prepare`.
 *
 * @category wire
 * @since 1.0.0
 */
export const ErrorBody = Schema.Struct({
  code: ModelErrorCode,
  message: Schema.String,
  requestId: Schema.String
})

/**
 * The decoded form of {@link ErrorBody}.
 *
 * @category wire
 * @since 1.0.0
 */
export type ErrorBody = typeof ErrorBody.Type

/**
 * A host's refusal to serve a request, raised by `prepare`. `status` is the
 * HTTP status the client receives (400 to 599) and `message` is shown to it as
 * written, so it must be safe to show. `code` is the `ModelError` code the
 * client fails with; without one the status chooses it (`429` is
 * `rate_limited`, `401` and `403` are `authentication`, other 4xx are
 * `invalid_request`).
 *
 * Its fault is that code's class in `ModelError.faults`, so a host and the
 * client it refused read one class: a `429` waits, a `401` asks the person.
 *
 * @category errors
 * @since 1.0.0
 */
export class Refusal extends Schema.TaggedError<Refusal>()("flows/model/ModelProxyRefusal", {
  status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
  message: Schema.String,
  code: Schema.optional(ModelErrorCode)
}) {
  /**
   * The `ModelError` code the client fails with: `code`, or the one `status`
   * chooses.
   *
   * @since 1.0.0-rc.16
   */
  get modelErrorCode(): ModelErrorCode {
    return this.code ?? classifyHttpStatus(this.status, undefined, "", "opaque")
  }
}

Fault.register("flows/model/ModelProxyRefusal", faults, "modelErrorCode")

/**
 * Requests served or streamed, by `side` (`server` or `client`), `outcome`
 * (`success`, `invalid`, `refused`, `failed`, `interrupted`) and HTTP `status`
 * (`0` when no response arrived).
 *
 * @category metrics
 * @since 1.0.0
 */
export const requests = Metric.counter("smithers_model_proxy_requests", {
  description: "Model proxy requests, by side, outcome and HTTP status",
  incremental: true
})

/**
 * Request wall time in milliseconds, from the request's start to its terminal
 * line or refusal, by `side` and `outcome`.
 *
 * @category metrics
 * @since 1.0.0
 */
export const duration = Metric.histogram("smithers_model_proxy_duration_ms", {
  description: "Model proxy request wall time in milliseconds, by side and outcome",
  boundaries: Metric.exponentialBoundaries({ start: 50, factor: 2, count: 14 })
})

/**
 * Milliseconds from a request's start to its first model event, by `side`.
 * A request that produced no event records nothing.
 *
 * @category metrics
 * @since 1.0.0
 */
export const firstEvent = Metric.histogram("smithers_model_proxy_first_event_ms", {
  description: "Model proxy time to first model event in milliseconds, by side",
  boundaries: Metric.exponentialBoundaries({ start: 25, factor: 2, count: 14 })
})

/**
 * Tokens the served model reported, by `type` (`input` or `output`), the
 * served `model`, and the host's {@link ServeOptions.attributes}. Only the
 * server records them, so a client and its host in one process never count a
 * call twice.
 *
 * @category metrics
 * @since 1.0.0
 */
export const tokens = Metric.counter("smithers_model_tokens", {
  description: "Tokens reported by models served over HTTP, by type, model and the host's attributes",
  incremental: true
})

/**
 * What a host's `prepare` hook decides for one request: the request the model
 * receives, and the `Model` that answers it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Prepared {
  readonly request: ModelRequest
  readonly model: Model.Model
}

/**
 * What {@link serve} knows about a request when it hands it to the host's
 * `prepare`: the caller's `requestId`, the server's own `invocationId` for
 * this call (the same one {@link End} carries), and the body's size in bytes,
 * at most `maxBodyBytes`.
 *
 * A host that bounds spend reserves it here, keyed by `invocationId`, and
 * settles the reservation in `onEnd` under the same key. `requestBytes` bounds
 * the prompt: a byte-level tokenizer never yields more tokens than bytes of
 * text.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export interface Admission {
  readonly requestId: string
  readonly invocationId: string
  readonly requestBytes: number
}

/**
 * How a served request ended, as {@link ServeOptions.onEnd} receives it: its
 * ids, its outcome, the model id it ran on, and the usage the model reported
 * (merged field by field; a `retry` event starts it over). An `interrupted`
 * request reports the usage reported before the client went away.
 *
 * `invocationId` is the server's own id for this one call, minted fresh for
 * every request {@link serve} admits: key metering on it. `requestId` is the
 * caller's correlation id, which a caller may send again on any number of
 * calls, so a host that keys spend on it lets a caller spend without paying.
 *
 * @category models
 * @since 1.0.0
 */
export interface End {
  readonly requestId: string
  /**
   * The server's id for this call, unique to it and never chosen by the
   * caller; the key a host meters on.
   *
   * @since 1.0.0-rc.16
   */
  readonly invocationId: string
  readonly outcome: "success" | "failed" | "interrupted"
  readonly modelId: string
  readonly usage: Usage
  /**
   * Whether the model sent any output before the call ended: an event other
   * than `usage` and `retry`. A call that failed with none was refused before
   * the provider produced anything.
   *
   * @since 1.0.0-rc.17
   */
  readonly produced: boolean
  /**
   * For a `failed` call, the `ModelError` code it failed with (`unknown` for
   * any other failure); absent otherwise.
   *
   * @since 1.0.0-rc.17
   */
  readonly errorCode?: ModelErrorCode | undefined
  /**
   * For a `failed` call whose provider answered an HTTP error, that status;
   * absent otherwise.
   *
   * @since 1.0.0-rc.17
   */
  readonly httpStatus?: number | undefined
}

/**
 * Whether a served call ended in a clean refusal: it failed before the model
 * produced any output, `rate_limited` or with a provider 4xx status. Such a
 * call spent nothing beyond the usage its provider reported, so a host that
 * reserved spend for it settles to that usage, and to 0 when none was
 * reported. Any other failure, a transport failure or a 5xx before any output
 * included, may have spent tokens nobody reported.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export const refusedCleanly = (end: End): boolean =>
  end.outcome === "failed" && !end.produced &&
  (end.errorCode === "rate_limited" || (end.httpStatus !== undefined && end.httpStatus >= 400 && end.httpStatus < 500))

/**
 * What a failure tells {@link End}: its `ModelError` code (`unknown` for any
 * other failure) and the provider's HTTP status when it had one.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export const failureOf = (
  cause: Cause.Cause<unknown>
): { readonly errorCode: ModelErrorCode; readonly httpStatus?: number | undefined } => {
  const found = Cause.findError(cause)
  const modelError = Result.isSuccess(found) && found.success instanceof ModelError ? found.success : undefined
  return {
    errorCode: modelError?.code ?? "unknown",
    ...(modelError?.httpStatus === undefined ? {} : { httpStatus: modelError.httpStatus })
  }
}

/**
 * Whether a model event is output, as {@link End}'s `produced` counts it:
 * anything but `usage` and `retry`, which report on the call rather than
 * answer it. For a host that meters a call it runs in process and builds its
 * own `End`.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export const producesOutput = (event: ModelEvent): boolean => event.type !== "usage" && event.type !== "retry"

/**
 * What {@link serve} lets a host decide before the model runs, and hear after
 * it ends.
 *
 * @category models
 * @since 1.0.0
 */
export interface ServeOptions<R> {
  /**
   * Turns the decoded request into the one the model receives and chooses the
   * `Model` that answers it, or refuses it with a {@link Refusal}. This is
   * where the host chooses the model, system prompt, parameters and tools,
   * and checks who is asking; a browser must not choose them on the host's
   * key. Its {@link Admission} names the call, so a host can reserve spend
   * under the `invocationId` that `onEnd` later reports.
   */
  readonly prepare: (request: ModelRequest, admission: Admission) => Effect.Effect<Prepared, Refusal, R>
  /** The largest request body accepted, in bytes; {@link defaultMaxBodyBytes} when omitted. */
  readonly maxBodyBytes?: number | undefined
  /**
   * Attributes added to every server-side metric and to the log line of this
   * request, such as the host's name for what the model is used for. They
   * must be low-cardinality labels: never ids, prompt text or credentials. The
   * proxy's own attribute names win over a host attribute of the same name.
   */
  readonly attributes?: Readonly<Record<string, string>> | undefined
  /**
   * Runs once after the model stream of an admitted request ends, with its
   * {@link End}: the place to meter usage. The terminal line waits for it, so
   * what it records is recorded before the client reads the end; a client
   * that went away gets no terminal line, and `onEnd` runs as the body
   * closes. Once it starts it runs to its end, even when the client goes away
   * meanwhile. It does not run for a request `prepare` refused or that never
   * reached the model. It must not fail; handle its own errors.
   */
  readonly onEnd?: ((end: End) => Effect.Effect<void, never, R>) | undefined
}

/**
 * Serves a `Model` over HTTP: one `POST` with a JSON `ModelRequest` body in,
 * an NDJSON event stream out. The host's `prepare` chooses which `Model`
 * answers each request.
 *
 * It answers `405` to another method, `413` to a body over `maxBodyBytes`
 * (counted while reading, so a chunked body without `content-length` is bounded
 * too), `400` to a body that is not a `ModelRequest`, a {@link Refusal}'s status
 * to a refused one, and `500` when `prepare` dies; each with an
 * {@link ErrorBody}. Otherwise it answers `200` at once and streams the model's
 * events, ending with an {@link EndLine}, or an {@link ErrorLine} when the model
 * fails. A client that goes away interrupts the model call.
 *
 * Each time the model runs `Model.Liveness` (a route does for every chunk of
 * provider bytes, a keep-alive included) it writes a blank line, at most one a
 * second and none within a second of an event, so a client that bounds silence
 * hears a provider that thinks for minutes without an event. A model that
 * shows nothing gets no blank line: silence on the wire is silence upstream.
 *
 * Run it under any `effect/http` server: `HttpEffect.toWebHandler`, an
 * `HttpRouter` route, Node, Bun, or a Cloudflare Worker's `fetch`.
 *
 * @category server
 * @since 1.0.0
 */
export const serve = <R = never>(
  options: ServeOptions<R>
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | R
> =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const startedAt = yield* Clock.currentTimeMillis
    const requestId = acceptedRequestId(request.headers[requestIdHeader]) ?? makeRequestId()
    // The caller chooses `requestId` and may repeat it; this id is the server's alone, one per call.
    const invocationId = makeRequestId()
    const parent = yield* Effect.serviceOption(Tracer.ParentSpan)
    // A host with no HTTP server span still joins the caller's trace.
    const span = yield* Effect.makeSpan("model.proxy.serve", {
      kind: Option.isSome(parent) ? "internal" : "server",
      parent: Option.isSome(parent) ? undefined : Option.getOrUndefined(HttpTraceContext.fromHeaders(request.headers)),
      attributes: { [attributes.requestId]: requestId, [attributes.invocationId]: invocationId }
    })
    const call = new Call("server", requestId, startedAt, span, options.attributes ?? {})
    call.invocationId = invocationId

    const admitted = yield* Effect.result(admit(request, options, call, invocationId)).pipe(
      Effect.onInterrupt(() => call.finish(Exit.interrupt()))
    )
    if (admitted._tag === "Failure") {
      const rejection = admitted.failure
      call.status = rejection.status
      call.outcome = rejection.outcome
      call.errorCode = rejection.code
      yield* call.finish(Exit.void)
      return HttpServerResponse.jsonUnsafe(
        { code: rejection.code, message: rejection.message, requestId } satisfies ErrorBody,
        {
          status: rejection.status,
          headers: {
            "cache-control": "no-store",
            [requestIdHeader]: requestId,
            ...(rejection.status === 405 ? { allow: "POST" } : {})
          }
        }
      )
    }

    const { model, request: prepared } = admitted.success
    call.modelId = prepared.modelId
    call.providerName = model.providerName
    call.status = 200
    span.attribute("gen_ai.request.model", prepared.modelId)
    if (model.providerName !== undefined) span.attribute("gen_ai.provider.name", model.providerName)
    // The response body runs after this handler returns, so it carries the
    // handler's services (tracer, loggers, metric registry, and what `onEnd`
    // reads) with it, but not the handler's scope, which has closed by then.
    const context = Context.omit(Scope.Scope)(yield* Effect.context<R>()) as Context.Context<R>
    const onEnd = options.onEnd
    let ended = false
    /**
     * Runs the host's `onEnd` once, with the outcome and the usage so far. Once started it runs to its end, even when
     * the client goes away meanwhile: it is where a host meters the call, and the call already ran.
     */
    const end = (outcome: End["outcome"]): Effect.Effect<void, never, R> =>
      Effect.uninterruptible(Effect.suspend(() => {
        if (ended || onEnd === undefined) return Effect.void
        ended = true
        return onEnd({
          requestId,
          invocationId,
          outcome,
          modelId: prepared.modelId,
          usage: call.usage,
          produced: call.produced,
          ...(outcome === "failed"
            ? {
              // `call.failure` recorded the code before the stream reached its failed terminal line.
              errorCode: call.errorCode,
              ...(call.failureStatus === undefined ? {} : { httpStatus: call.failureStatus })
            }
            : {})
        })
      }))
    // The terminal line follows the host's `onEnd`, so a host that meters there has recorded the call before the
    // client reads the end of it, and before a Worker's response, and with it the invocation, ends.
    const terminal = (outcome: End["outcome"], line: Line) =>
      Stream.unwrap(Effect.as(end(outcome), Stream.succeed(line)))
    // The model's liveness becomes a blank line on the wire, unless a line went out within the last second: a
    // keep-alive stands in for an event, never beside one. The sliding queue drops a beat the body has not
    // written yet, so a keep-alive never holds the model back.
    const beats = yield* Queue.sliding<void>(1)
    let wroteAt = Number.NEGATIVE_INFINITY
    const wrote = Effect.map(Clock.currentTimeMillis, (now) => {
      wroteAt = now
    })
    const alive = Effect.flatMap(Clock.currentTimeMillis, (now) => {
      if (now - wroteAt < keepAliveMs) return Effect.void
      wroteAt = now
      return Effect.asVoid(Queue.offer(beats, undefined))
    })
    const lines = model.stream(prepared).pipe(
      Stream.provideService(Model.Liveness, alive),
      Model.withGenAiSpan(prepared, model.providerName),
      Stream.tap((event) => Effect.andThen(call.observe(event), wrote)),
      Stream.map((event): Line => event),
      Stream.concat(Stream.suspend(() => {
        call.outcome = "success"
        return terminal("success", endLine)
      })),
      encodeLines,
      Stream.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Stream.failCause(cause)
        call.outcome = "failed"
        return encodeLines(terminal("failed", call.failure(cause)))
      })
    )
    // Every encoded chunk ends at a line break, so a keep-alive merged between two chunks never splits a line.
    // The body ends with its lines; the keep-alives stop with them.
    const body = lines.pipe(
      Stream.merge(Stream.map(Stream.fromQueue(beats), keepAlive), { haltStrategy: "left" }),
      // A client that went away gets no terminal line; `onEnd` still hears of it, as `interrupted`.
      Stream.onExit((exit) =>
        Effect.andThen(call.finish(exit), end("interrupted")).pipe(
          // Response cancellation can finalize in the HTTP transport's context.
          // Completion belongs to the request, including its metrics and onEnd.
          Effect.provideContext(context)
        )
      ),
      Stream.provideService(Tracer.ParentSpan, span),
      Stream.provideContext(context)
    )
    return HttpServerResponse.stream(body, {
      contentType,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", [requestIdHeader]: requestId }
    })
  })

/**
 * Where {@link makeClient} sends requests.
 *
 * @category models
 * @since 1.0.0
 */
export interface ClientOptions {
  /** The URL {@link serve} answers on. */
  readonly url: string | URL
  /** Extra request headers, such as the host's own authorization. */
  readonly headers?: Readonly<Record<string, string>> | undefined
}

/**
 * Builds a `Model` that streams from a {@link serve} endpoint.
 *
 * `stream` posts the Schema-encoded request with a fresh request id and the
 * current trace context, and decodes the event lines. It runs `Model.Liveness`
 * for every chunk of the body it reads, so a blank keep-alive line, which
 * decodes to no event, still tells a durable step the call is alive. An
 * {@link ErrorLine}
 * fails the stream with its `ModelError`. Every other failure is typed too: a
 * transport error, a broken body or a body that ends before its terminal line
 * is `transport`, an undecodable line is `invalid_provider_output`, an encode
 * failure is `invalid_request`, and an error status is the {@link ErrorBody}'s
 * code (or the status's) with `httpStatus` set. Every `ModelError` it raises
 * carries the request id as `requestId`. Interrupting the stream aborts the
 * request.
 *
 * @category client
 * @since 1.0.0
 */
export const makeClient = (options: ClientOptions): Effect.Effect<Model.Model, never, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    return Model.make({ stream: (request) => remoteStream(client, options, request) })
  })

/**
 * Provides {@link makeClient} as the `Model` service.
 *
 * @category client
 * @since 1.0.0
 */
export const layerClient = (options: ClientOptions): Layer.Layer<Model.Model, never, HttpClient.HttpClient> =>
  Layer.effect(Model.Model)(makeClient(options))

// The JSON codec of the request, as the client writes it (`HttpClientRequest.schemaBodyJson` encodes through
// `Schema.toCodecJson`, which writes an optional field that is present but undefined as `null`), so the server reads
// every request the client sends.
const requestJson = Schema.toCodecJson(ModelRequest)

/**
 * The credential-free form of the request {@link makeClient} sends for
 * `request`: the endpoint's URL, the public headers, and the exact body bytes.
 * A durable model step keys on it, so give it to `ModelStep.run` or a seat as
 * the `route` beside the client's `Model`: a recorded call replays only for
 * the same request to the same endpoint. `options.headers`, which may carry
 * the host's own authorization, and the per-attempt request id and trace
 * context stay out. A request that does not encode fails `invalid_request`.
 * Endpoint credentials are rejected before constructing this public view.
 *
 * @category client
 * @since 1.0.0
 */
export const prepare =
  (options: ClientOptions) => (request: ModelRequest): Effect.Effect<PreparedRequest, ModelError> =>
    Effect.gen(function*() {
      const url = String(options.url)
      // Resolve relative browser URLs only for validation; keep their original route identity.
      const endpoint = yield* Effect.try({
        try: () => new URL(url, "https://model-proxy.invalid").href,
        catch: () => new ModelError({ code: "invalid_request", message: "Endpoint URL could not be parsed." })
      })
      yield* Effect.fromResult(Endpoint.make({ url: endpoint }))
      const encoded = yield* Schema.encodeEffect(requestJson)(request).pipe(
        Effect.mapError(() => new ModelError({ code: "invalid_request", message: "The request could not be encoded." }))
      )
      const bodyText = JSON.stringify(encoded)
      return {
        routeId: "model-proxy",
        protocolId: "model-proxy/ndjson",
        method: "POST",
        url,
        publicHeaders: { accept: contentType, "content-type": "application/json" },
        body: new TextEncoder().encode(bodyText),
        bodyText
      }
    })

/** Span attribute names. */
const attributes = {
  requestId: "smithers.model.proxy.request_id",
  invocationId: "smithers.model.proxy.invocation_id",
  outcome: "smithers.model.proxy.outcome",
  events: "smithers.model.proxy.events",
  durationMs: "smithers.model.proxy.duration_ms",
  firstEventMs: "smithers.model.proxy.first_event_ms",
  requestBytes: "smithers.model.proxy.request_bytes",
  status: "http.response.status_code",
  errorType: "error.type"
} as const

type Side = "server" | "client"
type Outcome = "success" | "invalid" | "refused" | "failed" | "interrupted"

const endLine: Line = { type: "end" }

/** The shortest gap between two lines {@link serve} writes for the model's liveness alone. */
const keepAliveMs = 1_000

/** A keep-alive: one blank line, a fresh buffer each time, since a byte stream may take ownership of it. */
const keepAlive = (): Uint8Array => Uint8Array.of(0x0a)

const encodeLines = <E, R>(lines: Stream.Stream<Line, E, R>) =>
  lines.pipe(Stream.pipeThroughChannel(Ndjson.encodeSchema(Line)<E>()))

/** Request ids are opaque tokens; anything else is replaced, never logged. */
const requestIdPattern = /^[\w.:-]{1,128}$/

const acceptedRequestId = (value: string | undefined): string | undefined =>
  value !== undefined && requestIdPattern.test(value) ? value : undefined

const makeRequestId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")

/** The fixed, provider-free text a client sees for a code. */
const safeMessage = (code: ModelErrorCode): string =>
  FailureCopy.describe(new ModelError({ code, message: "" })).headline

/** A request {@link serve} answers with a status instead of a stream. */
interface Rejection {
  readonly status: number
  readonly outcome: Outcome
  readonly code: ModelErrorCode
  readonly message: string
}

const rejection = (status: number, outcome: Outcome, message: string, code?: ModelErrorCode): Rejection => ({
  status,
  outcome,
  code: code ?? classifyHttpStatus(status, undefined, "", "opaque"),
  message
})

const notModelRequest = rejection(400, "invalid", "Send a JSON ModelRequest.")

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(requestJson))

/** Decodes the body and runs `prepare`; every failure but an interruption becomes a rejection. */
const admit = <R>(
  request: HttpServerRequest.HttpServerRequest,
  options: ServeOptions<R>,
  call: Call,
  invocationId: string
): Effect.Effect<Prepared, Rejection, R> =>
  Effect.gen(function*() {
    if (request.method !== "POST") {
      return yield* Effect.fail(rejection(405, "invalid", "Send a POST request.", "invalid_request"))
    }
    const bytes = yield* readBody(request, options.maxBodyBytes ?? defaultMaxBodyBytes)
    call.requestBytes = bytes.length
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
      catch: () => notModelRequest
    })
    const decoded = yield* Effect.mapError(decodeRequest(text), () => notModelRequest)
    const admission: Admission = { requestId: call.requestId, invocationId, requestBytes: bytes.length }
    return yield* Effect.mapError(
      options.prepare(decoded, admission),
      (refusal) => rejection(refusal.status, "refused", refusal.message, refusal.modelErrorCode)
    )
  }).pipe(
    Effect.catchDefect(() => {
      call.errorTag = "defect"
      return Effect.fail(rejection(500, "failed", "The model host failed.", "unknown"))
    })
  )

/** Reads at most `maxBytes`, refusing a declared or streamed body that is larger before buffering it. */
const readBody = (
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number
): Effect.Effect<Uint8Array, Rejection> => {
  const tooLarge = rejection(413, "invalid", `Send at most ${maxBytes} bytes.`, "invalid_request")
  if (Number(request.headers["content-length"]) > maxBytes) return Effect.fail(tooLarge)
  return Effect.suspend(() => {
    const chunks: Array<Uint8Array> = []
    let size = 0
    return request.stream.pipe(
      Stream.mapError(() => notModelRequest),
      Stream.runForEach((chunk) => {
        size += chunk.length
        if (size > maxBytes) return Effect.fail(tooLarge)
        chunks.push(chunk)
        return Effect.void
      }),
      Effect.map(() => {
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }
        return bytes
      })
    )
  })
}

/** The `ModelError` a client raises, carrying its request id. */
const clientError = (
  requestId: string,
  code: ModelErrorCode,
  message: string,
  extra: { readonly httpStatus?: number; readonly retryAfterMillis?: number } = {}
): ModelError => new ModelError({ code, message, requestId, ...extra })

/** The largest error-status body a client reads before falling back to the status alone. */
const maxErrorBodyBytes = 16_384

/** The largest response line, excluding its newline, buffered by a client: 1 MiB. */
const maxResponseLineBytes = 1_048_576

const decodeErrorBody = Schema.decodeUnknownEffect(Schema.fromJsonString(ErrorBody))

const remoteStream = (
  client: HttpClient.HttpClient,
  options: ClientOptions,
  request: ModelRequest
): Stream.Stream<ModelEvent, ModelError> =>
  Stream.unwrap(Effect.gen(function*() {
    const startedAt = yield* Clock.currentTimeMillis
    const requestId = makeRequestId()
    const span = yield* Effect.makeSpan("model.proxy.stream", {
      kind: "internal",
      attributes: { [attributes.requestId]: requestId, "gen_ai.request.model": request.modelId }
    })
    const call = new Call("client", requestId, startedAt, span)
    call.modelId = request.modelId
    return Stream.unwrap(open(client, options, request, call)).pipe(
      Stream.tap((event) => call.observe(event)),
      Stream.onExit((exit) => call.finish(exit)),
      Stream.provideService(Tracer.ParentSpan, span)
    )
  }))

/** Posts the request; a 2xx answer becomes its decoded events, any other a typed failure. */
const open = (
  client: HttpClient.HttpClient,
  options: ClientOptions,
  request: ModelRequest,
  call: Call
): Effect.Effect<Stream.Stream<ModelEvent, ModelError>, ModelError> =>
  Effect.gen(function*() {
    const { requestId } = call
    const post = yield* HttpClientRequest.post(options.url).pipe(
      HttpClientRequest.setHeaders({ ...options.headers, accept: contentType, [requestIdHeader]: requestId }),
      HttpClientRequest.schemaBodyJson(ModelRequest)(request),
      Effect.mapError(() => clientError(requestId, "invalid_request", "The request could not be encoded."))
    )
    const response = yield* client.execute(post).pipe(
      Effect.mapError(() => clientError(requestId, "transport", "The model host could not be reached."))
    )
    call.status = response.status
    // fetch never surfaces a 1xx, so below 300 is a 2xx.
    if (response.status < 300) {
      // Every chunk is the host showing it is alive, a keep-alive line that decodes to no event included.
      const alive = yield* Model.Liveness
      return decodeLines(Stream.tap(response.stream, () => alive), call)
    }
    call.outcome = response.status < 500 ? "refused" : "failed"
    const body = yield* Effect.option(
      readCapped(response.stream, maxErrorBodyBytes).pipe(Effect.flatMap(decodeErrorBody))
    )
    return yield* Effect.fail(
      Option.match(body, {
        onNone: () =>
          clientError(
            requestId,
            classifyHttpStatus(response.status, undefined, "", "opaque"),
            `The model host answered HTTP ${response.status}.`,
            { httpStatus: response.status }
          ),
        onSome: ({ code, message }) => clientError(requestId, code, message, { httpStatus: response.status })
      })
    )
  })

/** The body as text, or `NoSuchElementError` once it passes `maxBytes`. */
const readCapped = <E>(
  bytes: Stream.Stream<Uint8Array, E>,
  maxBytes: number
): Effect.Effect<string, E | Cause.NoSuchElementError> =>
  Effect.suspend(() => {
    let size = 0
    return bytes.pipe(
      Stream.mapEffect((chunk) =>
        (size += chunk.length) > maxBytes ? Effect.fail(new Cause.NoSuchElementError()) : Effect.succeed(chunk)
      ),
      Stream.decodeText(),
      Stream.mkString
    )
  })

/** Decodes event lines until the terminal line; a body without one was cut. */
const decodeLines = (
  bytes: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>,
  call: Call
): Stream.Stream<ModelEvent, ModelError> =>
  Stream.suspend(() => {
    const { requestId } = call
    const truncated = () => clientError(requestId, "transport", "The model stream ended before it finished.")
    let lineBytes = 0
    return bytes.pipe(
      Stream.mapError(() => clientError(requestId, "transport", "The model stream broke.")),
      // Bound incomplete lines before decoding or concatenating their text, including whitespace.
      Stream.flatMap((chunk) =>
        Stream.unfold(0, (start) => {
          if (start >= chunk.length) return Effect.succeed(undefined)
          const newline = chunk.indexOf(0x0a, start)
          const end = newline === -1 ? chunk.length : newline
          lineBytes += end - start
          if (lineBytes > maxResponseLineBytes) {
            return Effect.fail(
              clientError(requestId, "invalid_provider_output", "The model host sent an oversized line.")
            )
          }
          // Yield each line separately, so a terminal line stops before any trailing data is inspected.
          if (newline !== -1) lineBytes = 0
          const next = newline === -1 ? end : end + 1
          return Effect.succeed([chunk.subarray(start, next), next] as const)
        })
      ),
      Stream.decodeText(),
      completeLines(truncated),
      Stream.pipeThroughChannel(Ndjson.decodeSchemaString(Line)<ModelError>({ ignoreEmptyLines: true })),
      Stream.mapError((error) =>
        error instanceof ModelError
          ? error
          : clientError(requestId, "invalid_provider_output", "The model host sent an unreadable line.")
      ),
      Stream.takeUntil((line) => line.type === "end" || line.type === "error"),
      Stream.mapEffect((line) => {
        if (line.type === "error") {
          return Effect.fail(clientError(
            requestId,
            line.code,
            line.message,
            line.retryAfterMillis === undefined ? {} : { retryAfterMillis: line.retryAfterMillis }
          ))
        }
        if (line.type === "end") call.outcome = "success"
        return Effect.succeed(line)
      }),
      Stream.filter((line): line is ModelEvent => line.type !== "end"),
      Stream.concat(Stream.suspend(() => call.outcome === "success" ? Stream.empty : Stream.fail(truncated())))
    )
  })

/**
 * Passes on only text that ends at a line break, holding a partial last line
 * back; a stream that ends inside a line fails with `onPartial`. A cut body
 * therefore reads as truncation, not as an unreadable line.
 */
const completeLines = <E2>(onPartial: () => E2) => <E, R>(text: Stream.Stream<string, E, R>) =>
  Stream.suspend(() => {
    let pending = ""
    return text.pipe(
      Stream.map((chunk) => {
        const joined = pending + chunk
        const end = joined.lastIndexOf("\n") + 1
        pending = joined.slice(end)
        return joined.slice(0, end)
      }),
      Stream.filter((complete) => complete.length > 0),
      Stream.concat(Stream.suspend(() => pending.trim() === "" ? Stream.empty : Stream.fail(onPartial())))
    )
  })

/** One request's observations, from either side, and the one place they are recorded. */
class Call {
  readonly side: Side
  readonly requestId: string
  readonly startedAt: number
  readonly span: Tracer.Span
  /** The server's id for the call; none on the client side. */
  invocationId: string | undefined
  providerName: string | undefined
  modelId: string | undefined
  requestBytes: number | undefined
  status: number | undefined
  outcome: Outcome | undefined
  errorCode: ModelErrorCode | undefined
  errorTag: string | undefined
  events = 0
  firstEventMs: number | undefined
  usage: Usage = {}
  /** Whether the model sent any output: an event other than `usage` and `retry`. */
  produced = false
  /** The provider's HTTP status of the failure, when it was an HTTP error. */
  failureStatus: number | undefined
  /** The host's attributes, added to this request's metrics and log line; none on the client side. */
  readonly attributes: Readonly<Record<string, string>>

  constructor(
    side: Side,
    requestId: string,
    startedAt: number,
    span: Tracer.Span,
    attributes: Readonly<Record<string, string>> = {}
  ) {
    this.side = side
    this.requestId = requestId
    this.startedAt = startedAt
    this.span = span
    this.attributes = attributes
  }

  /** Counts one model event; usage merges field by field and a retry starts it over, as `withGenAiSpan` does. */
  observe(event: ModelEvent): Effect.Effect<void> {
    return Effect.map(Clock.currentTimeMillis, (now) => {
      this.events += 1
      this.firstEventMs ??= now - this.startedAt
      if (producesOutput(event)) this.produced = true
      if (event.type === "retry") this.usage = {}
      if (event.type === "usage") {
        const { type: _, ...counters } = event
        this.usage = {
          ...this.usage,
          ...Object.fromEntries(Object.entries(counters).filter(([, value]) => value !== undefined))
        }
      }
    })
  }

  /**
   * Records what failed (its `ModelError` code, `unknown` for any other
   * failure, and its tag, `defect` for a defect) and returns the terminal line
   * that reports it.
   */
  failure(cause: Cause.Cause<unknown>): ErrorLine {
    const found = Cause.findError(cause)
    const modelError = Result.isSuccess(found) && found.success instanceof ModelError ? found.success : undefined
    const { errorCode: code, httpStatus } = failureOf(cause)
    this.errorCode = code
    this.failureStatus = httpStatus
    this.errorTag = Result.isSuccess(found) ? tagOf(found.success) : "defect"
    return {
      type: "error",
      code,
      message: safeMessage(code),
      ...(modelError?.retryAfterMillis === undefined ? {} : { retryAfterMillis: modelError.retryAfterMillis })
    }
  }

  /**
   * Ends the request: span attributes and end, metrics, and one log line with
   * no prompt, response or provider text. Each request reaches it exactly once:
   * from its rejection, its interrupted admission, or its stream's exit.
   */
  finish(exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        this.failure(exit.cause)
        this.outcome ??= "failed"
      } else {
        // Stopped before a terminal line: interrupted, or abandoned by its reader. A terminal line
        // already sent or read keeps its outcome when the reader goes away after it.
        this.outcome ??= "interrupted"
      }
      return this.record(this.outcome)
    })
  }

  private record(outcome: Outcome): Effect.Effect<void> {
    return Effect.flatMap(Clock.currentTimeMillis, (now) => this.recordAt(outcome, now - this.startedAt))
  }

  private recordAt(outcome: Outcome, durationMs: number): Effect.Effect<void> {
    const status = this.status ?? 0
    const span = this.span
    const fields = {
      ...this.attributes,
      requestId: this.requestId,
      ...(this.invocationId === undefined ? {} : { invocationId: this.invocationId }),
      traceId: span.traceId,
      side: this.side,
      outcome,
      ...(this.status === undefined ? {} : { status: this.status }),
      durationMs,
      events: this.events,
      ...(this.modelId === undefined ? {} : { modelId: this.modelId }),
      ...(this.providerName === undefined ? {} : { provider: this.providerName }),
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
      ...(this.errorTag === undefined ? {} : { errorTag: this.errorTag }),
      ...(this.firstEventMs === undefined ? {} : { firstEventMs: this.firstEventMs }),
      ...(this.requestBytes === undefined ? {} : { requestBytes: this.requestBytes }),
      ...(this.usage.inputTokens === undefined ? {} : { inputTokens: this.usage.inputTokens }),
      ...(this.usage.outputTokens === undefined ? {} : { outputTokens: this.usage.outputTokens })
    }
    span.attribute(attributes.outcome, outcome)
    span.attribute(attributes.events, this.events)
    span.attribute(attributes.durationMs, durationMs)
    if (this.status !== undefined) span.attribute(attributes.status, this.status)
    if (this.firstEventMs !== undefined) span.attribute(attributes.firstEventMs, this.firstEventMs)
    if (this.requestBytes !== undefined) span.attribute(attributes.requestBytes, this.requestBytes)
    if (this.errorCode !== undefined) span.attribute(attributes.errorType, this.errorCode)
    const side = { ...this.attributes, side: this.side }
    const level = outcome === "failed" ? "Error" : outcome === "invalid" || outcome === "refused" ? "Warn" : "Info"
    const firstEventMs = this.firstEventMs
    // The span's error is rebuilt from the code alone, so no provider text reaches the exporter. Every
    // failed outcome recorded its code.
    const exit = outcome === "failed"
      ? Exit.fail(new ModelError({ code: this.errorCode!, message: safeMessage(this.errorCode!) }))
      : outcome === "interrupted"
      ? Exit.interrupt()
      : Exit.void
    return Effect.all([
      Metric.update(Metric.withAttributes(requests, { ...side, outcome, status: String(status) }), 1),
      Metric.update(Metric.withAttributes(duration, { ...side, outcome }), durationMs),
      firstEventMs === undefined ? Effect.void : Metric.update(Metric.withAttributes(firstEvent, side), firstEventMs),
      this.side === "server" ? this.recordTokens() : Effect.void,
      Effect.logWithLevel(level)(span.name).pipe(Effect.annotateLogs(fields), Effect.withParentSpan(span))
    ], { discard: true }).pipe(
      Effect.ensuring(Effect.flatMap(Clock.currentTimeNanos, (nanos) => Effect.sync(() => span.end(nanos, exit))))
    )
  }

  private recordTokens(): Effect.Effect<void> {
    const model = this.modelId ?? ""
    const { inputTokens, outputTokens } = this.usage
    return Effect.all([
      inputTokens === undefined
        ? Effect.void
        : Metric.update(Metric.withAttributes(tokens, { ...this.attributes, type: "input", model }), inputTokens),
      outputTokens === undefined
        ? Effect.void
        : Metric.update(Metric.withAttributes(tokens, { ...this.attributes, type: "output", model }), outputTokens)
    ], { discard: true })
  }
}

/** A failure's `_tag`, a safe identifier; `unknown` for a value without one. */
const tagOf = (error: unknown): string => {
  const tag: unknown = Object(error)._tag
  return typeof tag === "string" ? tag : "unknown"
}
