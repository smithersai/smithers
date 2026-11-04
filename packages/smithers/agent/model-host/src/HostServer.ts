/**
 * Authenticated `effect/http` handler for the shared model turn host.
 *
 * @since 1.0.0-rc.0
 */

import { digestSync } from "@smthrs/crypto"
import { type Model, ModelError } from "@smthrs/model"
import { AgentTurnJournal, ContextPreflight, type DocsPages, type NativeAgent } from "@smthrs/rpc"
import { Cause, Effect, Exit, Metric, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { z } from "zod"
import type { CallbackTransportObserver } from "./CallbackTransport.ts"
import { runContextPreflight } from "./ContextPreflight.ts"
import { runDurableChatTurn } from "./DurableChatProducer.ts"
import type { DurableChatGrant } from "./DurableChatProducer.ts"
import { makeHostDiagnostics } from "./HostDiagnostics.vibe"
import type { HostDiagnosticFields, HostDiagnostics } from "./HostDiagnostics.vibe"
import { boundedJson } from "./internal/BoundedJson.vibe"
import type { ProducerError, ResolveFailed } from "./ModelHostError.vibe"
import { StreamTooLarge } from "./ModelHostError.vibe"
import { runModelTurn } from "./ModelTurnHost.vibe"
import type { ModelTurnOptions } from "./ModelTurnHost.vibe"

/** The model host wire protocol identifier.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export const MODEL_HOST_PROTOCOL = "smithers.chat-model-host/v1"
/** The authenticated model turn endpoint.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export const MODEL_HOST_TURN_PATH = "/v1/chat/turn"
/** The authenticated sealed model stream endpoint.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export const MODEL_HOST_STREAM_PATH = "/v1/model/stream"
/** The authenticated selection-only endpoint: the shared context preflight
 * selector without a chat turn, as a TODO plan step uses it over wiki pages.
 *
 * @category protocol
 * @since 1.0.0
 */
export const MODEL_HOST_CONTEXT_SELECT_PATH = "/v1/context/select"
/** The protocol identity endpoint.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export const MODEL_HOST_HEALTH_PATH = "/health"

const Identity = z.string().min(1).max(160)
const WireGrantSchema = z.object({
  turnId: z.string().min(1).max(160),
  ownerId: z.number().int().positive(),
  repositoryId: z.number().int().positive().optional(),
  runId: Identity,
  legId: Identity,
  generation: z.number().int().positive(),
  token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  cursor: AgentTurnJournal.AgentTurnCursorSchema,
  expiresAt: z.string().min(1).max(64),
  request: z.unknown(),
  producerBaseUrl: z.string().url(),
  installOrigin: z.string().url().refine((raw) => {
    try {
      const origin = new URL(raw)
      return (origin.protocol === "http:" || origin.protocol === "https:") &&
        origin.username === "" && origin.password === "" && origin.pathname === "/" &&
        origin.search === "" && origin.hash === ""
    } catch {
      return false
    }
  }).transform((raw) => new URL(raw).origin).optional(),
  source: z.object({ repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).max(201) }).strict().optional(),
  agentInstructions: z.string().max(66000).optional(),
  api: z.object({ author: Identity, token: z.string().regex(/^smithers_[a-f0-9]{40}$/u) }).strict().optional()
}).strict()

/**
 * The model and projection options resolved inside the trusted host.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ModelTurnResolution {
  readonly model: Model.Model
  readonly options: ModelTurnOptions
  /** Authorized SharedEntries and pinned repository data, resolved on the host. */
  readonly preflight?: {
    readonly input: ContextPreflight.ContextPreflightInput
    readonly model: Model.Model
    readonly options: ModelTurnOptions
  }
}

/** Resolves the owner's configured provider inside the trusted host process.
 * Provider credentials stay in this result and never cross the Go grant wire.
 * `selection` is the selection-only endpoint's validated input; a chat turn
 * never supplies one, so its preflight always reads authorized SharedEntries.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ModelTurnResolver = (
  grant: DurableChatGrant,
  selection?: ContextPreflight.ContextPreflightInput
) => Effect.Effect<ModelTurnResolution, ResolveFailed>

/**
 * Dependencies for the authenticated model host request handler.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ModelTurnHandlerOptions {
  readonly authorization: string
  /** Public install origin; configure when the callback is a private listener. */
  readonly installOrigin?: string
  readonly callbackBaseUrl: string
  readonly resolve: ModelTurnResolver
  readonly fetchImpl?: NativeAgent.FetchLike
  /** The in-app docs pages this host's build bundles; host-owned turns read them through `docs`. */
  readonly docs?: ReadonlyArray<DocsPages.DocsPage>
  /**
   * Observes each turn's journal callbacks, so a failed one answers with the
   * phase it reached. The Node host passes `FetchTransport.observe` from
   * `@smthrs/platform-node`; without one, failures carry no transport phase.
   */
  readonly observeTransport?: CallbackTransportObserver
  /**
   * Where each turn's diagnostic records go, one newline-terminated line per
   * call. The Node host writes them to standard error; without one, turns
   * record nothing.
   */
  readonly writeDiagnostic?: (line: string) => void
}

const normalizedBaseUrl = (raw: string): string => {
  const value = new URL(raw)
  if (
    (value.protocol !== "http:" && value.protocol !== "https:") || value.username !== "" || value.password !== "" ||
    value.search !== "" || value.hash !== ""
  ) {
    throw new Error("invalid model host callback URL")
  }
  value.pathname = "/"
  return value.toString()
}

const MessageSchema = z.union([
  z.object({ role: z.enum(["user", "assistant"]), content: z.string() }).strict(),
  z.object({ type: z.literal("function_call"), call_id: z.string(), name: z.string(), arguments: z.string() }).strict(),
  z.object({ type: z.literal("function_call_output"), call_id: z.string(), output: z.string() }).strict()
])
const ToolsSchema = z.array(
  z.object({
    type: z.literal("function"),
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown())
  }).strict()
)

const turnRequest = (value: unknown): NativeAgent.StartAgentTurnRequest | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const body = value as Record<string, unknown>
  if (typeof body.runId !== "string" || typeof body.instructions !== "string" || !Array.isArray(body.messages)) {
    return undefined
  }
  if (!z.array(MessageSchema).safeParse(body.messages).success) return undefined
  if (body.tools !== undefined && !ToolsSchema.safeParse(body.tools).success) return undefined
  return value as NativeAgent.StartAgentTurnRequest
}

const decodeGrant = (value: unknown, callbackBaseUrl: string): DurableChatGrant | undefined => {
  const parsed = WireGrantSchema.safeParse(value)
  if (!parsed.success) return undefined
  const wire = parsed.data
  const request = turnRequest(wire.request)
  let producerBaseUrl: string
  try {
    producerBaseUrl = normalizedBaseUrl(wire.producerBaseUrl)
  } catch {
    return undefined
  }
  if (
    request === undefined || request.runId !== wire.runId || wire.cursor.runId !== wire.runId ||
    wire.cursor.legId !== wire.legId || producerBaseUrl !== callbackBaseUrl ||
    !Number.isFinite(Date.parse(wire.expiresAt)) || Date.parse(wire.expiresAt) <= Date.now()
  ) return undefined
  return {
    turnId: wire.turnId,
    ownerId: wire.ownerId,
    ...(wire.repositoryId === undefined ? {} : { repositoryId: wire.repositoryId }),
    runId: wire.runId,
    legId: wire.legId,
    generation: wire.generation,
    token: wire.token,
    cursor: wire.cursor,
    expiresAt: wire.expiresAt,
    request,
    producerBaseUrl: callbackBaseUrl,
    ...(wire.installOrigin === undefined ? {} : { installOrigin: wire.installOrigin }),
    ...(wire.source === undefined ? {} : { source: wire.source }),
    ...(wire.agentInstructions === undefined ? {} : { agentInstructions: wire.agentInstructions }),
    ...(wire.api === undefined ? {} : { api: wire.api })
  }
}

/** A selection-only request carries host-read candidates, never a transcript. */
const SelectionRequestSchema = z.object({
  runId: Identity,
  ownerId: z.number().int().positive(),
  instructions: z.literal(""),
  messages: z.array(z.never()).max(0),
  contextSelection: ContextPreflight.ContextPreflightInputSchema
}).strict()

const streamRequest = (value: unknown): NativeAgent.StartAgentTurnRequest | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const body = value as Record<string, unknown>
  if (typeof body.runId !== "string" || !Array.isArray(body.messages)) return undefined
  if (!z.array(MessageSchema).safeParse(body.messages).success) return undefined
  if (body.tools !== undefined && !ToolsSchema.safeParse(body.tools).success) return undefined
  return {
    ...body,
    instructions: typeof body.instructions === "string" ? body.instructions : ""
  } as NativeAgent.StartAgentTurnRequest
}

/** The most NDJSON bytes one sealed stream response holds; the Go reader caps at the same 16 MiB. */
const MAX_STREAM_BYTES = 16 * 1024 * 1024

/**
 * Failed model host turns by failure class.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const turnFailures = Metric.counter("smithers_model_host_turn_failures", {
  description: "Model host turns that ended in a refusal, by failure class"
})

/**
 * Model host turn wall time in milliseconds, by outcome.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const turnDuration = Metric.histogram("smithers_model_host_turn_duration_ms", {
  description: "Model host turn wall time in milliseconds, by outcome",
  boundaries: Metric.exponentialBoundaries({ start: 100, factor: 2, count: 12 })
})

/**
 * What a failed turn is: the failure class, its provider or producer status,
 * and the response code the caller sees. Never the cause text.
 */
interface TurnFailure {
  readonly failure: string
  readonly status?: number
  readonly code?: string
  readonly response: "turn_failed" | "provider_quota" | "provider_auth" | "cancelled"
  /**
   * How far the callback that failed got on the wire. The attempt's own record
   * is in the guest's log, which is gone once the turn's guest is, so a
   * transport failure carries its phase out over the one connection a callback
   * fault does not break: this answer to the caller. Phases, counts and short
   * codes only — the same fields the observer is built to be safe to log.
   */
  readonly transport?: HostDiagnosticFields
}

/** The provider refusals a person acts on: wait or add credit, or replace the key. */
const providerResponse = (code: string): TurnFailure["response"] =>
  code === "rate_limited" || code === "quota_exceeded" || code === "out_of_credit" ?
    "provider_quota"
    : code === "authentication" ?
    "provider_auth"
    : "turn_failed"

const classify = (
  cause: Cause.Cause<ResolveFailed | ProducerError | Model.ModelFailure | StreamTooLarge>
): TurnFailure => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (error === undefined) {
    return Cause.hasInterruptsOnly(cause)
      ? { failure: "Interrupted", response: "cancelled" }
      : { failure: "Defect", response: "turn_failed" }
  }
  if (error instanceof ModelError.ModelError) {
    return {
      failure: "ModelFailure",
      code: error.code,
      response: providerResponse(error.code)
    }
  }
  return {
    failure: error._tag,
    ...("status" in error ? { status: error.status } : {}),
    ...("transport" in error && error.transport !== undefined ? { transport: error.transport } : {}),
    response: "turn_failed"
  }
}

const json = (body: unknown, status = 200): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, { status })

const refused = (code: string, status: number): HttpServerResponse.HttpServerResponse =>
  json({ status: "error", code }, status)

/**
 * The stage a sealed model stream stopped at, and what stopped it there:
 * `classify`'s fixed tags, provider codes and statuses, which is what the
 * turn route already answers with and what `createHostDiagnostics` is built
 * to be safe to write. No message, destination, header or credential reaches
 * either the record or the response.
 *
 * Why it exists: a bare `stream_failed` with a swallowed cause made a resolve
 * refusal, a provider outage and an oversized stream the same answer. On
 * 2026-10-14 a sealed stream that refused its owner's configured model
 * (an origin the guest could not match) looked exactly like a provider that
 * never answered, and the stage had to be found by bisecting the environment.
 */
const streamRefused = (
  diagnostics: HostDiagnostics,
  stage: "resolve" | "stream",
  cause: Cause.Cause<ResolveFailed | Model.ModelFailure | StreamTooLarge>
): HttpServerResponse.HttpServerResponse => {
  const classified = classify(cause)
  // `classify` also carries the status a journal refused a callback with, and
  // this route cannot produce one: a sealed model stream commits nothing, so
  // its failures are a refused resolve, a model failure and an oversized
  // stream, none of which has a status. Spreading one here left a branch no
  // request could reach, and the narrowed cause type above is what keeps it
  // unreachable — a producer failure at this call site is a type error now,
  // rather than a status this response would silently drop.
  const refusal = {
    stage,
    failure: classified.failure,
    ...(classified.code === undefined ? {} : { providerCode: classified.code })
  }
  diagnostics.record("model_stream", "refused", refusal)
  return json({ status: "error", code: "stream_failed", ...refusal }, 502)
}

const utf8 = new TextEncoder()

/** SHA-256 of the UTF-8 bytes, so a lone surrogate is the replacement character rather than a thrown error. */
const digest = (value: string): string => digestSync(utf8.encode(value))

/** Two equal-length digests compared without an early exit, so the time taken never says how much matched. */
const sameDigest = (left: string, right: string): boolean => {
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

/**
 * Whether a presented Authorization header value is `Bearer <authorization>`,
 * compared in constant time: equal length SHA-256 digests keep the comparison
 * from leaking a prefix match.
 */
const bearerCheck = (authorization: string): (presented: string | undefined) => boolean => {
  const expected = digest(`Bearer ${authorization}`)
  return (presented) => presented !== undefined && sameDigest(digest(presented), expected)
}

/**
 * The bearer check every model host route runs: compares the presented
 * Authorization header with `Bearer <authorization>` in constant time. Equal
 * length SHA-256 digests keep the comparison from leaking a prefix match.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const bearerAuthorization = (authorization: string): (request: Request) => boolean => {
  const check = bearerCheck(authorization)
  return (request) => check(request.headers.get("authorization") ?? undefined)
}

/** The request's path, read off its URL and never its Host header; an unparseable one routes nowhere. */
const pathOf = (url: string): string => {
  try {
    return new URL(url, "http://model-host.invalid").pathname
  } catch {
    return ""
  }
}

/**
 * Creates the `effect/http` handler shared by the local executable and Plue
 * service. It reads the current `HttpServerRequest` and always answers with an
 * `HttpServerResponse`: every refusal is a response, never a failure.
 *
 * Serve it with `HttpEffect.toWebHandler` from `effect/http`, which turns it
 * into a Fetch handler and interrupts it when the caller goes away, or mount it
 * on an `HttpRouter`. The handler runs in the caller's fiber, so the caller's
 * services, tracer, logger and metric registry reach every turn. Interrupting
 * a turn still records how it ended before the interruption completes.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const createModelTurnHandler = (
  options: ModelTurnHandlerOptions
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> => {
  if (options.authorization.trim() === "") throw new Error("model host authorization is required")
  const callbackBaseUrl = normalizedBaseUrl(options.callbackBaseUrl)
  const authorized = bearerCheck(options.authorization)
  const methodNotAllowed = () => HttpServerResponse.text("Method not allowed", { status: 405 })
  const forbidden = () => refused("forbidden", 401)
  // Reading the body and running a model can be interrupted, however the
  // handler is mounted: `HttpEffect.toWebHandler` alone would run them
  // uninterruptibly, so a caller who left would hold a provider call open.
  // Recording how a turn ended always runs to the end.
  return Effect.scoped(Effect.uninterruptible(
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const pathname = pathOf(request.url)
      const presented = request.headers["authorization"]
      if (pathname === MODEL_HOST_HEALTH_PATH && request.method === "GET") {
        return json({ protocol: MODEL_HOST_PROTOCOL })
      }
      if (pathname === MODEL_HOST_STREAM_PATH) {
        if (request.method !== "POST") return methodNotAllowed()
        if (!authorized(presented)) return forbidden()
        const body = streamRequest(yield* Effect.interruptible(boundedJson(request)))
        if (body === undefined) return refused("request_invalid", 400)
        const wireBody = body as unknown as Record<string, unknown>
        const ownerId = typeof wireBody.ownerId === "number" && Number.isSafeInteger(wireBody.ownerId)
          ? wireBody.ownerId :
          0
        const grant: DurableChatGrant = {
          turnId: `model-stream-${body.runId}`,
          ownerId,
          runId: body.runId,
          legId: body.runId,
          generation: 1,
          token: "model_stream_model_stream_model_stream_1234",
          cursor: { version: 1, runId: body.runId, legId: body.runId, batch: 0, position: 0, hash: "0".repeat(64) },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          request: body,
          producerBaseUrl: callbackBaseUrl
        }
        const diagnostics = yield* makeHostDiagnostics({ turnId: grant.turnId, write: options.writeDiagnostic })
        const resolveExit = yield* Effect.exit(Effect.interruptible(options.resolve(grant)))
        if (Exit.isFailure(resolveExit)) return streamRefused(diagnostics, "resolve", resolveExit.cause)
        const resolved = resolveExit.value
        const encoder = new TextEncoder()
        const lines: Array<string> = []
        let size = 0
        const streamExit = yield* Effect.exit(Effect.interruptible(runModelTurn(
          resolved.model,
          body,
          resolved.options,
          (frame: NativeAgent.AgentTurnFrame) => {
            const line = `${JSON.stringify(frame)}\n`
            size += encoder.encode(line).byteLength
            if (size > MAX_STREAM_BYTES) return Effect.fail(new StreamTooLarge({ limitBytes: MAX_STREAM_BYTES }))
            lines.push(line)
            return Effect.void
          },
          undefined,
          diagnostics
        )))
        if (Exit.isFailure(streamExit)) return streamRefused(diagnostics, "stream", streamExit.cause)
        return HttpServerResponse.text(lines.join(""), {
          contentType: "application/x-ndjson",
          headers: { "cache-control": "no-store" }
        })
      }
      if (pathname === MODEL_HOST_CONTEXT_SELECT_PATH) {
        if (request.method !== "POST") return methodNotAllowed()
        if (!authorized(presented)) return forbidden()
        const body = SelectionRequestSchema.safeParse(yield* Effect.interruptible(boundedJson(request)))
        if (!body.success) return refused("request_invalid", 400)
        const { runId, ownerId, contextSelection } = body.data
        const grant: DurableChatGrant = {
          turnId: `context-selection-${runId}`,
          ownerId,
          runId,
          legId: runId,
          generation: 1,
          token: "context_selection_context_selection_12",
          cursor: { version: 1, runId, legId: runId, batch: 0, position: 0, hash: "0".repeat(64) },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          request: { runId, instructions: "", messages: [] },
          producerBaseUrl: callbackBaseUrl
        }
        const exit = yield* Effect.exit(Effect.interruptible(
          options.resolve(grant, contextSelection).pipe(
            Effect.flatMap(({ preflight }) =>
              preflight === undefined
                ? Effect.fail(
                  new ModelError.ModelError({
                    code: "invalid_provider_output",
                    message: "context selector is unavailable"
                  })
                )
                : runContextPreflight(contextSelection, preflight.model, preflight.options)
            )
          )
        ))
        if (Exit.isSuccess(exit)) return json(exit.value.result)
        return refused(classify(exit.cause).response, 502)
      }
      if (pathname !== MODEL_HOST_TURN_PATH) return HttpServerResponse.text("Not found", { status: 404 })
      if (request.method !== "POST") return methodNotAllowed()
      if (!authorized(presented)) return forbidden()
      const grant = decodeGrant(yield* Effect.interruptible(boundedJson(request)), callbackBaseUrl)
      if (grant === undefined) return refused("request_invalid", 400)
      const started = performance.now()
      const exit = yield* Effect.exit(Effect.interruptible(
        options.resolve(grant).pipe(
          Effect.flatMap(({ model, options: modelOptions, preflight }) =>
            Effect.gen(function*() {
              return yield* runDurableChatTurn(
                model,
                { ...grant, ...(options.installOrigin === undefined ? {} : { installOrigin: options.installOrigin }) },
                modelOptions,
                callbackBaseUrl,
                options.fetchImpl,
                preflight,
                options.docs,
                yield* makeHostDiagnostics({ turnId: grant.turnId, write: options.writeDiagnostic }),
                options.observeTransport
              )
            })
          )
        )
      ))
      const elapsed = performance.now() - started
      if (Exit.isSuccess(exit)) {
        yield* Metric.update(Metric.withAttributes(turnDuration, { outcome: "success" }), elapsed)
        return HttpServerResponse.empty({ status: 204 })
      }
      // Provider and transport causes can hold signed requests, so the log line
      // and the response carry the failure class and status codes only. The
      // durable Go boundary records the generic terminal receipt after this
      // refusal.
      const failed = classify(exit.cause)
      yield* Effect.logError("model host turn failed").pipe(
        Effect.annotateLogs({
          failure: failed.failure,
          ...(failed.status === undefined ? {} : { status: failed.status }),
          ...(failed.code === undefined ? {} : { code: failed.code }),
          ...(failed.transport === undefined ? {} : failed.transport),
          turnId: grant.turnId,
          runId: grant.runId,
          generation: grant.generation,
          elapsedMs: Math.round(elapsed)
        })
      )
      yield* Metric.update(Metric.withAttributes(turnFailures, { failure: failed.failure }), 1)
      yield* Metric.update(Metric.withAttributes(turnDuration, { outcome: "failure" }), elapsed)
      return json({
        status: "error",
        code: failed.response,
        ...(failed.transport === undefined ? {} : { transport: failed.transport })
      }, 502)
    })
  ))
}
