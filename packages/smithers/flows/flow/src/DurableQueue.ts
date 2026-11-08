// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Durable flow queues delegate work to persisted background workers and
 * resume the waiting flow with the worker result.
 *
 * A flow calls `process` to encode a payload, offer it to a named
 * `PersistedQueue`, attach a `DurableDeferred` token, and suspend. A worker
 * created with `makeWorker` or `worker` takes the item, runs the handler, and
 * records the handler's `Exit` through that token so the original flow can
 * continue with the typed success or error.
 *
 * @since 0.1.0
 */

import * as Node from "@smthrs/plan/Node"
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import type * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Filter from "effect/Filter"
import * as Layer from "effect/Layer"
import * as PersistedQueue from "effect/persistence/PersistedQueue"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"
import * as Action from "./Action/index.ts"
import * as DurableDeferred from "./DurableDeferred.vibe"
import * as Fault from "./Fault.ts"
import * as Flow from "./Flow/index.ts"
import { annotateWaiting, FlowInstance, FlowRuntime } from "./FlowRuntime/index.ts"
import * as SpanFailure from "./internal/SpanFailure.vibe"
import * as Interpreter from "./Interpreter.ts"
import * as RetryPolicy from "./RetryPolicy.vibe"

/**
 * Type-level identifier used to recognize `DurableQueue` values.
 *
 * @category type IDs
 * @since 0.1.0
 */
export type TypeId = "@smthrs/flow/DurableQueue"

/**
 * Runtime identifier attached to `DurableQueue` values.
 *
 * @category type IDs
 * @since 0.1.0
 */
export const TypeId: TypeId = "@smthrs/flow/DurableQueue"

/**
 * Durable flow queue definition containing a payload schema, idempotency
 * key, and deferred used to await worker results.
 *
 * @category models
 * @since 0.1.0
 */
export interface DurableQueue<
  Payload extends Schema.Top,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
> {
  readonly [TypeId]: TypeId
  readonly name: string
  readonly payloadSchema: Payload
  readonly idempotencyKey: (payload: Payload["Type"]) => string
  readonly deferred: DurableDeferred.DurableDeferred<Success, Error>
}

/**
 * Creates a `DurableQueue` that waits for persisted items to finish processing
 * using a `DurableDeferred`.
 *
 * **Example** (Defining a durable queue with workers)
 *
 * ```ts
 * import { Action, DurableQueue, Flow, Interpreter } from "@smthrs/flow"
 * import { Effect, Layer, Schema } from "effect"
 *
 * // Define a DurableQueue that can be used to derive workers and offer items for
 * // processing.
 * const ApiQueue = DurableQueue.make({
 *   name: "ApiQueue",
 *   payload: {
 *     id: Schema.String
 *   },
 *   success: Schema.Void,
 *   error: Schema.Never,
 *   idempotencyKey(payload) {
 *     return payload.id
 *   }
 * })
 *
 * // Offering an item is work, so it is a declared Action: the declaration is
 * // pure data, and the implementation attaches separately.
 * const Offer = Action.make("MyFlow/offer", {
 *   payload: {
 *     id: Schema.String
 *   }
 * })
 *
 * const OfferLive = Offer.toLayer(
 *   Effect.fnUntraced(function*({ id }) {
 *     // Add an item to the DurableQueue defined above.
 *     //
 *     // When the worker has finished processing the item, the flow will
 *     // resume.
 *     //
 *     yield* DurableQueue.process(ApiQueue, { id })
 *
 *     yield* Effect.log("Flow succeeded!")
 *   })
 * )
 *
 * // The flow is the composite, and its body names the step it is made of.
 * const MyFlow = Flow.make("MyFlow", {
 *   payload: {
 *     id: Schema.String
 *   },
 *   idempotencyKey: ({ id }) => id,
 *   body: (payload) => Offer.call(payload)
 * })
 *
 * const MyFlowLayer = Layer.mergeAll(OfferLive, Interpreter.layer(MyFlow)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 *
 * // Define a worker layer that can process items from the DurableQueue.
 * const ApiWorker = DurableQueue.worker(
 *   ApiQueue,
 *   Effect.fnUntraced(function*({ id }) {
 *     yield* Effect.log(`Worker processing API call with id: ${id}`)
 *   }),
 *   { concurrency: 5 } // Process up to 5 items concurrently
 * )
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  Payload extends Schema.Top | Schema.Struct.Fields,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
>(options: {
  readonly name: string
  readonly payload: Payload
  readonly idempotencyKey: (
    payload: Payload extends Schema.Struct.Fields ? Schema.Struct.Type<Payload>
      : Payload["Type"]
  ) => string
  readonly success?: Success | undefined
  readonly error?: Error | undefined
}): DurableQueue<
  Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload,
  Success,
  Error
> => ({
  [TypeId]: TypeId,
  name: options.name,
  payloadSchema: Schema.isSchema(options.payload)
    ? options.payload
    : Schema.Struct(options.payload as any) as any,
  idempotencyKey: options.idempotencyKey as any,
  deferred: DurableDeferred.make(`DurableQueue/${options.name}`, {
    success: options.success,
    error: options.error
  })
})

const queueSchemas = new WeakMap<Schema.Top, Schema.Top>()

const getQueueSchema = <Payload extends Schema.Top>(
  payload: Payload
): Schema.Struct<{
  token: typeof DurableDeferred.Token
  payload: Payload
  traceId: typeof Schema.String
  spanId: typeof Schema.String
  sampled: typeof Schema.Boolean
}> => {
  let schema = queueSchemas.get(payload)
  if (!schema) {
    schema = Schema.Struct({
      token: DurableDeferred.Token,
      traceId: Schema.String,
      spanId: Schema.String,
      sampled: Schema.Boolean,
      payload
    })
    queueSchemas.set(payload, schema)
  }
  return schema as any
}

/**
 * Adds an item to the queue and waits for a worker to process it.
 *
 * `retrySchedule` controls retries when the persisted offer fails. The default
 * is unbounded, with exponential delays capped at one minute, so a transient
 * store outage does not lose the item. A caller-supplied schedule may exhaust;
 * its final offer failure becomes a defect to keep the public error channel
 * reserved for the worker's declared error.
 *
 * Payload construction also becomes a defect when `fields` does not satisfy
 * the queue's payload schema. The public error channel is the worker result,
 * not malformed caller input.
 *
 * @category processing
 * @since 0.1.0
 */
export const process: <
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top
>(
  self: DurableQueue<Payload, Success, Error>,
  payload: Payload["~type.make.in"],
  options?: {
    readonly retrySchedule?: Schedule.Schedule<any, PersistedQueue.PersistedQueueError> | undefined
  }
) => Effect.Effect<
  Success["Type"],
  Error["Type"],
  | FlowRuntime
  | FlowInstance
  | (EffectDigest.Digest | SecureRandom.SecureRandom)
  | PersistedQueue.PersistedQueueFactory
  | Payload["EncodingServices"]
  | Payload["DecodingServices"]
  | Success["DecodingServices"]
  | Error["DecodingServices"]
> =
  // Untraced because queue offer is a worker hot path.
  Effect.fnUntraced(function*<
    Payload extends Schema.Top,
    Success extends Schema.Top,
    Error extends Schema.Top
  >(self: DurableQueue<Payload, Success, Error>, fields: Payload["~type.make.in"], options?: {
    readonly retrySchedule?: Schedule.Schedule<any, PersistedQueue.PersistedQueueError> | undefined
  }) {
    const payload = yield* self.payloadSchema.makeEffect(fields).pipe(
      Effect.mapError((issue) => new Schema.SchemaError(issue)),
      Effect.orDie
    )
    const queueName = `DurableQueue/${self.name}`
    const queue = yield* PersistedQueue.make({
      name: queueName,
      schema: getQueueSchema(self.payloadSchema)
    })
    const key = yield* Action.idempotencyKey(queueName, {
      parentScope: self.idempotencyKey(payload)
    })

    const deferred = DurableDeferred.make(`${self.deferred.name}/${key}`, {
      success: self.deferred.successSchema,
      error: self.deferred.errorSchema
    })
    const token = yield* DurableDeferred.token(deferred)

    yield* Effect.useSpan(`DurableQueue/${self.name}/process`, {
      attributes: { key }
    }, (span) =>
      queue.offer({
        token,
        payload,
        traceId: span.traceId,
        spanId: span.spanId,
        sampled: span.sampled
      } as any, { id: key }).pipe(
        Effect.tapCause(() => Effect.logWarning("Queue offer failed")),
        Effect.catchTag("SchemaError", Effect.die),
        Effect.retry(options?.retrySchedule ?? defaultRetrySchedule),
        Effect.orDie,
        Effect.annotateLogs({
          package: "@smthrs/flow",
          module: "DurableQueue",
          fiber: "process",
          queueName: self.name
        })
      ))

    yield* annotateWaiting({ reason: "event", token })
    return yield* DurableDeferred.await(deferred)
  })

const maxDeferredNameExcerptChars = 128

/** Renders a bounded excerpt of a stored deferred name for a diagnostic. */
const deferredNameExcerpt = (name: string): string =>
  name.length <= maxDeferredNameExcerptChars
    ? name
    : `${name.slice(0, maxDeferredNameExcerptChars)} [${name.length - maxDeferredNameExcerptChars} characters dropped]`

const traceIdPattern = /^(?!0{32}$)[0-9a-f]{32}$/
const spanIdPattern = /^(?!0{16}$)[0-9a-f]{16}$/

/**
 * The offering span as the worker span's parent, when the stored ids have the
 * W3C trace-context shape every Effect and OpenTelemetry tracer writes. A
 * stored item is not trusted to splice arbitrary identifiers into a trace.
 */
const externalParent = (item: {
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
}): Tracer.ExternalSpan | undefined =>
  traceIdPattern.test(item.traceId) && spanIdPattern.test(item.spanId)
    ? Tracer.externalSpan({ traceId: item.traceId, spanId: item.spanId, sampled: item.sampled })
    : undefined

const defaultRetrySchedule = Schedule.min([
  Schedule.exponential(500, 1.5),
  Schedule.spaced("1 minute")
])

/**
 * Recording a handler's result failed, so the item's durable execution tries
 * the completion again under its retry policy. The handler is not run again.
 *
 * @category errors
 * @since 1.0.0
 */
export class CompletionUnavailable extends Schema.TaggedError<CompletionUnavailable>()(
  "@smthrs/flow/DurableQueue/CompletionUnavailable",
  { queue: Schema.String }
) {}
Fault.register("@smthrs/flow/DurableQueue/CompletionUnavailable", "infra")

/**
 * How an item's completion is retried: from half a second, growing by half,
 * to a minute between tries, without a limit. A store that comes back records
 * the result; until then the waiting flow stays parked on its own deferred.
 *
 * @category constants
 * @since 1.0.0
 */
export const completionRetryPolicy: RetryPolicy.RetryPolicy = RetryPolicy.make({
  initialMs: 500,
  factor: 1.5,
  maxMs: 60_000
})

/**
 * Every item is redelivered until its execution has run: a take whose
 * execution could not even start keeps the item rather than drop it.
 */
const neverDrop = 2_147_483_647

/** One item's durable execution: the flow, the handler step, and the completion step. */
interface ItemExecution {
  readonly flow: Flow.Flow<
    string,
    Schema.Struct<{ token: typeof DurableDeferred.Token; payload: Schema.Top }>,
    typeof Schema.Void,
    typeof CompletionUnavailable,
    any
  >
  readonly handle: Action.Declared<
    string,
    Schema.Struct<{ token: typeof DurableDeferred.Token; payload: Schema.Top }>,
    Schema.Top,
    typeof Schema.Never
  >
  readonly complete: Action.Declared<
    string,
    Schema.Struct<{ token: typeof DurableDeferred.Token; exit: Schema.Top }>,
    typeof Schema.Void,
    typeof CompletionUnavailable
  >
}

const itemExecutions = new WeakMap<object, ItemExecution>()

/**
 * The durable execution a worker runs each item as: `handle` runs the handler
 * and records its exit, then `complete` records that exit against the
 * caller's deferred. Both are declared per queue, once.
 */
const itemExecutionOf = <Payload extends Schema.Top, Success extends Schema.Top, Error extends Schema.Top>(
  self: DurableQueue<Payload, Success, Error>
): ItemExecution => {
  const cached = itemExecutions.get(self)
  if (cached !== undefined) return cached
  const token = DurableDeferred.Token
  const payload: Schema.Top = self.payloadSchema
  const recorded = Schema.Exit(self.deferred.successSchema, self.deferred.errorSchema, Schema.Defect())
  const handle = Action.make(`DurableQueue/${self.name}/handle`, {
    payload: { token, payload },
    success: recorded,
    // The handler changes the world; until its exit is recorded a crash runs it again, as before, so its repeat
    // must be safe (the queue's documented at-least-once). Once recorded, it is never run again.
    tier: "irreversible",
    idempotencyKey: "handler"
  })
  const complete = Action.make(`DurableQueue/${self.name}/complete`, {
    payload: { token, exit: recorded },
    error: CompletionUnavailable,
    // A deferred keeps the first exit recorded against it, so repeating the completion is safe.
    tier: "irreversible",
    idempotencyKey: "completion",
    retryPolicy: completionRetryPolicy
  })
  const flow = Flow.make(`DurableQueue/${self.name}/item`, {
    payload: { token, payload },
    // The completion is retried without a limit, so this error is never the execution's in practice.
    error: CompletionUnavailable,
    body: Node.capture(
      { handle: handle.name, complete: complete.name },
      (item) =>
        handle.call(item).pipe(
          Node.bindPlanned(
            Node.capture({ complete: complete.name }, (exit) => complete.call({ token: item.token, exit }))
          )
        )
    )
  })
  const execution = { flow, handle, complete } as unknown as ItemExecution
  itemExecutions.set(self, execution)
  return execution
}

const makeWorkerEffect = Effect.fnUntraced(
  function*<
    Payload extends Schema.Top,
    Success extends Schema.Top,
    Error extends Schema.Top,
    R
  >(
    self: DurableQueue<Payload, Success, Error>,
    f: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>,
    concurrency: number
  ) {
    const queue = yield* PersistedQueue.make({
      name: `DurableQueue/${self.name}`,
      schema: getQueueSchema(self.payloadSchema),
      maxAttempts: neverDrop
    })
    const engine = yield* FlowRuntime
    const execution = itemExecutionOf(self)
    // The item flow and its two steps, registered for as long as this worker runs.
    yield* Layer.build(
      Interpreter.layerWithImplementations(
        execution.flow,
        Layer.mergeAll(
          execution.handle.toLayer(({ payload }) =>
            Effect.gen(function*() {
              const exit = yield* Effect.exit(f(payload as Payload["Type"]))
              if (Exit.isSuccess(exit)) return exit
              const [interrupts, reasons] = Arr.partition(
                exit.cause.reasons,
                Filter.fromPredicate(Cause.isInterruptReason)
              )
              // Match DurableDeferred.into: interruption alone is not a durable outcome. The step stops unrecorded,
              // and the item's next delivery runs the handler again.
              if (interrupts.length === exit.cause.reasons.length) {
                return yield* Effect.failCause(Cause.fromReasons<never>(interrupts))
              }
              return interrupts.length > 0 ? Exit.failCause(Cause.fromReasons(reasons)) : exit
            })
          ),
          execution.complete.toLayer(({ exit, token }) =>
            Effect.gen(function*() {
              // The item's execution is named by the deferred it completes (see the take below).
              const instance = yield* FlowInstance
              const deferred = DurableDeferred.make(instance.executionId, {
                success: self.deferred.successSchema,
                error: self.deferred.errorSchema
              })
              yield* DurableDeferred.done(deferred, { token, exit: exit as Exit.Exit<Success["Type"], Error["Type"]> })
            }).pipe(
              // Recorded through the runtime this worker serves, the one the caller's deferred lives in.
              Effect.provideService(FlowRuntime, engine),
              // The worker checked this token against the execution's name before it started it.
              Effect.orDie,
              Effect.catchDefect(() =>
                Effect.logWarning("DurableQueue could not record a handler result; the completion is retried")
                  .pipe(Effect.andThen(Effect.fail(new CompletionUnavailable({ queue: self.name }))))
              )
            )
          )
        )
      )
    )

    const worker = queue.take((item_, metadata) => {
      const item = item_ as {
        readonly token: DurableDeferred.Token
        readonly payload: Payload["Type"]
        readonly traceId: string
        readonly spanId: string
        readonly sampled: boolean
      }
      return Effect.withSpan(
        Effect.gen(function*() {
          // Parse before running anything. A malformed completion address cannot strand a handler result.
          const parsed = yield* DurableDeferred.TokenParsed.parse(item.token)
          // `process` offers each item under its key and addresses the deferred `<queue deferred>/<key>`. Anything
          // else in this queue names a wait point the queue does not own (another queue's item, a WaitFor gate, a
          // human task), so completing it here would settle a foreign wait under this queue's success schema.
          const expected = `${self.deferred.name}/${metadata.id}`
          if (parsed.deferredName !== expected) {
            return yield* new DurableDeferred.TokenInvalid({
              code: "deferred_mismatch",
              message: `The item "${metadata.id}" addresses the deferred "${
                deferredNameExcerpt(parsed.deferredName)
              }", not "${deferredNameExcerpt(expected)}".`
            })
          }
          // The item runs as a durable execution named by its deferred: a redelivery attaches to the same
          // execution, a recorded handler result is replayed rather than run again, and the completion is retried
          // under the engine's policy until it is recorded.
          yield* engine.execute(execution.flow, {
            executionId: expected,
            payload: { token: item.token, payload: item.payload }
          })
        }).pipe(
          Effect.catchTag("@smthrs/flow/DurableDeferred/TokenInvalid", (error) =>
            Effect.logError(
              `DurableQueue "${self.name}" could not complete an item because its token was invalid. ${error.message}`
            ))
        ),
        `DurableQueue/${self.name}/worker`,
        {
          captureStackTrace: false,
          parent: externalParent(item)
        }
      )
    }).pipe(
      // Store failures terminate this worker; its host owns recovery. Item completion retries belong to the engine.
      Effect.tapCause((cause) =>
        Effect.logWarning("DurableQueue worker stopped after a take failure").pipe(
          Effect.annotateLogs({ interrupted: Cause.hasInterrupts(cause) })
        )
      ),
      Effect.orDie,
      Effect.forever,
      Effect.annotateLogs({
        package: "@smthrs/flow",
        module: "DurableQueue",
        fiber: "worker",
        queueName: self.name
      })
    )

    return yield* Effect.replicateEffect(worker, concurrency, { concurrency, discard: true }).pipe(
      Effect.andThen(Effect.never)
    )
  },
  Effect.scoped,
  (effect) =>
    Effect.updateService(effect, Tracer.Tracer, (inner) =>
      Tracer.make({
        ...inner,
        span(options) {
          const span = inner.span(options)
          const end = span.end.bind(span)
          // A successful handle step contains the handler's Exit, including its private failure.
          // Keep that value in durable storage, never in a span's status.
          span.end = (time, result) => end(time, Exit.isSuccess(result) ? Exit.void : SpanFailure.exit(result))
          return span
        }
      }))
)

/**
 * Create a worker effect that processes items from the durable queue.
 *
 * A store take failure terminates the worker as a defect for its host to recover.
 * Each item runs as a durable execution named by its completion address: the
 * handler's exit is recorded as a step, then recorded against the caller's
 * deferred as a second step that the engine retries without a limit. A failure
 * to record the result never runs the handler again, and the caller always
 * receives the handler's exit once the store records it. Until the handler's
 * exit is recorded, a crash runs the handler again, so its side effects must
 * be idempotent.
 *
 * `concurrency` defaults to one and must be a positive safe integer. It is
 * checked before the persisted queue is opened.
 *
 * Invalid concurrency dies with a `RangeError` when the effect runs.
 * @category worker
 * @since 0.1.0
 */
export const makeWorker: <
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R
>(
  self: DurableQueue<Payload, Success, Error>,
  f: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>,
  options?: {
    readonly concurrency?: number | undefined
  } | undefined
) => Effect.Effect<
  never,
  never,
  | FlowRuntime
  | PersistedQueue.PersistedQueueFactory
  | Exclude<R, FlowRuntime | FlowInstance>
  | (EffectDigest.Digest | SecureRandom.SecureRandom)
  | Payload["EncodingServices"]
  | Payload["DecodingServices"]
  | Success["EncodingServices"]
  | Success["DecodingServices"]
  | Error["EncodingServices"]
  | Error["DecodingServices"]
> = <
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R
>(
  self: DurableQueue<Payload, Success, Error>,
  f: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>,
  options?: {
    readonly concurrency?: number | undefined
  }
) =>
  Effect.suspend(() => {
    const concurrency = options?.concurrency ?? 1
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      return Effect.die(
        new RangeError(
          `DurableQueue.makeWorker: concurrency must be a positive safe integer, and was ${concurrency}.`
        )
      )
    }
    return makeWorkerEffect(self, f, concurrency)
  })

/**
 * Create a layer that runs workers for the durable queue.
 *
 * @category worker
 * @since 0.1.0
 */
export const worker: <
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R
>(
  self: DurableQueue<Payload, Success, Error>,
  f: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>,
  options?: {
    readonly concurrency?: number | undefined
  } | undefined
) => Layer.Layer<
  never,
  never,
  | FlowRuntime
  | PersistedQueue.PersistedQueueFactory
  | Exclude<R, FlowRuntime | FlowInstance>
  | (EffectDigest.Digest | SecureRandom.SecureRandom)
  | Payload["EncodingServices"]
  | Payload["DecodingServices"]
  | Success["EncodingServices"]
  | Success["DecodingServices"]
  | Error["EncodingServices"]
  | Error["DecodingServices"]
> = (self, f, options) => Layer.effectDiscard(Effect.forkScoped(makeWorker(self, f, options)))
