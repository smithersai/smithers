/**
 * RPC client layer projected back into the control service interface.
 *
 * @since 0.1.0
 */

import { Cause, Effect, Layer, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient, RpcClientError, type RpcSerialization } from "effect/rpc"
import type { Socket } from "effect/socket"
import { Control, make } from "./Control.vibe"
import { type ControlError, ControlErrorSchema, TransportError, Unauthorized } from "./ControlError.vibe"
import { ControlRpcs } from "./ControlRpcs.vibe"
import {
  ApprovalInputSchema,
  CancelInputSchema,
  ListRequest,
  PlanInputSchema,
  ResumeInputSchema,
  RunInputSchema,
  SignalInputSchema,
  SteerInputSchema,
  WatchFilter
} from "./ControlSchema.vibe"

/**
 * Whether a value is one of the control plane's declared failures, as opposed
 * to a defect that escaped some other layer.
 *
 * Derived from `ControlError.ControlErrorSchema` rather than restated, so a new
 * error class cannot be a member of the union and a stranger to the client.
 *
 * @category refinements
 * @since 0.1.0
 */
export const isControlError = Schema.is(ControlErrorSchema)

interface TransportClassification {
  readonly message: string
  readonly retryable: boolean
}

const requestEncoding: TransportClassification = {
  message: "The control request could not be encoded.",
  retryable: false
}

const responseDecoding: TransportClassification = {
  message: "The control response could not be decoded.",
  retryable: false
}

const connectionFailure: TransportClassification = {
  message: "The control server could not be reached.",
  retryable: true
}

const clientHttpFailure: TransportClassification = {
  message: "The control server rejected the HTTP request.",
  retryable: false
}

const serverHttpFailure: TransportClassification = {
  message: "The control server failed while handling the HTTP request.",
  retryable: true
}

const invalidClientUrl: TransportClassification = {
  message: "The control server URL is invalid.",
  retryable: false
}

const unknownClientFailure: TransportClassification = {
  message: "The control RPC client failed.",
  retryable: false
}

const transportError = (cause: unknown, classification: TransportClassification): TransportError =>
  new TransportError({
    ...classification,
    cause
  })

// A `StatusCodeError` reported by the RPC client always carries the concrete
// error, and that error always carries its response. The three refusals below
// are what keeps a hand-built wrapper without one from being read as a 5xx and
// retried forever; none of them is reachable from the client's own transports.
const statusFrom = (cause: unknown): number | undefined => {
  /* v8 ignore next -- a StatusCodeError cause always carries its response */
  if (typeof cause !== "object" || cause === null || !("response" in cause)) return undefined
  const response = cause.response
  /* v8 ignore next -- as above: the response is an object carrying a status */
  if (typeof response !== "object" || response === null || !("status" in response)) return undefined
  /* v8 ignore next -- as above: the status is a number */
  return typeof response.status === "number" ? response.status : undefined
}

type HttpFailureKind = Extract<RpcClientError.RpcClientError["reason"], { readonly _tag: "HttpError" }>["kind"]
type TransportReason = RpcClientError.RpcClientError["reason"]["_tag"]

/**
 * What each HTTP failure means for a retry.
 *
 * `StatusCodeError` is absent on purpose: it is the one kind whose answer
 * depends on the response, not on the kind.
 */
const httpClassification: Record<Exclude<HttpFailureKind, "StatusCodeError">, TransportClassification> = {
  TransportError: connectionFailure,
  EncodeError: requestEncoding,
  InvalidUrlError: invalidClientUrl,
  DecodeError: responseDecoding,
  EmptyBodyError: responseDecoding
}

/**
 * What each non-HTTP transport failure means for a retry.
 *
 * A table rather than a switch, because the mapping is data: the compiler
 * still requires every reason the RPC client can report to have an answer, and
 * a reader can check the whole policy at a glance.
 */
const reasonClassification: Record<Exclude<TransportReason, "HttpError">, TransportClassification> = {
  RpcClientDefect: responseDecoding,
  SocketReadError: connectionFailure,
  SocketWriteError: connectionFailure,
  SocketOpenError: connectionFailure,
  // The socket cannot perform a requested protocol upgrade; retries of the
  // same unsupported operation cannot change that host capability.
  SocketUpgradeError: unknownClientFailure,
  SocketCloseError: connectionFailure,
  // A worker transport is not composable with this client, which speaks HTTP
  // and WebSocket. The entries exist so the table stays exhaustive.
  WorkerSpawnError: unknownClientFailure,
  WorkerSendError: unknownClientFailure,
  WorkerReceiveError: unknownClientFailure,
  WorkerUnknownError: unknownClientFailure
}

const classifyRpcClientError = (error: RpcClientError.RpcClientError): TransportClassification => {
  const reason = error.reason
  if (reason._tag !== "HttpError") return reasonClassification[reason._tag]
  if (reason.kind !== "StatusCodeError") return httpClassification[reason.kind]
  // Effect's serializable HttpError keeps the concrete StatusCodeError in
  // `cause`. The wrapper has no separate status field, so a hand-built wrapper
  // without that cause cannot safely be classified as retryable and falls back
  // to the client class.
  const status = statusFrom(reason.cause)
  return status !== undefined && status >= 500 && status <= 599
    ? serverHttpFailure
    : clientHttpFailure
}

const isRpcClientError = Schema.is(RpcClientError.RpcClientError)

const classify = (error: unknown): TransportClassification => {
  if (Schema.isSchemaError(error)) return responseDecoding
  if (isRpcClientError(error)) return classifyRpcClientError(error)
  return unknownClientFailure
}

// Preserve the operation-specific control failures from the RPC schema while
// replacing transport and decoding failures with the public TransportError.
const normalizedFailure = <E>(cause: Cause.Cause<E>): Effect.Effect<never, (E & ControlError) | TransportError> => {
  const failure = Cause.findError(cause)
  if (Result.isSuccess(failure)) {
    return Effect.fail(
      isControlError(failure.success)
        ? failure.success
        : transportError(failure.success, classify(failure.success))
    )
  }
  const defect = Cause.findDefect(cause)
  // A cause with neither a failure nor a defect is an interruption, and an
  // operator's own cancellation is not the server failing. It is re-raised
  // exactly as it arrived rather than described as a transport failure.
  /* v8 ignore next 2 -- the fiber propagates an interrupt-only cause without reaching this operator */
  return Result.isSuccess(defect)
    ? Effect.fail(transportError(defect.success, classify(defect.success)))
    : Effect.failCause(cause as Cause.Cause<(E & ControlError) | TransportError>)
}

const normalize = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, (E & ControlError) | TransportError, R> =>
  Effect.catchCause(effect, normalizedFailure)

type RequestEncoder = (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>

const encoder = (schema: Schema.Top): RequestEncoder =>
  // Every request schema in this module is service-free. `Schema.Top` erases
  // that fact to `unknown`, so restore it at this one construction boundary.
  Schema.encodeUnknownEffect(Schema.toCodecJson(schema)) as RequestEncoder

const planEncoder = encoder(PlanInputSchema)
const runEncoder = encoder(RunInputSchema)
const approvalEncoder = encoder(ApprovalInputSchema)
const steerEncoder = encoder(SteerInputSchema)
const signalEncoder = encoder(SignalInputSchema)
const cancelEncoder = encoder(CancelInputSchema)
const resumeEncoder = encoder(ResumeInputSchema)
const listEncoder = encoder(ListRequest)
const watchEncoder = encoder(WatchFilter)

const normalizeRequest = <A, E, R>(
  encode: RequestEncoder,
  input: unknown,
  request: () => Effect.Effect<A, E, R>
): Effect.Effect<A, (E & ControlError) | TransportError, R> =>
  encode(input).pipe(
    Effect.mapError((cause) => transportError(cause, requestEncoding)),
    Effect.andThen(Effect.suspend(() => normalize(request())))
  )

const normalizeStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>
): Stream.Stream<A, (E & ControlError) | TransportError, R> =>
  Stream.catchCause(stream, (cause) => Stream.fromEffect(normalizedFailure(cause)))

const normalizeStreamRequest = <A, E, R>(
  encode: RequestEncoder,
  input: unknown,
  request: () => Stream.Stream<A, E, R>
): Stream.Stream<A, (E & ControlError) | TransportError, R> =>
  Stream.unwrap(
    encode(input).pipe(
      Effect.mapError((cause) => transportError(cause, requestEncoding)),
      Effect.map(() => normalizeStream(request()))
    )
  )

/**
 * Client transport configuration. Unary procedures use HTTP at this URL;
 * `watch` uses HTTP when a credential is supplied, so the same bearer protects
 * unary calls and streams without requiring a WebSocket service. Without a
 * credential it defaults to the platform's abstract WebSocket. `watchTransport`
 * selects either explicitly; a socket's upgrade authentication belongs to the
 * supplied platform Socket layer.
 *
 * @category models
 * @since 0.1.0
 */
export interface ClientConfig {
  readonly url: string
  /** Bearer token attached to every HTTP RPC request when present. */
  readonly credential?: string | undefined
  /** Defaults to HTTP with a credential, socket otherwise. */
  readonly watchTransport?: "http" | "socket" | undefined
}

/**
 * Provides `Control` through an RPC client while preserving the local vtable.
 *
 * @category layers
 * @since 0.1.0
 */
export function layer(
  config:
    & ClientConfig
    & ({ readonly watchTransport: "http" } | {
      readonly credential: string
      readonly watchTransport?: "http" | undefined
    })
): Layer.Layer<Control, never, HttpClient.HttpClient | RpcSerialization.RpcSerialization>
export function layer(
  config: ClientConfig
): Layer.Layer<Control, never, HttpClient.HttpClient | RpcSerialization.RpcSerialization | Socket.Socket>
export function layer(config: ClientConfig) {
  const http = RpcClient.layerProtocolHttp({
    url: config.url,
    transformClient: (client) => {
      // The RPC protocol already admits HttpClientError, but transformClient's
      // generic signature cannot express that filtering adds the same error
      // its input client already carries.
      const checked = HttpClient.filterStatusOk(client) as typeof client
      return config.credential === undefined
        ? checked
        : HttpClient.mapRequest(checked, HttpClientRequest.bearerToken(config.credential))
    }
  })
  const watchTransport = config.watchTransport ?? (config.credential === undefined ? "socket" : "http")
  return Layer.effect(
    Control,
    Effect.gen(function*() {
      // Built into the layer's own scope: `Effect.provide(layer)` would close
      // each protocol as soon as the client was constructed.
      const httpServices = yield* Layer.build(http)
      const unary = yield* RpcClient.make(ControlRpcs).pipe(Effect.provide(httpServices))
      const streaming = watchTransport === "http" ? unary : yield* Effect.gen(function*() {
        const services = yield* Layer.build(RpcClient.layerProtocolSocket())
        return yield* RpcClient.make(ControlRpcs).pipe(Effect.provide(services))
      })
      return make({
        plan: Effect.fn("Control.plan")((input) => normalizeRequest(planEncoder, input, () => unary.Plan(input))),
        run: Effect.fn("Control.run")((input) => normalizeRequest(runEncoder, input, () => unary.Run(input))),
        // RPC authenticates with this client's credential and does not carry
        // local attribution. Refuse here before an agent becomes that operator.
        approve: Effect.fn("Control.approve")((input) =>
          normalizeRequest(approvalEncoder, input, () =>
            input.principal?.kind === "agent"
              ? Effect.fail(new Unauthorized({ message: "Approval decisions are operator-only" }))
              : unary.Approve(input))
        ),
        deny: Effect.fn("Control.deny")((input) =>
          normalizeRequest(approvalEncoder, input, () =>
            input.principal?.kind === "agent"
              ? Effect.fail(new Unauthorized({ message: "Approval decisions are operator-only" }))
              : unary.Deny(input))
        ),
        steer: Effect.fn("Control.steer")((input) => normalizeRequest(steerEncoder, input, () => unary.Steer(input))),
        signal: Effect.fn("Control.signal")((input) =>
          normalizeRequest(signalEncoder, input, () =>
            input.principal?.kind === "agent"
              ? Effect.fail(new Unauthorized({ message: "Agent signals require an agent credential" }))
              : unary.Signal(input))
        ),
        cancel: Effect.fn("Control.cancel")((input) =>
          normalizeRequest(cancelEncoder, input, () => unary.Cancel(input))
        ),
        resume: Effect.fn("Control.resume")((input) =>
          normalizeRequest(resumeEncoder, input, () => unary.Resume(input))
        ),
        list: Effect.fn("Control.list")((input) => normalizeRequest(listEncoder, input, () => unary.List(input))),
        watch: (input) => normalizeStreamRequest(watchEncoder, input, () => streaming.Watch(input))
      })
    })
  )
}
