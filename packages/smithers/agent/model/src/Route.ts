/**
 * A resolved model route: an endpoint, a protocol, a framing, and the
 * credentials to authorize with. Preparing a route yields a credential-free
 * request that can enter a sealed step's key material, with the secret
 * applied only as the request leaves.
 *
 * @since 0.1.0
 */

import { SpanFailure } from "@smthrs/flow"
import { Clock, Effect, Exit, Layer, Option, Redacted, Result, Schema, Stream } from "effect"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as SchemaIssue from "effect/SchemaIssue"
import * as AnthropicMessages from "./AnthropicMessages.ts"
import * as Auth from "./Auth.ts"
import * as CanonicalJson from "./CanonicalJson.ts"
import * as Endpoint from "./Endpoint.ts"
import * as Framing from "./Framing.ts"
import * as CallTiming from "./internal/CallTiming.ts"
import * as WireTrace from "./internal/WireTrace.ts"
import * as Model from "./Model.ts"
import { ModelError } from "./ModelError.ts"
import { type ModelEvent, type Settle, settledMessage, type Timing, type Usage } from "./ModelEvent.ts"
import { type JsonObject, type ModelRequest, ModelRequest as ModelRequestSchema } from "./ModelRequest.ts"
import * as OpenAIChatCompletions from "./OpenAIChatCompletions.ts"
import * as OpenAIResponses from "./OpenAIResponses.ts"
import type * as Protocol from "./Protocol.ts"
import * as RequestExecutor from "./RequestExecutor.ts"
import * as TraceSink from "./WireTrace.ts"

/**
 * The credential-free representation used to construct a sealed model step.
 * This view, including the canonical body bytes, is what the engine digests
 * into the sealed-step key when it services `EngineLike.sealStep`
 * (`packages/smithers/agent/harness/src/EngineLike.ts`).
 * Credentials are signed onto a copy afterwards and never enter this value.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface PreparedRequest {
  readonly routeId: string
  readonly protocolId: string
  readonly method: "POST"
  readonly url: string
  readonly publicHeaders: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly bodyText: string
}

/**
 * The deployment-specific pieces which compose a protocol into a model route.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Config<Body, Frame, Event, State> {
  readonly id: string
  /** OpenTelemetry provider name; independent of route identity and wire protocol. */
  readonly providerName: string
  readonly protocol: Protocol.Protocol<Body, Frame, Event, State>
  readonly endpoint: Endpoint.Endpoint
  readonly auth: Auth.Auth
  readonly framing: Framing.Framing<Frame>
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Fields added to every request body this route sends, beside the
   * protocol's own: a provider's or gateway's extension the protocol doesn't
   * model, such as routing preferences (`{ providerOptions: { gateway: {
   * order: ["cerebras"] } } }` on the Vercel AI Gateway, `{ provider: { order:
   * ["cerebras"] } }` on OpenRouter). A field the protocol writes wins, so they
   * never replace the model, the messages or the output cap. Part of the body
   * a sealed step's key digests. Never a credential: those go through `auth`.
   */
  readonly extraBody?: JsonObject | undefined
}

/**
 * A configured, but not yet authenticated, protocol route.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Route<Body, Frame, Event, State> = Config<Body, Frame, Event, State>

const sensitiveHeader = (name: string): boolean => Auth.isCredentialName(name)

// Map keys are unique, so canonical header comparisons have only two possible orderings.
const compareCanonical = (left: string, right: string): number => left < right ? -1 : 1

const publicHeaders = (
  headers: Readonly<Record<string, string>>
): Result.Result<Record<string, string>, ModelError> => {
  const normalized = new Map<string, string>([["content-type", "application/json"]])
  for (const [name, value] of Object.entries(headers)) {
    if (sensitiveHeader(name)) {
      return Result.fail(
        new ModelError({
          code: "invalid_request",
          message: `Route header ${name} must be applied through Auth`
        })
      )
    }
    normalized.set(name.toLowerCase(), value)
  }
  return Result.succeed(Object.fromEntries([...normalized].sort(([left], [right]) => compareCanonical(left, right))))
}

// A preparation failure has to say WHERE without saying WHAT: a request member
// may hold a credential or user content, and a ModelError is serialized into
// journals and diagnostics. Both sources of a location are key paths already.
const issueSegments = (issue: SchemaIssue.Issue): ReadonlyArray<PropertyKey> => {
  const segments: Array<PropertyKey> = []
  let current: SchemaIssue.Issue | undefined = issue
  while (current !== undefined) {
    if (current._tag === "Pointer") {
      segments.push(...current.path)
      current = current.issue
    } else if (current._tag === "Filter" || current._tag === "Encoding") {
      current = current.issue
    } else if (current._tag === "Composite" || current._tag === "AnyOf") {
      // The first issue is the one a reader fixes first; the rest are usually
      // the same member reported against the other members of a union.
      current = current.issues[0]
    } else {
      current = undefined
    }
  }
  return segments
}

const formatSegments = (segments: ReadonlyArray<PropertyKey>): string | undefined =>
  segments.length === 0 ? undefined : segments.reduce<string>((text, segment) => {
    if (typeof segment === "number") return `${text}[${segment}]`
    return text === "" ? String(segment) : `${text}.${String(segment)}`
  }, "")

const schemaPath = (error: unknown): string | undefined => {
  const issue = (error as { readonly issue?: SchemaIssue.Issue } | undefined)?.issue
  return issue === undefined ? undefined : formatSegments(issueSegments(issue))
}

const withPath = (
  code: ModelError["code"],
  message: string,
  path: string | undefined
): ModelError => new ModelError({ code, message, ...(path === undefined ? {} : { path }) })

// `CanonicalJson` reports the offending member in its own message, and that
// message is the only place the path exists.
const canonicalPath = (error: unknown): string | undefined =>
  error instanceof Error ? /^Value at (.+) is not valid JSON$/.exec(error.message)?.[1] : undefined

const preparationError = (error: unknown): ModelError =>
  withPath(
    "invalid_request",
    "Model request could not be encoded as canonical JSON",
    canonicalPath(error)
  )

/**
 * Compiles a request exactly once into its credential-free sealed-step view.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const prepare = <Body, Frame, Event, State>(
  route: Route<Body, Frame, Event, State>,
  request: ModelRequest
): Effect.Effect<PreparedRequest, ModelError> => Effect.map(compile(route, request), (compiled) => compiled.prepared)

/**
 * The request every later step reads, and the sealed view built from it.
 *
 * Validating once and threading the result is what keeps a call self-consistent:
 * the caller owns the `ModelRequest` object and may mutate it while signing is
 * pending, and without a snapshot the body, the `model:call` capability check
 * and the protocol's initial state could each describe a different request.
 */
interface Compiled {
  readonly prepared: PreparedRequest
  readonly request: ModelRequest
}

const compile = <Body, Frame, Event, State>(
  route: Route<Body, Frame, Event, State>,
  request: ModelRequest
): Effect.Effect<Compiled, ModelError> =>
  SpanFailure.effect(
    Effect.fn("flows/model/Route.prepare")(function*() {
      // Custom routes can supply a public endpoint directly. Validate before
      // preparing or signing, just as the provider constructors do.
      yield* Effect.fromResult(Endpoint.makeSecure({ url: route.endpoint.url, query: route.endpoint.query }))
      const validatedRequest = yield* Schema.decodeUnknownEffect(ModelRequestSchema)(request).pipe(
        Effect.mapError((error) =>
          withPath("invalid_request", "Model request failed Schema validation", schemaPath(error))
        )
      )
      const native = route.protocol.supportsDeferred(validatedRequest.modelId)
      const candidate = yield* route.protocol.body.from(validatedRequest, { native })
      const body = yield* Schema.encodeUnknownEffect(route.protocol.body.schema)(candidate).pipe(
        Effect.mapError((error) =>
          withPath(
            "invalid_request",
            `${route.protocol.id} produced an invalid provider request body`,
            schemaPath(error)
          )
        )
      )
      const headers = yield* Effect.fromResult(
        publicHeaders({ ...route.headers, ...route.protocol.headers?.(validatedRequest) })
      )
      // The protocol's fields win; absent, the body is byte-for-byte what it was, so sealed keys are unchanged.
      const sent = route.extraBody === undefined ? body : { ...route.extraBody, ...(body as object) }
      const bytes = yield* Effect.try({
        try: () => CanonicalJson.bytes(sent),
        catch: preparationError
      })
      return {
        prepared: {
          routeId: route.id,
          protocolId: route.protocol.id,
          method: "POST" as const,
          url: Endpoint.render(route.endpoint),
          publicHeaders: headers,
          body: bytes,
          bodyText: new TextDecoder().decode(bytes)
        },
        request: validatedRequest
      }
    })()
  )

/**
 * The latest affinity token per conversation, process-wide so every model a
 * seat builds for one run shares it. Bounded: the oldest conversation is
 * forgotten first, and a forgotten one only costs its next request the
 * routing hint.
 *
 * A slot is keyed by the route, the endpoint, a fingerprint of the signed
 * credential and the cache key, so two accounts in one process that share a
 * cache key never carry each other's token. A refreshed credential starts a
 * new slot, which costs one request the routing hint.
 */
const affinity = new Map<string, string>()
const affinityLimit = 1024

/** A fingerprint of what `Auth.sign` added to the public headers. */
const credentialFingerprint = (
  publicHeaders: Readonly<Record<string, string>>,
  signed: Readonly<Record<string, string>>
): string =>
  CanonicalJson.shortHash(
    Object.entries(signed)
      .filter(([name, value]) => publicHeaders[name] !== value)
      .map(([name, value]) => `${name.toLowerCase()}\u0000${value}`)
      .sort()
      .join("\u0000")
  )

const affinitySlot = (
  prepared: {
    readonly routeId: string
    readonly url: string
    readonly publicHeaders: Readonly<Record<string, string>>
  },
  request: ModelRequest,
  signed: Readonly<Record<string, string>>
): string | undefined =>
  request.cacheKey === undefined
    ? undefined
    : [prepared.routeId, prepared.url, credentialFingerprint(prepared.publicHeaders, signed), request.cacheKey]
      .join("\u0000")

const rememberAffinity = (slot: string, value: string): void => {
  affinity.delete(slot)
  affinity.set(slot, value)
  if (affinity.size > affinityLimit) affinity.delete(affinity.keys().next().value!)
}

/**
 * What one call's wire trace line and failure are written from, filled in as
 * the call runs.
 */
interface Call {
  readonly timing: CallTiming.CallTiming
  /** The wire trace's number for the call, when it is traced. */
  traced: WireTrace.TracedCall | undefined
  status: number | undefined
  headers: Readonly<Record<string, string>> | undefined
  usage: Usage
  settled: Settle | undefined
}

// A failed call's reading rides on its error the way a provider body does:
// outside the schema, so a journal and a comparison see what they always saw.
const timed = (error: Model.ModelFailure, timing: Timing): Model.ModelFailure =>
  error instanceof ModelError && Object.isExtensible(error)
    ? Object.defineProperty(error, "timing", { value: timing, enumerable: false, configurable: true })
    : error

const stream = <Body, Frame, Event, State>(
  route: Route<Body, Frame, Event, State>,
  executor: RequestExecutor.RequestExecutor,
  request: ModelRequest,
  call: Call,
  sink: TraceSink.WireTrace | undefined
): Stream.Stream<ModelEvent, Model.ModelFailure> =>
  Stream.scoped(
    Stream.unwrap(
      SpanFailure.effect(
        Effect.fn("flows/model/Route.stream")(function*() {
          const { timing } = call
          const { prepared, request: snapshot } = yield* compile(route, request)
          timing.prepared(prepared.body.byteLength)
          const affinityHeader = route.protocol.affinityHeader
          let traced = false
          let rejectedHeaders: Record<string, string> | undefined
          const attempt = Effect.gen(function*() {
            const signed = yield* route.auth.sign({ ...prepared.publicHeaders })
            rejectedHeaders = { ...signed }
            timing.signed()
            const slot = affinityHeader === undefined ? undefined : affinitySlot(prepared, snapshot, signed)
            const token = slot === undefined ? undefined : affinity.get(slot)
            if (!traced) {
              traced = true
              call.traced = yield* WireTrace.record({ ...prepared, affinity: token !== undefined }, sink)
            }
            const signedHeaders = {
              ...signed,
              ...(token === undefined ? {} : { [affinityHeader!]: token })
            }
            const httpRequest = HttpClientRequest.post(prepared.url, { headers: signedHeaders }).pipe(
              HttpClientRequest.bodyUint8Array(prepared.body, "application/json")
            )
            const sanitize = yield* RequestExecutor.errorSanitizer(httpRequest)
            const response = yield* executor.execute(httpRequest, {
              modelId: snapshot.modelId,
              classifyError: route.protocol.classifyError,
              onTry: timing.onTry
            })
            timing.headers()
            call.status = response.status
            call.headers = response.headers
            const returned = slot === undefined ? undefined : response.headers[affinityHeader!.toLowerCase()]
            if (returned !== undefined && returned !== "") rememberAffinity(slot!, returned)
            return { response, sanitize }
          }).pipe(Auth.withRedaction(route.auth))
          // An `authentication` failure is terminal on both retry ladders — a bad
          // key never repairs itself by waiting. A refresh-capable Auth is the
          // one case where recovery is possible: run its refresh and re-sign
          // exactly once, so an access token that expired mid-flight costs one
          // recovery, while a credential the refresh cannot repair still fails
          // typed on the second attempt.
          const refresh = route.auth.refresh
          const refreshRejected = route.auth.refreshRejected
          const { response, sanitize } = yield* (refresh === undefined && refreshRejected === undefined
            ? attempt
            : attempt.pipe(
              Effect.catchIf(
                (error): error is ModelError => error instanceof ModelError && error.code === "authentication",
                (error) => {
                  const recovery = rejectedHeaders === undefined || refreshRejected === undefined
                    ? refresh
                    : refreshRejected(rejectedHeaders)
                  return recovery === undefined ? Effect.fail(error) : Effect.andThen(recovery, attempt)
                }
              )
            )).pipe(
              // This span ends when the response starts, so it carries the
              // request's half of the reading, a refusal's or a stall's included.
              Effect.ensuring(Effect.suspend(() => Effect.annotateCurrentSpan(CallTiming.attributes(timing.read()))))
            )
          const decodeEvent = Schema.decodeUnknownEffect(route.protocol.stream.event)
          const terminal = route.protocol.stream.terminal
          const alive = yield* Model.Liveness
          const events = route.framing.frame(
            response.stream.pipe(
              // Every chunk is progress, a keep-alive that frames to no event
              // included: a provider thinking in silence still sends those.
              Stream.tap(() => alive),
              // The code is the contract and the transport's own text is not:
              // `HttpClientError`'s message ends in the method and URL, which a
              // provider authorizing by query parameter would make a credential.
              // `transport` is what the retry ladder classifies on, and a body
              // that dies after the headers is on that ladder from here.
              Stream.mapError(() => new ModelError({ code: "transport", message: "Model response stream failed" }))
            )
          ).pipe(
            // effect rc.108's SSE decoder adds `SseError` (oversized events) to
            // the framing channel; a framing failure is a transport failure here.
            Stream.mapError((error) =>
              error._tag === "SseError"
                ? new ModelError({ code: "transport", message: "Model response stream failed" })
                : error
            ),
            Stream.mapEffect((frame) => {
              timing.frame()
              return decodeEvent(frame).pipe(
                Effect.mapError((error) =>
                  withPath(
                    "invalid_provider_output",
                    `${route.protocol.id} emitted an invalid stream event`,
                    schemaPath(error)
                  )
                )
              )
            }),
            terminal === undefined
              ? (framed) => framed
              // The route reads nothing after the terminal frame: the response
              // stream closes with it, before the protocol steps it.
              : Stream.takeUntil((event) => {
                const last = terminal(event)
                if (last) timing.closed()
                return last
              }),
            // A body that ends without one closes here, ahead of the halt hook.
            Stream.onEnd(Effect.sync(timing.closed))
          )
          return events.pipe(
            Stream.mapAccumEffect(
              () => route.protocol.stream.initial(snapshot),
              route.protocol.stream.step,
              route.protocol.stream.onHalt === undefined
                ? undefined
                : { onHalt: route.protocol.stream.onHalt }
            ),
            // Keep the signed attempt's policy after the HTTP effect completes,
            // including when refresh replaced the original credential.
            Stream.mapError(sanitize),
            // The settle event carries the reading as it stands when the
            // protocol settles. Chat Completions settles on `finish_reason`,
            // one chunk before the usage that ends the body, so that settle is
            // read before the stream closes and has no `closedMs`.
            Stream.map((event): ModelEvent => {
              timing.event(event)
              if (event.type === "usage") call.usage = settledMessage([{ type: "usage", ...call.usage }, event]).usage
              if (event.type !== "settle") return event
              call.settled = { ...event, timing: timing.read() }
              return call.settled
            })
          )
        })()
      )
    )
  )

/**
 * One measured call: the stream above, started on the caller's `Clock`.
 *
 * The call starts here. Every offset its settle event reports counts from
 * this instant, the body's encoding included. However it ends, its wire trace
 * line is written here; a call that fails closes where it failed, and its
 * error says so.
 */
const measured = <Body, Frame, Event, State>(
  route: Route<Body, Frame, Event, State>,
  executor: RequestExecutor.RequestExecutor,
  request: ModelRequest,
  sink: TraceSink.WireTrace | undefined
): Stream.Stream<ModelEvent, Model.ModelFailure> =>
  Stream.unwrap(Effect.map(Clock.clockWith(Effect.succeed), (clock) => {
    const timing = CallTiming.start(clock)
    const call: Call = {
      timing,
      traced: undefined,
      status: undefined,
      headers: undefined,
      usage: {},
      settled: undefined
    }
    let failure: string | undefined
    return stream(route, executor, request, call, sink).pipe(
      Stream.mapError((error) => {
        failure = error.code
        timing.closed()
        return timed(error, timing.read())
      }),
      Stream.onExit((exit) =>
        Effect.suspend(() => {
          timing.closed()
          return WireTrace.recordResponse(call.traced, () => {
            const reading = timing.read()
            return {
              routeId: route.id,
              protocolId: route.protocol.id,
              outcome: failure ??
                (call.settled !== undefined ? "settled" : Exit.isSuccess(exit) ? "ended" : "interrupted"),
              stopReason: call.settled?.stopReason,
              status: call.status ?? reading.failedTries?.at(-1)?.httpStatus,
              timing: reading,
              usage: call.usage,
              responseId: call.settled?.responseId,
              servedTier: call.settled?.servedTier,
              headers: call.headers
            }
          }, clock.currentTimeMillisUnsafe())
        })
      )
    )
  }))

/**
 * Composes Protocol × Endpoint × Auth × Framing into a route value.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = <Body, Frame, Event, State>(
  config: Config<Body, Frame, Event, State>
): Route<Body, Frame, Event, State> => config

/**
 * Builds a `Model` implementation from a composed route.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const toModel = <Body, Frame, Event, State>(
  config: Config<Body, Frame, Event, State>
): Effect.Effect<Model.Model, never, RequestExecutor.RequestExecutor> =>
  Effect.gen(function*() {
    const executor = yield* RequestExecutor.RequestExecutor
    const sink = Option.getOrUndefined(yield* Effect.serviceOption(TraceSink.WireTrace))
    return Model.make({
      providerName: config.providerName,
      stream: (request) => measured(config, executor, request, sink)
    })
  })

/**
 * Provides a configured route as the `Model` service.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layer = <Body, Frame, Event, State>(
  config: Config<Body, Frame, Event, State>
): Layer.Layer<Model.Model, never, RequestExecutor.RequestExecutor> => Layer.effect(Model.Model, toModel(config))

/**
 * Creates Anthropic's Messages deployment configuration.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const anthropic = (
  input: {
    readonly apiKey?: Auth.Redacted<string> | undefined
    /** The origin, `Endpoint.providerOrigins` by default; see `Endpoint.providerOrigin`. */
    readonly baseUrl?: string | undefined
  }
): Result.Result<
  Route<
    AnthropicMessages.Body,
    string,
    Parameters<typeof AnthropicMessages.protocol.stream.step>[1],
    ReturnType<typeof AnthropicMessages.protocol.stream.initial>
  >,
  ModelError
> =>
  Result.map(
    Endpoint.makeSecure({ url: input.baseUrl ?? Endpoint.providerOrigins.anthropic, path: "/v1/messages" }),
    (endpoint) =>
      make({
        id: "anthropic",
        providerName: "anthropic",
        protocol: AnthropicMessages.protocol,
        endpoint,
        auth: Auth.apiKeyHeader("x-api-key", input.apiKey ?? Redacted.make("")),
        framing: Framing.sse,
        headers: { "anthropic-version": "2023-06-01" }
      })
  )

/**
 * Creates OpenAI's Responses deployment configuration.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const openai = (
  input: {
    readonly apiKey: Auth.Redacted<string>
    /** The origin, `Endpoint.providerOrigins` by default; see `Endpoint.providerOrigin`. */
    readonly baseUrl?: string | undefined
  }
): Result.Result<
  Route<
    OpenAIResponses.Body,
    string,
    Parameters<typeof OpenAIResponses.protocol.stream.step>[1],
    ReturnType<typeof OpenAIResponses.protocol.stream.initial>
  >,
  ModelError
> =>
  Result.map(
    Endpoint.makeSecure({ url: input.baseUrl ?? Endpoint.providerOrigins.openai, path: "/v1/responses" }),
    (endpoint) =>
      make({
        id: "openai",
        providerName: "openai",
        protocol: OpenAIResponses.protocol,
        endpoint,
        auth: Auth.bearer(input.apiKey),
        framing: Framing.sse
      })
  )

/**
 * Creates a route for a provider that serves the OpenAI **Responses** API
 * without OpenAI's native deferred-tool extensions.
 *
 * `baseUrl` is the provider origin and this constructor appends
 * `/v1/responses` itself, so one origin can only ever produce one URL:
 * `https://openrouter.ai/api` becomes
 * `https://openrouter.ai/api/v1/responses`. A trailing slash is accepted.
 *
 * Responses and Chat Completions are different wire shapes. `api.openai.com`
 * and OpenRouter's `/v1/responses` serve Responses; Ollama, Gemini's
 * compatibility layer, Cerebras and most other self-hosted or third-party
 * "OpenAI-compatible" servers serve Chat Completions and need
 * {@link openaiChatCompatible} instead.
 *
 * @since 0.1.0
 * @category constructors
 */
export const openaiResponsesCompatible = (
  input: {
    readonly id: string
    readonly providerName: string
    readonly baseUrl: string
    readonly apiKey: Auth.Redacted<string>
    readonly headers?: Readonly<Record<string, string>>
  }
): Result.Result<
  Route<
    OpenAIResponses.Body,
    string,
    Parameters<typeof OpenAIResponses.protocol.stream.step>[1],
    ReturnType<typeof OpenAIResponses.protocol.stream.initial>
  >,
  ModelError
> =>
  Result.map(Endpoint.makeSecure({ url: input.baseUrl, path: "/v1/responses" }), (endpoint) =>
    make({
      id: input.id,
      providerName: input.providerName,
      protocol: { ...OpenAIResponses.protocol, supportsDeferred: () => false },
      endpoint,
      auth: Auth.bearer(input.apiKey),
      framing: Framing.sse,
      ...(input.headers === undefined ? {} : { headers: input.headers })
    }))

/**
 * Creates a route for a provider that serves the OpenAI **Chat Completions**
 * API: Ollama, Gemini's OpenAI-compatibility layer, Cerebras, and most other
 * self-hosted or third-party "OpenAI-compatible" servers.
 *
 * `baseUrl` is the provider origin and `path` defaults to
 * `/v1/chat/completions`. Providers with a different compatible endpoint,
 * such as Gemini, pass their exact path explicitly.
 *
 * `apiKey` may be a non-empty placeholder for a server that does not check it
 * (Ollama ignores its `Authorization` header entirely); {@link Auth.bearer}
 * only rejects an empty credential. `structuredOutput` behaves exactly as it
 * does on this route.
 *
 * @since 0.1.0
 * @category constructors
 */
export const openaiChatCompatible = (
  input: {
    readonly id: string
    readonly providerName: string
    readonly baseUrl: string
    readonly path?: string | undefined
    readonly apiKey: Auth.Redacted<string>
    readonly structuredOutput?: OpenAIChatCompletions.StructuredOutput | undefined
    /** Fields added to every request body, such as a gateway's routing preferences: {@link Config.extraBody}. */
    readonly extraBody?: JsonObject | undefined
  }
): Result.Result<
  Route<
    OpenAIChatCompletions.Body,
    string,
    Parameters<typeof OpenAIChatCompletions.protocol.stream.step>[1],
    ReturnType<typeof OpenAIChatCompletions.protocol.stream.initial>
  >,
  ModelError
> =>
  Result.map(
    Endpoint.makeSecure({ url: input.baseUrl, path: input.path ?? "/v1/chat/completions" }),
    (endpoint) =>
      make({
        id: input.id,
        providerName: input.providerName,
        protocol: OpenAIChatCompletions.protocolWith(
          input.structuredOutput === undefined ? {} : { structuredOutput: input.structuredOutput }
        ),
        endpoint,
        auth: Auth.bearer(input.apiKey),
        framing: Framing.sse,
        ...(input.extraBody === undefined ? {} : { extraBody: input.extraBody })
      })
  )
