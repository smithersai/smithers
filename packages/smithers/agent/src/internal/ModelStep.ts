/**
 * The one implementation of a durable model call: its key, its recorder and
 * its action.
 *
 * `ModelStep.run` is the public face and `FlowEngineLike` the harness's; both
 * dispatch through {@link dispatch}. The hooks only the harness needs (budget
 * accounting, quota parking, the overrun budget and the correction ordinal)
 * stay behind the package's null-mapped `internal/*` export, so they never
 * become a public compatibility promise.
 *
 * @since 1.0.0-rc.0
 */

import { Permission } from "@smthrs/capability"
import { Digest, type KeyMaterial } from "@smthrs/core"
import { Action, FlowRuntime, RetryPolicy, RunMetrics, SpanFailure } from "@smthrs/flow"
import { EngineLike, HarnessError } from "@smthrs/harness"
import { Model, ModelError, ModelEvent, ModelRequest, RequestExecutor, type Route } from "@smthrs/model"
import { StepKey } from "@smthrs/plan"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { tokensOf } from "../Budget.ts"

/**
 * The durable outcome of one sealed model step.
 *
 * The array branch is the format written before model-boundary retries were
 * introduced. Keeping it decodable matters because a parked run may resume
 * against a newer agent package and replay that already-settled activity.
 * New records always use the object branch so a terminal typed model failure
 * can be replayed after its retry events.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RecordedModelStep = Schema.Union([
  Schema.Array(ModelEvent.ModelEvent),
  Schema.Struct({
    events: Schema.Array(ModelEvent.ModelEvent),
    error: Schema.optional(ModelError.ModelError),
    /**
     * Which structured-output correction this call belonged to, when the
     * caller was running a correction ladder.
     *
     * The ordinal is durable twice over, and only one of the two is readable.
     * Each correction is its own session — `${executionId}/${tag}#${n}` — so
     * the ladder's rungs already have distinct sealed step keys and a replay
     * reproduces all of them; but a session is KEY MATERIAL, hashed into a
     * digest, and nothing downstream can read an ordinal back out of it. An
     * operator or a projection reading a run's steps could see three sealed
     * model calls and not which was the ask and which were its corrections.
     * The field is that answer, on the record itself.
     *
     * Optional because it is absent from two honest cases: a model call made
     * outside a correction ladder, and a record written before this field
     * existed, which a parked run may still resume onto.
     */
    correction: Schema.optional(Schema.Int)
  })
])

/**
 * A recorded model step in its object form, which every new record takes.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export interface Recorded {
  readonly events: ReadonlyArray<ModelEvent.ModelEvent>
  readonly error?: ModelError.ModelError | undefined
  readonly correction?: number | undefined
}

/**
 * Reads either recorded-model-step branch as the object form.
 *
 * @category conversions
 * @since 0.1.0
 */
export const normalizeRecordedModelStep = (recorded: typeof RecordedModelStep.Type): Recorded =>
  "events" in recorded ? recorded : { events: recorded, error: undefined, correction: undefined }

/**
 * Everything a model step's action may fail with, as one encodable schema:
 * the engine stores an action's failure as well as its success, so the error
 * channel cannot be an opaque value. The member order is key material (the
 * engine digests the declaration), so it never changes.
 *
 * @category schemas
 * @since 1.0.0-rc.16
 */
export const Failure = Schema.Union([
  ModelError.ModelError,
  Permission.PermissionRequired,
  Permission.PermissionDenied,
  Permission.GrantStoreError,
  HarnessError.HarnessError
])

/**
 * The engine retry policy of the agent loop's model steps.
 *
 * Every provider attempt is one engine attempt, so the attempt number, its
 * backoff and its usage survive a process restart: the engine restores the
 * attempt sequence from its own records, and each failed attempt's spend is
 * recorded as that attempt ends.
 *
 * Only a `transport` failure and a `provider_internal` refusal retry. A
 * transport-class failure is almost never local: a destroyed HTTP/2 session, a
 * 5xx, an overloaded provider. All three persist for seconds to tens of
 * seconds, so a retry that fires inside that window is a wasted attempt, and a
 * budget that empties inside it turns one provider incident into a dead run.
 * Wave 4 of the SWE-bench harness lost `pytest-dev__pytest-6197` exactly that
 * way. Doubling from one second across five retries spans about 31 s, and
 * jitter keeps a fleet of runs that hit one incident from re-converging on the
 * provider in lockstep. A rate limit or a spent quota never retries here: it
 * reaches the controller, which parks on it.
 *
 * On the last attempt the step seals a transport failure as its value, as it
 * seals every terminal answer, so a replay reads the same error without asking
 * the provider again; a `provider_internal` refusal still reaches the
 * controller. A policy a host supplies in its place must bound `maxAttempts`
 * for the same reason.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelRetryPolicy: RetryPolicy.RetryPolicy = RetryPolicy.make({
  initialMs: 1_000,
  factor: 2,
  maxMs: 16_000,
  maxAttempts: 6,
  jitterRatio: 0.2,
  retryable: [
    { tag: "flows/model/ModelError", code: "transport" },
    { tag: "flows/model/ModelError", code: "provider_internal" }
  ]
})

const seconds = (millis: number): number => Math.round(millis / 1000)

/** Final cumulative counters from distinct provider attempts, counted once each. */
const combineUsage = (usages: ReadonlyArray<ModelEvent.Usage>): ModelEvent.Usage => {
  const combined: Record<string, number> = { totalTokens: usages.reduce((sum, usage) => sum + tokensOf(usage), 0) }
  for (const usage of usages) {
    for (const [key, value] of Object.entries(usage)) {
      if (key !== "totalTokens" && value !== undefined) combined[key] = (combined[key] ?? 0) + value
    }
  }
  return combined
}

/**
 * How many times one sealed step re-issues a call its budget cut off.
 *
 * The retry budget the transport codes share cannot be shared with an overrun,
 * because the two cost different things. A dropped session fails in
 * milliseconds, so five retries of it cost five backoffs; an overrun fails
 * only after spending the whole armed ceiling, so five retries of it cost five
 * ceilings. On the wave 7 default of 300,000 ms that is a single sealed step
 * spending 1,800 s of wall clock — 150% of the 1,200 s process budget that
 * wave gave a whole run, and 2.7x the 667 s call the budget was written to
 * bound. A budget that multiplies the failure it names is not a budget.
 *
 * One re-issue is the number the mechanism supports. Waiting cannot shorten an
 * answer, so the only thing a re-issue adds is {@link overrunTeaching}, and a
 * model that overran again *after* being told to answer directly has already
 * shown the teaching did not land; a third ask costs another full ceiling and
 * buys nothing new. With one re-issue a step spends at most twice the armed
 * budget — 600 s at the default, under the 667 s single call that motivated
 * the ceiling — and then fails the frame with the typed error, which is a
 * bound a report can state.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelOverruns = 1

/**
 * Milliseconds a model stream may go without one event before it is cut off.
 *
 * A call's ceiling bounds how long it may take; this bounds how long it may
 * say nothing. The two fail differently. A long call that keeps streaming is
 * a model at work: Terminal-Bench 4.0's photonic-waveguide-routing
 * (2026-09-24) needed a 735 s design turn at `max` effort, and a total
 * ceiling short enough to catch a stall killed it. A stream that goes silent
 * is usually a dead socket or a stuck backend, and waiting out a long ceiling
 * on one is the cost this bound removes.
 *
 * 300,000 ms is stock Codex's `stream_idle_timeout_ms` default. The ChatGPT
 * route asks for reasoning summaries, so a long think streams summary deltas
 * and reasoning items: one live `gpt-6-sol` call at `high` effort on
 * 2026-09-24 streamed an event at least every 10 s. A stall is a transport
 * failure, re-issued without the overrun teaching, because the model did
 * nothing that needs correcting, and at most {@link defaultModelOverruns}
 * times, because each stall costs a whole window.
 *
 * The bound follows the request's `params.reasoningEffort`, as the ceiling
 * does:
 *
 * | effort                                            | idle bound |
 * | ------------------------------------------------- | ---------- |
 * | unset, `none`, `minimal`, `low`, `medium`, `high` | 300 s      |
 * | `xhigh`, `max`                                    | none       |
 *
 * At `xhigh` and `max` silence is not evidence of a stall. The steady stream
 * measured at `high` does not hold there, and a route that emits an event only
 * when an item completes, such as the Codex CLI route, says nothing through a
 * whole think: on Terminal-Bench 4.0 `wal-recovery-ordering` (2026-10-02) a
 * `gpt-6.1-sol` turn at `max` was cut off after 300 s of silence and the trial
 * was lost. Those calls are bounded by their ceiling alone, so a dead socket
 * there costs the whole ceiling and ends as `call_timeout`.
 *
 * Armed only when it is shorter than the call's ceiling, so a ceiling at or
 * below it is the only bound, as it was before this existed; a disarmed
 * ceiling disarms it too.
 *
 * @category policies
 * @since 1.0.0-rc.0
 */
export const defaultModelIdleMs = 300_000

/** The idle bound for one request: {@link defaultModelIdleMs}, or none at `xhigh` and `max`. */
const modelIdleMsFor = (effort: ModelRequest.ReasoningEffort | undefined): number | undefined => {
  switch (effort) {
    case "xhigh":
    case "max":
      return undefined
    default:
      return defaultModelIdleMs
  }
}

/**
 * What a re-issued call tells the model about the attempt that was cut off.
 *
 * A transport failure is repaired by waiting; an overrun is not. The provider
 * would happily spend the budget again on the same answer, so the re-issue has
 * to say something the first attempt did not, and the only party that can
 * shorten the answer is the model. The note is deliberately terse and states
 * one instruction, because it is prepended to a system context that already
 * carries the cell contract, the task, and the run's state.
 *
 * It says nothing about how many attempts have been spent, because
 * {@link defaultModelOverruns} allows exactly one: a call carrying this note is
 * always the last one the step will make.
 *
 * @category policies
 * @since 0.1.0
 */
export const overrunTeaching = (budgetMillis: number): string =>
  `Time budget — your previous answer ran past this run's ${
    seconds(budgetMillis)
  }-second budget for one model call and was cut off before it finished, so none of it survives, and this is the last attempt this step will make. Answer directly this time: decide with the evidence you already have, keep the reasoning short, and emit the cell.`

/**
 * Re-issues one overrun call with the teaching prepended to its system context.
 *
 * The teaching goes at the front of `system` rather than at the end of the
 * transcript because the transcript is the cell's to shape — the controller
 * replaces it wholesale each frame from what the cell projected — while the
 * system context is the run's stable teaching, which is where an instruction
 * about how to answer belongs. The original request is never mutated; a later
 * attempt re-derives from it, so two overruns leave one note rather than two.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withOverrunTeaching = (
  request: ModelRequest.ModelRequest,
  budgetMillis: number
): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    ...request,
    system: [
      ModelRequest.SystemPart.make({ text: overrunTeaching(budgetMillis) }),
      ...request.system
    ]
  })

/**
 * How {@link recordModelStep} treats one engine attempt.
 *
 * @category models
 * @since 1.0.0
 */
export interface RecordOptions {
  /** The overrun budget of one provider call; absent or zero disarms it. */
  readonly budgetMillis?: number | undefined
  /** The correction ordinal stamped onto the record. */
  readonly correction?: number | undefined
  /**
   * Observes cumulative spend across this attempt's provider calls. The caller
   * uses its last snapshot when no sealed value survives (capacity refusal,
   * permission failure, interruption, a transport failure the engine retries);
   * partial text is never exposed. It must be synchronous and do no I/O.
   */
  readonly onUsage?: ((usage: ModelEvent.Usage) => void) | undefined
  /** Receives each event live, a re-issue's `retry` event included. */
  readonly onEvent?: ((event: ModelEvent.ModelEvent) => Effect.Effect<void>) | undefined
  /**
   * Re-issue one overrun, with {@link overrunTeaching}, and one stall inside
   * the attempt, and bound the stream's silence by
   * {@link modelIdleMsFor}. Off, an overrun is sealed as `call_timeout` at
   * once and silence is the action heartbeat's to bound.
   */
  readonly reissue: boolean
  /**
   * Whether this is the step's last attempt: a transport failure is then sealed
   * as the step's value instead of failing for the engine to retry.
   */
  readonly final: boolean
  /**
   * Seal a capacity refusal that no wait can clear (`isTerminalRefusal` in
   * `@smthrs/model`: an HTTP 402, or a quota with no reset and no account
   * scope it could wait on) as the step's value, so a caller with no quota
   * controller of its own doesn't ask again. Off when absent: every capacity
   * refusal fails the attempt unsealed for the controller.
   */
  readonly sealTerminal?: boolean | undefined
}

/**
 * Makes one engine attempt of a model step: one provider call, and at most one
 * in-step re-issue each of an overrun and a stall when `reissue` is set.
 *
 * Retrying a transient failure is the engine's, never the step's: a
 * `transport` failure fails the attempt unsealed, so the action's
 * `retryPolicy` decides whether another attempt runs and how long it waits,
 * honoring any `retryAfterMillis` the provider named, and the attempt count
 * survives a restart. A route's `RequestExecutor` repeats nothing either: one
 * attempt is one request. On the `final` attempt a transport failure is sealed
 * as the step's value. A capacity refusal fails unsealed for the controller,
 * unless `sealTerminal` is set and no wait can clear it. Every other answer, an
 * error included, is sealed.
 *
 * The overrun and the stall are re-issued here rather than by the engine
 * because they are not transient refusals: each already cost a whole budget or
 * idle window, and the overrun's re-issue changes the request by putting
 * {@link overrunTeaching} in front of it. Each is re-issued at most
 * {@link defaultModelOverruns} times, after which it is sealed. A re-issue
 * emits a `retry` event, so a consumer folding live events discards the
 * partial output before it, and its spend is folded into the sealed usage.
 *
 * `budgetMillis` bounds one provider call: a call that runs past it is
 * interrupted (closing its scope tears the request down) and classified
 * `call_timeout`.
 *
 * @category execution
 * @since 0.1.0
 */
export const recordModelStep = (
  model: Model.Model,
  request: ModelRequest.ModelRequest,
  options: RecordOptions
): Effect.Effect<Recorded, Model.ModelFailure> =>
  Effect.suspend(() => {
    const { onEvent, onUsage, reissue } = options
    const reissues: Array<ModelEvent.ModelEvent> = []
    const failedUsage: Array<ModelEvent.Usage> = []
    let attemptUsage: ModelEvent.Usage = {}
    /** When the call in flight was issued, so a re-issue can say how long the cut-off one ran. */
    let callStartedAt = 0
    /** The calls this attempt cut off at the budget; each cost a whole budget. */
    const overruns = new Set<Model.ModelFailure>()
    /** The calls this attempt cut off for silence; each cost a whole idle window. */
    const stalls = new Set<Model.ModelFailure>()
    const budget = options.budgetMillis === undefined || options.budgetMillis <= 0 ? undefined : options.budgetMillis
    const idleFor = reissue ? modelIdleMsFor(request.params.reasoningEffort) : undefined
    const idle = budget !== undefined && idleFor !== undefined && idleFor < budget ? idleFor : undefined
    const silent = <A>(stream: Stream.Stream<A, Model.ModelFailure>): Stream.Stream<A, Model.ModelFailure> =>
      idle === undefined ? stream : stream.pipe(Stream.timeoutOrElse({
        duration: idle,
        orElse: () =>
          Stream.fromEffect(Effect.suspend(() => {
            const error = new ModelError.ModelError({
              code: "transport",
              message: `The model stream sent nothing for ${seconds(idle)} seconds and was cut off`
            })
            stalls.add(error)
            return Effect.fail(error)
          }))
      }))
    // Every call, every event it streams and every chunk of bytes the provider
    // sends (a keep-alive included, through `Model.Liveness`) is a heartbeat,
    // so an action declared with `heartbeatTimeoutMs` fails only a call that
    // goes silent. Outside such an action a heartbeat does nothing.
    const collect = (input: ModelRequest.ModelRequest) =>
      Effect.flatMap(Clock.currentTimeMillis, (issuedAt) => {
        callStartedAt = issuedAt
        attemptUsage = {}
        const streamed = model.stream(input).pipe(
          Model.withGenAiSpan(input, model.providerName),
          Stream.provideService(Model.Liveness, Action.heartbeat),
          // The engine decides retries, so a route's executor repeats nothing:
          // one attempt is one request.
          Stream.provideService(RequestExecutor.Retries, 0)
        )
        return Action.heartbeat.pipe(Effect.andThen(Stream.runCollect(
          silent(streamed).pipe(Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type !== "usage") return
              const { type: _type, ...usage } = event
              attemptUsage = {
                ...attemptUsage,
                ...Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined))
              }
              onUsage?.(combineUsage([...failedUsage, attemptUsage]))
            }).pipe(Effect.andThen(Action.heartbeat), Effect.andThen(onEvent?.(event) ?? Effect.void))
          ))
        )))
      })
    // Suspended so each call reads the overruns the call before it left: that
    // is what puts the teaching on a re-issue and never on the first call.
    const collected = Effect.suspend(() =>
      budget === undefined
        // Disarmed. The call is bounded by nothing but the caller's own process.
        ? collect(request)
        : collect(overruns.size === 0 ? request : withOverrunTeaching(request, budget)).pipe(
          Effect.timeoutOrElse({
            duration: budget,
            orElse: () =>
              Effect.suspend(() => {
                const error = new ModelError.ModelError({
                  code: "call_timeout",
                  message: `The model call ran past its ${seconds(budget)}-second budget and was interrupted`
                })
                overruns.add(error)
                return Effect.fail(error)
              })
          })
        )
    )
    // A response body that ends without a settlement is a dead socket.
    // `Stream.runCollect` *succeeds* on a truncated body, `settledMessage` would
    // fold its events into an `aborted` message, and the controller would raise
    // `model_failed`, a `HarnessError` no retry classification ever sees: one
    // dropped HTTP/2 session, no backoff, run over. Two r91 instances were lost
    // to that class. Classifying it as `transport` puts it on the same engine
    // retries every other socket failure takes. It cannot be confused with an
    // interruption: an interrupted fiber never reaches here with a value, and a
    // settled stream always carries its settlement.
    const callOnce = Effect.flatMap(collected, (events) =>
      Array.from(events).some((event) => event.type === "settle")
        ? Effect.succeed(events)
        : Effect.fail(
          new ModelError.ModelError({
            code: "transport",
            message: "The model response stream ended without a settlement"
          })
        )).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (Object.keys(attemptUsage).length > 0) failedUsage.push(attemptUsage)
          })
        ),
        // The failure is recorded and re-raised from its record, which is its
        // schema and nothing else: the wire timing the model package attached
        // to the live error ends here unless it is reported now.
        Effect.tapError((error) =>
          error instanceof ModelError.ModelError && error.timing !== undefined
            ? Effect.flatMap(EngineLike.FailedTimings, (report) => report(error.timing!))
            : Effect.void
        )
      )
    // One cut-off call of each kind is re-issued in place, and the re-issue
    // says so. Only a call this attempt cut off qualifies: a provider's own
    // `call_timeout` is its answer, sealed like any other.
    const reissuable = (error: Model.ModelFailure): error is ModelError.ModelError =>
      reissue &&
      ((overruns.has(error) && overruns.size <= defaultModelOverruns) ||
        (stalls.has(error) && stalls.size <= defaultModelOverruns))
    const call: Effect.Effect<ReadonlyArray<ModelEvent.ModelEvent>, Model.ModelFailure> = callOnce.pipe(
      Effect.catchIf(reissuable, (error) =>
        Effect.gen(function*() {
          const failedAt = yield* Clock.currentTimeMillis
          // Both cut-off errors are this attempt's own, so neither carries a
          // status, and the re-issue follows at once.
          const retry = ModelEvent.ModelEvent.Retry({
            type: "retry",
            attempt: reissues.length + 1,
            code: error.code,
            delayMillis: 0,
            elapsedMs: Math.max(0, Math.round(failedAt - callStartedAt))
          })
          reissues.push(retry)
          if (onEvent !== undefined) yield* onEvent(retry)
          return yield* call
        }))
    )

    // Partial text from a re-issued call is unsafe to replay, but its usage is
    // actual spend. Keep each call's final counters, then fold them into one
    // usage event for the sealed step. Spend of an earlier engine attempt is
    // not here: that attempt recorded its own as it ended.
    const accountReissued = (
      events: ReadonlyArray<ModelEvent.ModelEvent>
    ): ReadonlyArray<ModelEvent.ModelEvent> => {
      if (failedUsage.length === 0) return events
      const combined = combineUsage([...failedUsage, ModelEvent.ModelEvent.settledMessage(events).usage])
      const result: Array<ModelEvent.ModelEvent> = events.filter((event) => event.type !== "usage")
      const settlement = result.findIndex((event) => event.type === "settle")
      result.splice(settlement < 0 ? result.length : settlement, 0, ModelEvent.ModelEvent.Usage(combined))
      return result
    }
    // Spread rather than always present: a call outside a correction ladder has
    // no ordinal, and writing one anyway would make every ordinary model step
    // claim to be correction zero of a ladder that never ran.
    const ladder = options.correction === undefined ? {} : { correction: options.correction }
    return call.pipe(
      Effect.map((events) => ({ ...ladder, events: [...reissues, ...accountReissued(events)] })),
      Effect.catchIf(
        (error): error is ModelError.ModelError => error instanceof ModelError.ModelError,
        (error) =>
          (isCapacityRefusal(error) && !(options.sealTerminal === true && ModelError.isTerminalRefusal(error))) ||
            (!options.final && error.code === "transport" && !stalls.has(error))
            ? Effect.fail(error)
            : Effect.succeed({ ...ladder, events: [...reissues, ...accountReissued([])], error })
      )
    )
  })

/**
 * Failures that describe provider capacity rather than the request.
 *
 * This is the recorder's floor. Classifier policy may decide whether the
 * caller parks and retries one of these failures, but no classifier can turn
 * one into a durable sealed value. The one exception is a caller that has no
 * controller to park it (`sealTerminal`): it seals a refusal no wait can clear,
 * which its engine would otherwise ask again for nothing. `provider_internal` is the model
 * vocabulary used for provider overload (including Anthropic 529); the status
 * checks cover transports that retained the wire status under another code.
 */
const capacityStatuses: ReadonlySet<number> = new Set([429, 503, 504, 529])

const isCapacityRefusal = (error: ModelError.ModelError): boolean =>
  error.code === "rate_limited" ||
  error.code === "quota_exceeded" ||
  error.code === "provider_internal" ||
  (error.httpStatus !== undefined && capacityStatuses.has(error.httpStatus))

/**
 * A failure of the engine around a model step rather than of the provider.
 *
 * @category constructors
 * @since 1.0.0-rc.16
 */
export const engineFailed = (message: string, cause: unknown): HarnessError.HarnessError =>
  new HarnessError.HarnessError({ code: "engine_failed", message, cause })

/**
 * Drops `undefined`-valued properties from an already-encoded JSON value.
 *
 * Canonical serialization rejects `undefined` outright, and `Schema.encodeSync`
 * keeps optional fields as explicit `undefined`. Applied only to encoded
 * request JSON, never to arbitrary values, so Canonical still rejects class
 * instances and `Redacted` material on its own.
 */
const stripUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (typeof value !== "object" || value === null) return value
  const stripped: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) stripped[key] = stripUndefined(item)
  }
  return stripped
}

interface ModelCallDeclaration {
  readonly _tag: "ModelCall"
  readonly request: ModelRequest.ModelRequest
}

const isModelCall = (value: unknown): value is ModelCallDeclaration =>
  typeof value === "object" && value !== null &&
  (value as { readonly _tag?: unknown })._tag === "ModelCall" && "request" in value

/**
 * The key material of a model call whose caller declares nothing beside the
 * request: no inputs, layers or capabilities.
 *
 * @category constructors
 * @since 1.0.0-rc.16
 */
export const material = (request: ModelRequest.ModelRequest): KeyMaterial.KeyMaterial => ({
  version: "flows/key-material/v2",
  kind: "sealed",
  body: { _tag: "ModelCall", request },
  inputs: [],
  layers: [],
  capabilities: [],
  effects: undefined,
  placement: undefined
})

/**
 * Digests key material together with the credential-free prepared request.
 *
 * The material embeds the live `ModelRequest` (class instances that Canonical
 * refuses), so it is re-encoded to plain JSON before hashing. The prepared
 * request contributes its route, protocol, method, URL, public headers and
 * canonical body bytes. Credentials are signed onto a copy of the request
 * after preparation and never reach this function.
 *
 * @category constructors
 * @since 1.0.0-rc.16
 */
export const key = Effect.fn("ModelStep.key")(function*(
  material: KeyMaterial.KeyMaterial,
  prepared: Route.PreparedRequest
) {
  const declaration = material.body
  const sealed = {
    ...material,
    body: {
      _tag: "PreparedModelCall",
      declaration: isModelCall(declaration)
        ? {
          _tag: "ModelCall",
          request: stripUndefined(Schema.encodeSync(ModelRequest.ModelRequest)(declaration.request))
        }
        : declaration,
      request: {
        routeId: prepared.routeId,
        protocolId: prepared.protocolId,
        method: prepared.method,
        url: prepared.url,
        publicHeaders: prepared.publicHeaders,
        body: ""
      }
    }
  } satisfies KeyMaterial.KeyMaterial
  // Keep historical keys byte-for-byte: Uint8Array.join emits exactly the
  // decimal JSON elements of Array.from(body), without allocating or walking
  // a million generic canonical-JSON nodes. Let StepKey canonicalize all other
  // material, then splice these known-canonical byte elements at its hash seam.
  const wire = `[${prepared.body.join(",")}]`
  // `Digest.provideSync` supplies a synchronous SHA-256 proven byte-identical
  // to the platform service, so a key needs no `Crypto` from its caller.
  const crypto = yield* Digest.provideSync(Crypto.Crypto)
  for (let ordinal = 0;; ordinal++) {
    sealed.body.request.body = `flows/agent/wire-body/${ordinal}`
    const marker = JSON.stringify(sealed.body.request.body)
    let collision = false
    const derived = yield* StepKey.fromKeyMaterial(sealed, {}).pipe(
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        digest: (algorithm, data) => {
          const canonical = new TextDecoder().decode(data)
          const offset = canonical.indexOf(marker)
          // Caller material can contain the same literal. Retry with another
          // marker rather than replacing any caller-owned value. No marker is
          // ever part of the returned key's bytes.
          collision = offset < 0 || canonical.indexOf(marker, offset + marker.length) !== -1
          return crypto.digest(
            algorithm,
            collision ? data : new TextEncoder().encode(
              canonical.slice(0, offset) + wire + canonical.slice(offset + marker.length)
            )
          )
        }
      }),
      Effect.mapError((cause) => engineFailed("The prepared model request could not be sealed", cause))
    )
    if (!collision) return derived
  }
})

/** Provider calls model steps made, by how each call ended. */
const calls = Metric.counter("agent_model_step_calls", {
  description: "Provider calls made by model steps, by how each call ended"
})

/** Model steps answered from their recorded result. */
const replays = Metric.counter("agent_model_step_replays", {
  description: "Model steps answered from their recorded result, without a provider call"
})

/** Provider calls made again because the step's earlier call was cut off mid-flight. */
const redispatches = Metric.counter("agent_model_step_redispatches", {
  description: "Provider calls a model step made again because its earlier call was cut off mid-flight"
})

/** How one provider call ended, as a metric attribute and a log field. */
type Outcome = "sealed" | "sealed_error" | "refused" | "interrupted" | "failed"

/** The outcome of one provider call, and the code of whatever ended it badly. */
const ended = (exit: Exit.Exit<Recorded, unknown>): {
  readonly outcome: Outcome
  readonly code?: string | undefined
  readonly httpStatus?: number | undefined
} => {
  if (Exit.isSuccess(exit)) {
    const error = exit.value.error
    return error === undefined
      ? { outcome: "sealed" }
      : { outcome: "sealed_error", code: error.code, httpStatus: error.httpStatus }
  }
  if (Cause.hasInterruptsOnly(exit.cause)) return { outcome: "interrupted", code: "interrupted" }
  const failure = exit.cause.reasons.find(Cause.isFailReason)?.error
  if (failure instanceof ModelError.ModelError) {
    return { outcome: "refused", code: failure.code, httpStatus: failure.httpStatus }
  }
  const tag = (failure as { readonly _tag?: unknown } | undefined)?._tag
  return { outcome: "failed", code: typeof tag === "string" ? tag : "defect" }
}

/**
 * One model call as the engine dispatches it.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export interface Dispatch {
  /** The action name; part of the key, so two names never share a record. */
  readonly name: string
  /** The sealed key from {@link key}. */
  readonly key: string
  readonly request: ModelRequest.ModelRequest
  readonly model: Model.Model
  /** What the engine retries: every failure the step does not seal. */
  readonly retryPolicy: RetryPolicy.RetryPolicy
  /** Milliseconds the call may go without an event or a chunk of bytes; absent, unwatched. */
  readonly heartbeatTimeoutMs?: number | undefined
  /**
   * Re-issue one overrun and one stall inside an attempt, and bound the
   * stream's silence (see {@link RecordOptions.reissue}); off when absent.
   */
  readonly reissue?: boolean | undefined
  /**
   * Seal a transport failure as the step's value on `retryPolicy`'s last
   * attempt, so a replay reads it without a provider call; off when absent, so
   * the last failure fails the step. Needs a policy that bounds `maxAttempts`.
   */
  readonly sealExhausted?: boolean | undefined
  /** Seal a terminal capacity refusal as the step's value (see {@link RecordOptions.sealTerminal}); off when absent. */
  readonly sealTerminal?: boolean | undefined
  /** The overrun budget of one provider attempt; absent or zero disarms it. */
  readonly callTimeoutMs?: number | undefined
  /** The correction ordinal stamped onto the record. */
  readonly correction?: number | undefined
  /** Receives each event live, while the call runs. */
  readonly onEvent?: ((event: ModelEvent.ModelEvent) => Effect.Effect<void>) | undefined
  /**
   * Run inside the step before the provider is called. Its function receives
   * what a call that leaves no sealed value paid.
   */
  readonly unsealedUsage?:
    | Effect.Effect<
      (usage: ModelEvent.Usage) => Effect.Effect<void, HarnessError.HarnessError>,
      HarnessError.HarnessError
    >
    | undefined
  /** The last word, inside the step, on whether a recorded value is sealed. */
  readonly settle?: ((recorded: Recorded) => Effect.Effect<Recorded, ModelError.ModelError>) | undefined
}

/**
 * What one model step settled with, and whether this dispatch replayed it
 * rather than calling the provider.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export interface Dispatched {
  readonly recorded: Recorded
  readonly replayed: boolean
}

/**
 * Runs one model call as a sealed action under its key.
 *
 * Each engine attempt calls the provider once through {@link recordModelStep}.
 * A transport failure or a capacity refusal fails the attempt, and
 * `retryPolicy` decides whether the engine tries again; every other provider
 * answer, an error included, is sealed as its value, and so is a transport
 * failure on the last attempt when `sealExhausted` is set. A replayed step
 * returns its record without calling the provider.
 *
 * Each attempt that starts after an earlier one of this dispatch failed, or
 * after an earlier execution of the same attempt was cut off mid-call, first
 * hands `onEvent` a `retry` event, so a consumer folding live events discards
 * the partial output of the attempt that came before.
 *
 * @category execution
 * @since 1.0.0-rc.16
 */
export const dispatch = (
  options: Dispatch
): Effect.Effect<
  Dispatched,
  typeof Failure.Type,
  Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
> =>
  Effect.gen(function*() {
    const fields = { step: options.name, model: options.request.modelId }
    // The flow whose step makes the call, for its usage metrics.
    const flow = (yield* FlowRuntime.FlowInstance).flow._tag
    // Both are this dispatch's own: whether any attempt ran here, and how the
    // last one that ran here ended, so the next can say so to `onEvent`.
    let executed = false
    let previous: {
      readonly code: string
      readonly httpStatus?: number | undefined
      readonly at: number
      readonly elapsedMs: number
    } | undefined
    const recorded = yield* Action.make({
      name: options.name,
      retryPolicy: options.retryPolicy,
      ...(options.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
      success: RecordedModelStep,
      error: Failure,
      tier: "sealed",
      idempotencyKey: options.key,
      execute: Effect.gen(function*() {
        executed = true
        const attempt = yield* Action.CurrentAttempt
        const startedAt = yield* Clock.currentTimeMillis
        // The engine re-runs an attempt an earlier execution started and
        // never settled under the same number: that call was cut off mid-flight.
        const redispatched = yield* Action.CurrentRedispatch
        if (redispatched) {
          yield* Metric.update(Metric.withAttributes(redispatches, { step: options.name }), 1)
          yield* Effect.annotateLogs(
            Effect.logWarning("A model step's earlier call was cut off mid-flight; calling the provider again"),
            { ...fields, attempt }
          )
        }
        const before = previous
        previous = undefined
        if (options.onEvent !== undefined && (before !== undefined || redispatched)) {
          yield* options.onEvent(ModelEvent.ModelEvent.Retry({
            type: "retry",
            attempt,
            code: before?.code ?? "interrupted",
            delayMillis: before === undefined ? 0 : Math.max(0, startedAt - before.at),
            ...(before === undefined ? {} : { elapsedMs: before.elapsedMs }),
            ...(before?.httpStatus === undefined ? {} : { httpStatus: before.httpStatus })
          }))
        }
        const unsealed = options.unsealedUsage === undefined ? undefined : yield* options.unsealedUsage
        let reported: ModelEvent.Usage | undefined
        // The attempt number is the engine's, restored from its own records
        // after a restart, so the last attempt is the last one however many
        // processes the earlier ones ran in.
        const last = options.sealExhausted === true ? options.retryPolicy.maxAttempts : undefined
        return yield* recordModelStep(options.model, options.request, {
          budgetMillis: options.callTimeoutMs,
          correction: options.correction,
          onUsage: (usage) => {
            reported = usage
          },
          onEvent: options.onEvent,
          reissue: options.reissue === true,
          final: last !== undefined && attempt >= last,
          sealTerminal: options.sealTerminal === true
        }).pipe(
          Effect.flatMap(options.settle ?? Effect.succeed),
          // A sealed value is accounted by the caller, on replay too. This
          // covers only exits that cannot seal, and runs uninterruptibly.
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && reported !== undefined && unsealed !== undefined ? unsealed(reported) : Effect.void
          ),
          Effect.onExit((exit) =>
            Effect.gen(function*() {
              const at = yield* Clock.currentTimeMillis
              const end = ended(exit)
              if (Exit.isFailure(exit)) {
                previous = { code: end.code!, httpStatus: end.httpStatus, at, elapsedMs: Math.max(0, at - startedAt) }
              }
              yield* Metric.update(Metric.withAttributes(calls, { step: options.name, outcome: end.outcome }), 1)
              // Usage metrics: this flow's model call and the tokens it reported.
              yield* RunMetrics.recordModelCall({
                flow,
                model: options.request.modelId,
                outcome: end.outcome,
                inputTokens: reported?.inputTokens,
                outputTokens: reported?.outputTokens
              })
              yield* Effect.annotateLogs(Effect.logDebug("A model step's provider call ended"), {
                ...fields,
                attempt,
                outcome: end.outcome,
                ...(end.code === undefined ? {} : { code: end.code })
              })
            })
          )
        )
      })
    })
    const settled = normalizeRecordedModelStep(recorded)
    const outcome = !executed ? "replayed" : settled.error === undefined ? "sealed" : "sealed_error"
    if (!executed) {
      yield* Metric.update(Metric.withAttributes(replays, { step: options.name }), 1)
      yield* Effect.annotateLogs(Effect.logDebug("A model step replayed its recorded result"), fields)
    }
    yield* Effect.annotateCurrentSpan({
      "smithers.model_step.outcome": outcome,
      ...(settled.error === undefined ? {} : { "smithers.model_step.error_code": settled.error.code })
    })
    return { recorded: settled, replayed: !executed }
  }).pipe(
    // A refused call fails the step with the provider's error, so the span
    // exports only its tag and code.
    SpanFailure.withSpan("ModelStep", {
      attributes: { "smithers.model_step.name": options.name, "gen_ai.request.model": options.request.modelId }
    })
  )
