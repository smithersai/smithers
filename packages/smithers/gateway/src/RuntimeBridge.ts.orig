/**
 * Versioned JSON boundary between the Go product backend and the canonical
 * TypeScript Flow/Control host.
 *
 * This module adapts HTTP-shaped commands to `Control`. It owns no graph,
 * scheduler, journal, or lifecycle state of its own.
 *
 * @since 1.0.0
 */
import { Control } from "@smthrs/control/Control"
import type * as ControlError from "@smthrs/control/ControlError"
import type { Principal } from "@smthrs/control/ControlSchema"
import { ApprovalPayload, ControlEvent, Receipt, RunSummary, SignalPayload } from "@smthrs/control/ControlSchema"
import { Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

/**
 * The only protocol version accepted by this host.
 * @since 1.0.0
 * @category constants
 */
export const protocol = "smithers.flow-runtime/v1" as const

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const SourceRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const PositiveSafeInteger = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)
const RequestId = Schema.NonEmptyString.check(Schema.isMaxLength(1024))

/**
 * Non-secret identity published by readiness for startup compatibility.
 * @since 1.0.0
 * @category models
 */
export const Identity = Schema.Struct({
  protocol: Schema.Literal(protocol),
  runtimeArtifactDigest: Sha256,
  sourceRevision: SourceRevision,
  ownerGeneration: PositiveSafeInteger
})

/**
 * Non-secret identity published by readiness for startup compatibility.
 * @since 1.0.0
 * @category models
 */
export type Identity = typeof Identity.Type
const common = {
  protocol: Schema.Literal(protocol),
  applicationRequestId: RequestId,
  ownerGeneration: PositiveSafeInteger
}

/**
 * Launches one immutable named flow. Planning and running stay in Control.
 * @since 1.0.0
 * @category models
 */
export const LaunchCommand = Schema.Struct({
  ...common,
  operation: Schema.Literal("launch"),
  attempt: PositiveSafeInteger,
  runtimeArtifactDigest: Sha256,
  sourceRevision: SourceRevision,
  flowId: Schema.NonEmptyString,
  payload: Schema.Json
})

/**
 * Submits an approval or denial payload produced by the same Control host.
 * @since 1.0.0
 * @category models
 */
export const DecisionCommand = Schema.Struct({
  ...common,
  operation: Schema.Literals(["approve", "deny"]),
  approval: ApprovalPayload
})

/**
 * Delivers one durable named signal.
 * @since 1.0.0
 * @category models
 */
export const SignalCommand = Schema.Struct({
  ...common,
  operation: Schema.Literal("signal"),
  runId: Schema.NonEmptyString,
  signal: SignalPayload
})

const Steer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Message"), body: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("Seat"), seat: Schema.NonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("Thinking"),
    thinking: Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh"])
  }),
  Schema.Struct({ kind: Schema.Literal("Tools"), toolNames: Schema.NonEmptyArray(Schema.NonEmptyString) })
])

/**
 * Enqueues one steer for the runtime's next turn boundary.
 * @since 1.0.0
 * @category models
 */
export const SteerCommand = Schema.Struct({
  ...common,
  operation: Schema.Literal("steer"),
  runId: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
  createdAt: Schema.Number,
  steer: Steer
})

/**
 * Requests cancellation or explicit resume.
 * @since 1.0.0
 * @category models
 */
export const LifecycleCommand = Schema.Struct({
  ...common,
  operation: Schema.Literals(["cancel", "resume"]),
  runId: Schema.NonEmptyString,
  reason: Schema.optional(Schema.String)
})

/**
 * Every mutating operation accepted by the bridge.
 * @since 1.0.0
 * @category models
 */
export const Command = Schema.Union([
  LaunchCommand,
  DecisionCommand,
  SignalCommand,
  SteerCommand,
  LifecycleCommand
])

/**
 * Every mutating operation accepted by the bridge.
 * @since 1.0.0
 * @category models
 */
export type Command = typeof Command.Type

/**
 * A bounded, reconnectable read of one canonical runtime execution.
 * @since 1.0.0
 * @category models
 */
export const ObserveRequest = Schema.Struct({
  protocol: Schema.Literal(protocol),
  runId: Schema.NonEmptyString,
  afterCursor: Schema.optional(Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/))),
  limit: Schema.optional(PositiveSafeInteger)
})

/**
 * A bounded, reconnectable read of one canonical runtime execution.
 * @since 1.0.0
 * @category models
 */
export type ObserveRequest = typeof ObserveRequest.Type

/**
 * Host identity fixed for the lifetime of one owning process.
 * @since 1.0.0
 * @category models
 */
export interface Config {
  readonly runtimeArtifactDigest: string
  readonly sourceRevision: string
  /** Captured and verified by native catalog registration, never decoded from a request or environment. */
  readonly verifiedCatalogSourceRevision?: string | undefined
  readonly ownerGeneration: number
  readonly authenticate: (
    headers: Readonly<Record<string, string>>
  ) => Effect.Effect<Principal, ControlError.Unauthorized>
}

/**
 * Stable bridge-only failures. Control failures retain their own code.
 * @since 1.0.0
 * @category errors
 */
export class BridgeError extends Schema.TaggedError<BridgeError>()("@smthrs/gateway/RuntimeBridgeError", {
  code: Schema.Literals([
    "invalid_request",
    "artifact_mismatch",
    "source_mismatch",
    "stale_owner",
    "run_not_found",
    "internal"
  ]),
  message: Schema.String,
  retryable: Schema.Boolean
}) {}

const decodeCommand = Schema.decodeUnknownEffect(Command)
const decodeObserve = Schema.decodeUnknownEffect(ObserveRequest)
const terminal = new Set(["completed", "failed", "cancelled"])
const retryableCodes = new Set(["transport_error", "unavailable", "persistence_failed", "launch_failed"])
const notFoundCodes = new Set(["run_not_found", "flow_not_found", "plan_not_found"])
const conflictCodes = new Set(["stale_owner", "artifact_mismatch", "source_mismatch", "conflict"])
const defaultEventLimit = 250
const maximumEventLimit = 1_000

// Host generation fences who may execute a delivery, but it is not part of
// the durable product request identity. A replacement owner must reconcile a
// lost acknowledgement against the same Control command keys.
const idempotencyKey = (input: Pick<Command, "applicationRequestId">, suffix: string) =>
  `bridge:v1:${input.applicationRequestId}:${suffix}`

const validateOwner = (config: Config, input: Pick<Command, "ownerGeneration">) =>
  input.ownerGeneration === config.ownerGeneration
    ? Effect.void
    : Effect.fail(
      new BridgeError({ code: "stale_owner", message: "Runtime owner generation is stale", retryable: true })
    )

/**
 * Executes one decoded command exclusively through the canonical Control API.
 * @since 1.0.0
 * @category constructors
 */
export const execute = (
  config: Config,
  control: Control["Service"],
  principal: Principal,
  input: Command
) =>
  Effect.gen(function*() {
    yield* validateOwner(config, input)
    switch (input.operation) {
      case "launch": {
        if (input.runtimeArtifactDigest !== config.runtimeArtifactDigest) {
          return yield* Effect.fail(
            new BridgeError({
              code: "artifact_mismatch",
              message: "Runtime artifact digest does not match the owning host",
              retryable: false
            })
          )
        }
        if (input.sourceRevision !== config.sourceRevision) {
          return yield* Effect.fail(
            new BridgeError({
              code: "source_mismatch",
              message: "Flow source revision does not match the owning host",
              retryable: false
            })
          )
        }
        const plan = yield* control.plan({
          flowId: input.flowId,
          input: input.payload,
          idempotencyKey: idempotencyKey(input, "plan")
        })
        // Graphs are optional for valid Flow declarations. Only a verified
        // native catalog snapshot can supply the missing provenance; the
        // configured/wire identity by itself cannot stand in for that proof.
        const plannedSource = plan.graph?.sourceRevision ?? config.verifiedCatalogSourceRevision
        if (plannedSource !== input.sourceRevision) {
          return yield* Effect.fail(
            new BridgeError({
              code: "source_mismatch",
              message: "Flow source revision does not match the immutable request",
              retryable: false
            })
          )
        }
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: plan.planId,
          digest: plan.digest,
          envelope: plan.envelope,
          idempotencyKey: idempotencyKey(input, `run:${input.attempt}`),
          principal
        })
        return {
          operation: input.operation,
          applicationRequestId: input.applicationRequestId,
          ownerGeneration: input.ownerGeneration,
          runtimeArtifactDigest: config.runtimeArtifactDigest,
          sourceRevision: input.sourceRevision,
          planId: plan.planId,
          approval: plan.approval,
          receipt
        } as const
      }
      case "approve":
      case "deny": {
        const request = {
          ...input.approval,
          idempotencyKey: idempotencyKey(input, input.operation),
          principal
        }
        const receipt = yield* input.operation === "approve" ? control.approve(request) : control.deny(request)
        return { operation: input.operation, applicationRequestId: input.applicationRequestId, receipt } as const
      }
      case "signal": {
        const receipt = yield* control.signal({
          runId: input.runId,
          signal: input.signal,
          idempotencyKey: idempotencyKey(input, "signal"),
          principal
        })
        return { operation: input.operation, applicationRequestId: input.applicationRequestId, receipt } as const
      }
      case "steer": {
        const receipt = yield* control.steer({
          runId: input.runId,
          idempotencyKey: idempotencyKey(input, "steer"),
          message: {
            ...input.steer,
            runId: input.runId,
            messageId: input.messageId,
            createdAt: input.createdAt,
            principal
          }
        })
        return { operation: input.operation, applicationRequestId: input.applicationRequestId, receipt } as const
      }
      case "cancel":
      case "resume": {
        const request = {
          runId: input.runId,
          idempotencyKey: idempotencyKey(input, input.operation),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          principal
        }
        const receipt = yield* input.operation === "cancel" ? control.cancel(request) : control.resume(request)
        return { operation: input.operation, applicationRequestId: input.applicationRequestId, receipt } as const
      }
    }
  })

const cursorNumber = (cursor: string | undefined): Effect.Effect<number | undefined, BridgeError> => {
  if (cursor === undefined) return Effect.succeed(undefined)
  const value = Number(cursor)
  return Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(
      new BridgeError({ code: "invalid_request", message: "Observation cursor is out of range", retryable: false })
    )
}

/**
 * Reads a bounded event replay and current canonical run projection.
 * @since 1.0.0
 * @category constructors
 */
export const observe = (control: Control["Service"], input: ObserveRequest) =>
  Effect.gen(function*() {
    const after = yield* cursorNumber(input.afterCursor)
    const limit = Math.min(input.limit ?? defaultEventLimit, maximumEventLimit)
    const listed = yield* control.list({ _tag: "runs", filters: { runId: input.runId }, limit: 1 })
    const summary = listed._tag === "runs" ? listed.items[0] : undefined
    if (summary === undefined) {
      return yield* Effect.fail(
        new BridgeError({ code: "run_not_found", message: "Runtime execution was not found", retryable: true })
      )
    }
    const events = Array.from(
      yield* Stream.runCollect(Stream.take(
        control.watch({ runId: input.runId, ...(after === undefined ? {} : { afterSequence: after }), follow: false }),
        limit + 1
      ))
    )
    const page = events.slice(0, limit)
    const last = page.at(-1)
    return {
      run: summary,
      events: page,
      nextCursor: String(last?.cursor?.sequence ?? last?.sequence ?? after ?? 0),
      hasMore: events.length > limit,
      terminal: terminal.has(summary.status)
    }
  })

/**
 * Successful command response on the JSON wire.
 * @since 1.0.0
 * @category models
 */
export const CommandResponse = Schema.Struct({
  protocol: Schema.Literal(protocol),
  ok: Schema.Literal(true),
  value: Schema.Struct({
    operation: Schema.String,
    applicationRequestId: Schema.String,
    ownerGeneration: Schema.optional(PositiveSafeInteger),
    runtimeArtifactDigest: Schema.optional(Sha256),
    sourceRevision: Schema.optional(SourceRevision),
    planId: Schema.optional(Schema.String),
    approval: Schema.optional(ApprovalPayload),
    receipt: Receipt
  })
})

/**
 * Successful observation response on the JSON wire.
 * @since 1.0.0
 * @category models
 */
export const ObserveResponse = Schema.Struct({
  protocol: Schema.Literal(protocol),
  ok: Schema.Literal(true),
  value: Schema.Struct({
    run: RunSummary,
    events: Schema.Array(ControlEvent),
    nextCursor: Schema.String,
    hasMore: Schema.Boolean,
    terminal: Schema.Boolean
  })
})

/**
 * Stable sanitized failure response on the JSON wire.
 * @since 1.0.0
 * @category models
 */
export const ErrorResponse = Schema.Struct({
  protocol: Schema.Literal(protocol),
  ok: Schema.Literal(false),
  error: Schema.Struct({ code: Schema.String, message: Schema.String, retryable: Schema.Boolean })
})

const errorResponse = (cause: unknown) => {
  const code = typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : "internal"
  const retryable = cause instanceof BridgeError
    ? cause.retryable
    : retryableCodes.has(code)
  const message = cause instanceof BridgeError || cause instanceof Error ? cause.message : "Runtime bridge failed"
  const status = code === "unauthorized" ?
    401
    : notFoundCodes.has(code) ?
    404
    : conflictCodes.has(code) ?
    409
    : retryable ?
    503
    : code === "internal" ?
    500
    : 400
  return HttpServerResponse.jsonUnsafe({ protocol, ok: false, error: { code, message, retryable } }, { status })
}

const readJson = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const text = yield* request.text
  return yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new BridgeError({ code: "invalid_request", message: "Request body must be JSON", retryable: false })
  })
})

const authenticated = <A, E, R>(
  config: Config,
  effect: (principal: Principal) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const principal = yield* config.authenticate(request.headers)
    return yield* effect(principal)
  })

/**
 * Mounts the authenticated JSON bridge beside the existing gateway RPCs.
 * @since 1.0.0
 * @category layers
 */
export const layer = (config: Config) => {
  const command = authenticated(config, (principal) =>
    Effect.gen(function*() {
      const body = yield* readJson
      const input = yield* decodeCommand(body).pipe(Effect.mapError(() =>
        new BridgeError({
          code: "invalid_request",
          message: "Request does not match the runtime bridge contract",
          retryable: false
        })
      ))
      const control = yield* Control
      const value = yield* execute(config, control, principal, input)
      return HttpServerResponse.jsonUnsafe({ protocol, ok: true, value })
    })).pipe(Effect.catch((cause) => Effect.succeed(errorResponse(cause))))

  const observation = authenticated(config, () =>
    Effect.gen(function*() {
      const body = yield* readJson
      const input = yield* decodeObserve(body).pipe(Effect.mapError(() =>
        new BridgeError({
          code: "invalid_request",
          message: "Request does not match the observation contract",
          retryable: false
        })
      ))
      const control = yield* Control
      const value = yield* observe(control, input)
      return HttpServerResponse.jsonUnsafe({ protocol, ok: true, value })
    })).pipe(Effect.catch((cause) => Effect.succeed(errorResponse(cause))))

  return HttpRouter.add("POST", "/runtime/v1/command", command).pipe(
    Layer.merge(HttpRouter.add("POST", "/runtime/v1/observe", observation))
  )
}
