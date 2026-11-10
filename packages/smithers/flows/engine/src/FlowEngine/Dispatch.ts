/**
 * Action dispatch: the ordinal allocation an invocation key is derived from,
 * the keyless-concurrency guard that refuses indistinguishable overlaps, the
 * compensable snapshot orchestration, and the engine's single retry decision
 * point.
 *
 * @since 0.1.0
 */

import { Action, Fault, Flow, FlowRuntime, JournalDecode, RetryPolicy, StepIdentity } from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Schema from "effect/Schema"
import { toJsonExit } from "../internal/JsonExit.ts"
import { actionKey, ActionKeyEncoding, keyEncodings, ordinalScope, uncanonicalKey } from "./ActionKey.ts"
import type { ActionExecuteOptions, Encoded } from "./Encoded.ts"
import { SnapshotBoundary, type SnapshotBoundaryOptions, SnapshotBoundaryRequired } from "./SnapshotBoundary.ts"

import * as StepTrace from "../StepTrace.vibe"

import { FailureSite } from "./FailureSite.ts"

type Instance = FlowRuntime.FlowInstance["Service"]

// An action can open an independent child flow. Only invocations in this same
// execution inherit its allocation scope; a child must replay the same keys
// when a different process resumes it without its original caller's context.
const CurrentActionParent = Context.Reference<
  {
    readonly executionId: string
    readonly key: string
  } | undefined
>("@smthrs/engine/CurrentActionParent", { defaultValue: () => undefined })

/**
 * Starts a flow body with its own dispatch context. A timer can wake a
 * suspended execution from inside an action; the new round must replay from
 * its root rather than inherit that action's parent, attempt or ordinal slot.
 * Composition-wide cache identity remains in the context.
 *
 * @private
 * @since 1.0.0
 */
export const resetActionContext = Context.omit(
  CurrentActionParent,
  Action.CurrentAttempt,
  Action.CurrentOrdinal,
  Action.CurrentInvocationKey,
  Action.CurrentHeartbeat,
  StepIdentity.DispatchSite,
  StepIdentity.DispatchReport
)

/**
 * The scope a dispatch's ordinal is allocated in. Each action implementation
 * runs with fresh ordinal counters, so a dispatch nested in another invocation
 * of the same execution is refined by that invocation's key; otherwise two
 * parents' first nested dispatches would share one key.
 */
const allocationScope = Effect.fnUntraced(function*(action: Action.Any) {
  const site = yield* Effect.serviceOption(StepIdentity.DispatchSite)
  const scope = yield* ordinalScope(action, Option.getOrUndefined(site))
  const instance = yield* FlowRuntime.FlowInstance
  const parent = yield* CurrentActionParent
  if (parent === undefined || parent.executionId !== instance.executionId) return scope
  return `${scope}/p:${parent.key.length}:${parent.key}`
})

/**
 * Runs a dispatch only while no other dispatch of its allocation scope is in
 * flight. Two at once would take ordinals in fiber-arrival order, and a
 * resume replaying them in the other order would hand each the other's
 * recorded outcome (issues #111, #130). The check and its release share one
 * uninterruptible region, so an interruption cannot leak the scope into the
 * set (issue #139).
 */
const refuseConcurrentDispatch = <A, E, R>(
  inFlight: Set<string>,
  scope: string,
  actionName: string,
  dispatch: Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      if (inFlight.has(scope)) return false
      inFlight.add(scope)
      return true
    }),
    (acquired) => acquired ? dispatch : Effect.die(new Action.ConcurrentKeylessDispatch({ actionName })),
    (acquired) => acquired ? Effect.sync(() => inFlight.delete(scope)) : Effect.void
  )

/**
 * Allocates the ordinal an invocation key is derived from. Inside
 * `Action.retry`, the n-th dispatch of a scope in every attempt reuses the
 * n-th ordinal pinned by the attempt that first reached it (issues #73, #84,
 * #100). Outside, each dispatch takes the scope's next ordinal.
 */
const allocateOrdinal = Effect.fnUntraced(function*(instance: Instance, scope: string) {
  const slot = yield* Action.CurrentOrdinal
  if (slot === undefined) return instance.actionState.nextOrdinal(scope)
  const index = slot.cursors.get(scope) ?? 0
  slot.cursors.set(scope, index + 1)
  const pinned = slot.values.get(scope) ?? []
  if (index < pinned.length) return pinned[index]!
  const ordinal = instance.actionState.nextOrdinal(scope)
  pinned.push(ordinal)
  slot.values.set(scope, pinned)
  return ordinal
})

/**
 * The dispatch's invocation key. Invocation keys are run-local, so the cache
 * environment folds into cache keys only (issue #75). A driver resolving a
 * fork's copied history, or a record an earlier engine wrote under an older
 * key encoding, picks the key through `actionReplayKey`.
 */
const invocationKey = Effect.fnUntraced(function*(
  options: Encoded,
  action: Action.Any,
  ordinal: number,
  scope: string
) {
  const instance = yield* FlowRuntime.FlowInstance
  const environment = yield* Action.CurrentCacheEnvironment
  // Every action `Action.make` builds carries the declared schemas `actionKey`
  // folds in (issue #120); only the `Schema.Constraint` parameters resist the
  // assignment.
  const declared = action as unknown as Action.AnyWithProps & Pick<Action.Any, "annotations">
  const encoding = yield* ActionKeyEncoding
  const keyAt = (executionId: string, runScoped: boolean, at: (typeof keyEncodings)[number]) =>
    actionKey(declared, executionId, ordinal, runScoped ? undefined : environment, scope, at)
  const derive = (executionId: string, runScoped: boolean) => keyAt(executionId, runScoped, encoding)
  // The same dispatch's keys under every earlier encoding, newest first, so a
  // record an older engine wrote is found again. Two encodings can derive one
  // key, and most dispatches derive the current key under every encoding.
  const legacy = (executionId: string, runScoped: boolean) =>
    Effect.gen(function*() {
      const current = yield* derive(executionId, runScoped)
      const keys: Array<string> = []
      for (const older of keyEncodings.slice(keyEncodings.indexOf(encoding) + 1)) {
        const key = yield* keyAt(executionId, runScoped, older)
        if (key !== current && !keys.includes(key)) keys.push(key)
      }
      return keys
    })
  if (options.actionReplayKey === undefined) return yield* derive(instance.executionId, false)
  return yield* options.actionReplayKey(derive, legacy)
})

/**
 * How a dispatch retries. `infraOnly` marks the engine's default policy,
 * which retries transient infrastructure faults only.
 */
interface RetryPlan {
  readonly policy: RetryPolicy.RetryPolicy
  readonly infraOnly: boolean
}

/**
 * The action's own retry policy, or the engine's transient default when
 * repeating the action is safe: it has an idempotency key, or it writes
 * nothing and is not irreversible.
 */
const retryPlan = (action: Action.Any): RetryPlan | undefined => {
  if (action.retryPolicy !== undefined) return { policy: action.retryPolicy, infraOnly: false }
  if (action.idempotencyKey !== undefined) return { policy: RetryPolicy.transient, infraOnly: true }
  // A read envelope cannot authorize repeating an unkeyed irreversible action.
  if (action.tier === "irreversible") return undefined
  const envelope = Context.getOption(action.annotations, Flow.EffectEnvelope)
  if (Option.isNone(envelope) || envelope.value.writes.length > 0) return undefined
  return { policy: RetryPolicy.transient, infraOnly: true }
}

/**
 * The persisted start of a retry sequence, so an `expirationMs` budget
 * survives park, resume and process death (issue #45).
 */
const durableRetryOrigin = (
  options: Encoded,
  actionName: string,
  retry: RetryPlan | undefined,
  key: string
) => {
  if (retry?.policy.expirationMs === undefined || options.actionRetryOrigin === undefined) {
    return Effect.succeedNone
  }
  // With no attempt row the budget restarts rather than failing the run
  // (issue #69). It logs at Debug: a first dispatch has no row either.
  return options.actionRetryOrigin({ key }).pipe(Effect.tap((origin) =>
    Option.isNone(origin)
      ? Effect.logDebug(
        `FlowEngine.actionExecute: no durable retry origin for "${actionName}"; the expirationMs budget restarts from the current clock`
      )
      : Effect.void
  ))
}

/** When the expiration budget started: a usable durable origin, else now. */
const retryStart = Effect.fnUntraced(function*(actionName: string, origin: Option.Option<number>) {
  const now = yield* Clock.currentTimeMillis
  if (Option.isNone(origin)) return now
  if (Number.isFinite(origin.value) && origin.value <= now) return origin.value
  yield* Effect.logWarning(
    `FlowEngine.actionExecute: unusable durable retry origin for "${actionName}": ` +
      `reported ${String(origin.value)} while the current clock is ${now}; the expirationMs budget starts now`
  )
  return now
})

const durableLatestAttempt = (options: Encoded, key: string) =>
  options.actionLatestAttempt === undefined ? Effect.succeedNone : options.actionLatestAttempt({ key })

/**
 * The attempt to run first. A persisted attempt sequence keeps its numbering
 * across process death (issue #59), so a replay neither re-sleeps the backoff
 * ladder nor decides retries against attempt 1.
 */
const resumedAttempt = Effect.fnUntraced(function*(
  actionName: string,
  callerAttempt: number,
  latest: Option.Option<number>
) {
  if (Option.isNone(latest)) return callerAttempt
  if (Number.isSafeInteger(latest.value)) return Math.max(latest.value, callerAttempt)
  yield* Effect.logWarning(
    `FlowEngine.actionExecute: rejected unusable durable latest attempt for "${actionName}": ` +
      `${String(latest.value)} is not a safe integer; using caller attempt ${callerAttempt}`
  )
  return callerAttempt
})

/** An irreversible action without an idempotency key runs at most once. */
const refuseIrreversibleRetry = (action: Action.Any, attempt: number) =>
  action.tier === "irreversible" && action.idempotencyKey === undefined && attempt > 1
    ? Effect.die(new Action.IrreversibleRetryRequiresIdempotencyKey({ actionName: action.name, attempt }))
    : Effect.void

/**
 * Whether a failed attempt died of nothing but an expired attempt bound, the
 * one defect the retry decision treats as an attempt failure. The tag is read
 * off the defect so a replayed row, whose defect is the error's encoded
 * fields, is recognized like the live error.
 */
const timedOutOnly = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) =>
    Cause.isDieReason(reason) && Predicate.isTagged(reason.defect, "@smthrs/flow/AttemptTimedOut")
  )

/**
 * Keeps an expired attempt a settlement even when the flow does not capture
 * defects, so the retry decision still sees it.
 */
const settleTimedOut = <E, R>(
  effect: Effect.Effect<Flow.Result<unknown, unknown>, E, R>
): Effect.Effect<Flow.Result<unknown, unknown>, E, R> =>
  Effect.catchCause(effect, (cause) =>
    timedOutOnly(cause)
      ? Effect.succeed(new Flow.Complete({ exit: Exit.failCause(cause) }))
      : Effect.failCause(cause))

/** Hands one attempt to the driver, with no more capability than its action declares. */
const driverExecute = (options: Encoded, input: ActionExecuteOptions) =>
  options.actionExecute(input).pipe(Flow.attenuateCapabilities(Flow.capabilityCeilings(input.action.annotations)))

/** The handle a compensable attempt restores first: its retry sequence's earliest. */
const earliestSnapshot = (
  options: Encoded,
  instance: Instance,
  input: ActionExecuteOptions
) => {
  if (options.actionSnapshot !== undefined) return options.actionSnapshot({ key: input.key })
  const snapshots = instance.actionState.snapshots
  return Effect.sync(() =>
    input.attempt > 1 && snapshots.has(input.key) ? Option.some(snapshots.get(input.key)) : Option.none()
  )
}

/**
 * Runs a compensable attempt inside the host's snapshot boundary: restore the
 * earliest snapshot, take a new one, execute, then diff what the attempt
 * changed.
 */
const executeCompensable = Effect.fnUntraced(function*(
  options: Encoded,
  instance: Instance,
  input: ActionExecuteOptions
) {
  const boundary = yield* Effect.serviceOption(SnapshotBoundary)
  if (Option.isNone(boundary)) {
    const actionName = input.action.name
    return yield* Effect.die(
      new SnapshotBoundaryRequired({
        actionName,
        message: `Compensable action "${actionName}" requires SnapshotBoundary`
      })
    )
  }
  const boundaryOptions: SnapshotBoundaryOptions = {
    flow: instance.flow,
    executionId: instance.executionId,
    key: input.key,
    attempt: input.attempt,
    metadata: input.metadata
  }
  let captured = Option.none<unknown>()
  const prepare = Effect.gen(function*() {
    const original = yield* earliestSnapshot(options, instance, input)
    if (Option.isSome(original)) yield* boundary.value.restore(original.value, boundaryOptions)
    const snapshot = yield* boundary.value.snapshot(boundaryOptions)
    if (!instance.actionState.snapshots.has(input.key)) instance.actionState.snapshots.set(input.key, snapshot)
    captured = Option.some(snapshot)
    return snapshot
  })
  // A durable driver checks its journal first and runs `prepare` only when it
  // executes, so replay cannot replace the pre-crash handle with a snapshot
  // of the already-mutated world.
  const execute = options.actionSnapshot === undefined
    ? Effect.andThen(prepare, driverExecute(options, input))
    : driverExecute(options, { ...input, snapshot: prepare })
  const diff = Effect.suspend(() =>
    Option.isSome(captured) ? Effect.asVoid(boundary.value.diff(captured.value, boundaryOptions)) : Effect.void
  )
  return yield* execute.pipe(settleTimedOut, Effect.ensuring(diff))
})

/** Runs one attempt with the dispatch's identity in context. */
const runAttempt = (
  options: Encoded,
  instance: Instance,
  action: Action.Any,
  key: string,
  attempt: number
): ReturnType<Encoded["actionExecute"]> => {
  const input: ActionExecuteOptions = {
    action,
    attempt,
    key,
    tier: action.tier,
    ...(action.nondeterministic === undefined ? {} : { nondeterministic: action.nondeterministic }),
    metadata: action.metadata
  }
  const execute = action.tier === "compensable"
    ? executeCompensable(options, instance, input)
    : settleTimedOut(driverExecute(options, input))
  return StepTrace.observed(execute, {
    run: instance.executionId,
    flow: instance.flow._tag,
    name: action.name,
    key,
    attempt
  }).pipe(
    Effect.provideService(Action.CurrentAttempt, attempt),
    Effect.provideService(CurrentActionParent, { executionId: instance.executionId, key }),
    // DECIDED: the implementation gets the dispatch's own key. Durable state
    // it names, such as `Sleep`'s `DurableClock`, needs an identity stable
    // across replays of one node and distinct between two identical calls,
    // which this key already is. The attempt is deliberately left out, so a
    // retried wait rejoins the timer it already armed.
    Effect.provideService(Action.CurrentInvocationKey, key)
  )
}

/**
 * Moves engine failures from Fail to Die with their encoded fields, so they
 * stay out of the action's error codec yet keep their retry classification.
 */
const encodeEngineFailures = (options: Encoded, exit: Exit.Exit<unknown, unknown>): Exit.Exit<unknown, unknown> => {
  const encode = options.encodeEngineError
  if (encode === undefined || Exit.isSuccess(exit)) return exit
  return Exit.failCause(Cause.fromReasons(exit.cause.reasons.map((reason) => {
    if (!Cause.isFailReason(reason)) return reason
    const encoded = encode(reason.error)
    return Option.isSome(encoded)
      ? Cause.makeDieReason(encoded.value).annotate(Cause.reasonAnnotations(reason))
      : reason
  })))
}

/** Decodes a recorded outcome through the action's declared schemas. */
const decodeOutcome = <Success extends Schema.Constraint, Error extends Schema.Constraint, R>(
  options: Encoded,
  action: Action.Action<Success, Error, R>,
  recorded: Exit.Exit<unknown, unknown>
) => {
  const serialization = options.serialization ?? RpcSerialization.json
  return Effect.orDie(
    Schema.decodeEffect(Action.exitSchemasFor(serialization, action).exitSchemaPartial)(
      // A JSON store reads `undefined` back as `null`; another codec's values never were JSON.
      serialization.codecFor === RpcSerialization.json.codecFor
        ? toJsonExit(encodeEngineFailures(options, recorded))
        : encodeEngineFailures(options, recorded)
    ).pipe(
      Effect.map((decoded) =>
        Exit.isFailure(recorded) && Exit.isFailure(decoded)
          ? Exit.failCause(Cause.fromReasons(decoded.cause.reasons.map((reason, index) => {
            // Exit encoding preserves one reason for each original reason.
            return reason.annotate(Cause.reasonAnnotations(recorded.cause.reasons[index]!))
          })))
          : decoded
      ),
      // Decode errors can quote private journal data. Emit only the declaration's tag and injected host identity.
      Effect.catch(() => Effect.flatMap(JournalDecode.report(action.name), Effect.fail))
    )
  )
}

/** Whether every reason in a failure is a Fail, or a Die carrying an encoded engine failure. */
const onlyEngineFailures = (
  options: Encoded,
  recorded: Exit.Exit<unknown, unknown>,
  decoded: Cause.Cause<unknown>
): boolean => {
  const encode = options.encodeEngineError
  if (encode === undefined || Exit.isSuccess(recorded) || Cause.hasDies(recorded.cause)) return false
  return decoded.reasons.every((reason) =>
    Cause.isFailReason(reason) || (Cause.isDieReason(reason) && Option.isSome(encode(reason.defect)))
  )
}

/**
 * The error a retry policy is asked about, when the outcome is retryable.
 * Interruptions and original defects are never retried. An expired attempt
 * bound is, and so is an engine failure moved from Fail to Die.
 */
const retryableError = (
  options: Encoded,
  recorded: Exit.Exit<unknown, unknown>,
  decoded: Exit.Exit<unknown, unknown>
): Option.Option<unknown> => {
  if (Exit.isSuccess(decoded) || Cause.hasInterrupts(decoded.cause)) return Option.none()
  const cause = decoded.cause
  const retryable = !Cause.hasDies(cause) || timedOutOnly(cause) || onlyEngineFailures(options, recorded, cause)
  if (!retryable) return Option.none()
  const reason = cause.reasons.find((reason) => Cause.isFailReason(reason) || Cause.isDieReason(reason))
  if (reason === undefined) return Option.none()
  return Option.some(Cause.isFailReason(reason) ? reason.error : reason.defect)
}

/**
 * The engine's single retry decision: the delay before the next attempt, or
 * none to settle. The attempt count is persisted by durable engines, so a
 * backoff sequence survives process death.
 */
const retryDelay = Effect.fnUntraced(function*(
  retry: RetryPlan | undefined,
  attempt: number,
  startMs: number,
  error: Option.Option<unknown>
) {
  if (retry === undefined || Option.isNone(error)) return Option.none<number>()
  if (retry.infraOnly && Fault.of(error.value).class !== "infra") return Option.none<number>()
  const now = yield* Clock.currentTimeMillis
  const decision = yield* RetryPolicy.decideEffect(retry.policy, {
    attempt,
    error: error.value,
    elapsedMs: now - startMs
  })
  if (decision._tag === "RetryAfter") return Option.some(decision.delayMs)
  // Giving up keeps the final business failure, so typed recovery still runs.
  yield* Effect.annotateCurrentSpan({ "retry.stopReason": decision.reason, "retry.attempt": attempt })
  return Option.none<number>()
})

/**
 * Builds the typed `actionExecute` an engine answers with: it allocates the
 * dispatch's identity, admits it through the low-level seam, and owns the
 * retry decision made on the outcome.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeActionExecute = (options: Encoded) => {
  // Untraced because action retries are a hot path within a flow run.
  const dispatch = Effect.fnUntraced(function*<
    Success extends Schema.Constraint,
    Error extends Schema.Constraint,
    R
  >(action: Action.Action<Success, Error, R>, callerAttempt: number, scope: string) {
    const instance = yield* FlowRuntime.FlowInstance
    const ordinal = yield* allocateOrdinal(instance, scope)
    const keyResult = yield* Effect.result(invocationKey(options, action, ordinal, scope))
    // The scope can be valid while this subsequent Crypto digest fails.
    if (Result.isFailure(keyResult)) return uncanonicalKey(action.name, keyResult.failure)
    const key = keyResult.success
    const retry = retryPlan(action)
    const origin = yield* durableRetryOrigin(options, action.name, retry, key)
    const retryStartMs = yield* retryStart(action.name, origin)
    const latest = yield* durableLatestAttempt(options, key)
    let attempt = yield* resumedAttempt(action.name, callerAttempt, latest)
    yield* refuseIrreversibleRetry(action, attempt)
    const nodeId = yield* Effect.serviceOption(StepIdentity.DispatchSite)
    const annotateFailure = <E>(cause: Cause.Cause<E>): Cause.Cause<E> =>
      Cause.fromReasons(
        cause.reasons.map((reason) =>
          Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureSite) !== undefined
            ? reason
            : reason.annotate(Context.make(FailureSite, {
              executionId: instance.executionId,
              action: action.name,
              attempts: attempt,
              ...(Option.isSome(nodeId) ? { nodeId: nodeId.value } : {})
            }))
        )
      )
    while (true) {
      const result = yield* runAttempt(options, instance, action, key, attempt).pipe(
        Effect.catchCause((cause) => Effect.failCause(annotateFailure(cause)))
      )
      if (result._tag !== "Complete") return result
      const exit = yield* decodeOutcome(options, action, result.exit).pipe(
        Effect.catchCause((cause) => Effect.failCause(annotateFailure(cause)))
      )
      const error = retry === undefined ? Option.none() : retryableError(options, result.exit, exit)
      const delay = yield* retryDelay(retry, attempt, retryStartMs, error)
      if (Option.isNone(delay)) {
        return new Flow.Complete({
          exit: Exit.isSuccess(exit) ? exit : Exit.failCause(annotateFailure(exit.cause))
        })
      }
      attempt++
      yield* refuseIrreversibleRetry(action, attempt)
      yield* Effect.sleep(delay.value)
    }
  })
  return Effect.fnUntraced(function*<
    Success extends Schema.Constraint,
    Error extends Schema.Constraint,
    R
  >(action: Action.Action<Success, Error, R>, attempt: number) {
    const scopeResult = yield* Effect.result(allocationScope(action))
    if (Result.isFailure(scopeResult)) return uncanonicalKey(action.name, scopeResult.failure)
    const scope = scopeResult.success
    // A keyed sealed action takes a pure cache key, not an ordinal, so
    // overlapping dispatches cannot swap recorded outcomes.
    if (action.tier === "sealed" && action.idempotencyKey !== undefined) return yield* dispatch(action, attempt, scope)
    const instance = yield* FlowRuntime.FlowInstance
    return yield* refuseConcurrentDispatch(
      instance.actionState.keylessInFlight,
      scope,
      action.name,
      dispatch(action, attempt, scope)
    )
  })
}
