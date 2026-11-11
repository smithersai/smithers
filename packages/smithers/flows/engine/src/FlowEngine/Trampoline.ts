/**
 * The trampoline: one `execute` call follows a whole lineage of rounds, and
 * the two refusals that loop raises.
 *
 * `docs/specs/Concepts/Trampoline Loops.md` makes every round its own
 * execution. This module owns the loop that walks them — the handoff that
 * opens the next round, and the poll that waits out a suspended one — so
 * `make.ts` is left holding the adapter and nothing else.
 *
 * @since 0.1.0
 */

import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type { Encoded } from "./Encoded.ts"
import * as Round from "./Round.ts"

/**
 * A suspended execution spent the caller's resume retry policy.
 *
 * @category errors
 * @since 1.0.0
 */
export class SuspendedResumeGaveUp extends Schema.TaggedError<SuspendedResumeGaveUp>()(
  "@smthrs/engine/SuspendedResumeGaveUp",
  {
    code: Schema.Literal("suspended_resume_gave_up").pipe(
      Schema.withConstructorDefault(Effect.succeed("suspended_resume_gave_up"))
    ),
    flowName: Schema.String,
    executionId: Schema.String,
    attempt: Schema.Number,
    elapsedMs: Schema.Number,
    reason: Schema.Literals(["expired", "exhausted"]),
    message: Schema.String
  }
) {}

/**
 * A flow operation named a declaration this engine has not registered.
 *
 * @category errors
 * @since 1.0.0
 */
export class FlowNotRegistered extends Schema.TaggedError<FlowNotRegistered>()(
  "@smthrs/engine/FlowNotRegistered",
  {
    code: Schema.Literal("flow_not_registered").pipe(
      Schema.withConstructorDefault(Effect.succeed("flow_not_registered"))
    ),
    flowName: Schema.String,
    message: Schema.String
  }
) {}

/**
 * The declarations an engine has been told about, by tag. A handoff names its
 * target by tag — it is serializable data that crossed a journal — so
 * following the lineage needs the declaration back to decode the next round's
 * payload and to read its round budget.
 *
 * @category models
 * @since 0.1.0
 */
export type Declarations = Map<
  string,
  Array<{ readonly flow: Flow.Any; readonly scope: Scope.Scope }>
>

/**
 * The lineage position one dispatch is made from. The loop replaces this
 * value whole on each handoff, so the round the linked-cancellation finalizer
 * addresses and the round the loop dispatches cannot drift apart, and no
 * dispatch parameter shadows the state it was derived from.
 *
 * @private
 */
interface LineageRound {
  readonly flow: Flow.Any
  readonly executionId: string
  readonly payload: object
  readonly round: Round.Round
  /** The lineage deadline the previous round stamped on its handoff. */
  readonly deadline?: Flow.LineageDeadline | undefined
}

type Instance = FlowRuntime.FlowInstance["Service"]
type Result = Flow.Result<unknown, unknown>
type Dispatch = Effect.Effect<Result, FlowRuntime.FlowCycleDetected | FlowRuntime.StoreUnavailable>

/**
 * One `execute` call following its lineage. The linked-cancellation finalizer
 * reads `lineage` and `settled` when it runs, so it addresses the round being
 * dispatched and sees that round's latest settlement.
 *
 * @private
 */
interface Follower {
  readonly options: Encoded
  readonly declarations: Declarations
  /** The flow the caller executed. It owns the lineage's round budget. */
  readonly origin: Flow.Any
  /** The caller's execution id: round zero's, and the lineage's root. */
  readonly executionId: string
  /** The calling flow's instance, when a flow body made the call. */
  readonly parent: Instance | undefined
  /** The calling flow's instance when it awaits the lineage as one of its actions. */
  readonly waiter: Instance | undefined
  readonly suspendedRetryPolicy: RetryPolicy.RetryPolicy
  /** The caller's ceilings, then every ceiling a handoff added. */
  capabilityCeilings: CapabilitySet.CapabilitySet["groups"]
  lineage: LineageRound
  settled: Option.Option<Result>
}

/**
 * Dispatches the lineage's current round. `previousExecutionId` is set only on
 * the dispatch that immediately follows a handoff, which is the one edge a
 * durable driver links the new round's row back through.
 */
const dispatch = (follower: Follower, previousExecutionId?: string, follow = false): Dispatch => {
  const step = follower.lineage
  return follower.options.execute(step.flow, {
    executionId: step.executionId,
    payload: step.payload,
    discard: false,
    parent: follower.parent,
    round: previousExecutionId === undefined ? step.round : { ...step.round, previousExecutionId },
    ...(step.deadline === undefined ? {} : { lineageDeadline: step.deadline }),
    ...(follow ? { follow } : {})
  }).pipe(CapabilitySet.attenuateGroups(follower.capabilityCeilings))
}

/**
 * Interrupts the round being dispatched. A finalizer cannot report, so a
 * durable engine's `CancelRequestFailed` is logged rather than swallowed. The
 * child is not orphaned by it: the parent's own cancellation is already
 * durable, and a durable engine cascades it over the persisted parent-edge
 * table (`RunDriver.cancelOwned`), so this is the prompt delivery, not the
 * guarantee.
 */
const cancelRound = (follower: Follower) =>
  follower.options.interrupt(follower.lineage.flow, follower.lineage.executionId).pipe(
    // Finalizers inherit an uninterruptible region. Restore delivery's
    // interruptibility so the timeout can stop a blocked store call.
    Effect.interruptible,
    Effect.timeoutOption("5 seconds"),
    Effect.flatMap((delivered) =>
      Option.isNone(delivered)
        ? Effect.logWarning(`engine: linked cancellation timed out for child execution ${follower.lineage.executionId}`)
        : Effect.void
    ),
    Effect.catch((error) =>
      Effect.logWarning(
        `engine: could not record the linked cancellation of child execution ${follower.lineage.executionId}`,
        error
      )
    )
  )

/** Cancels the lineage when its calling flow was interrupted before the lineage completed. */
const linkCancellation = (follower: Follower, parent: Instance) =>
  Effect.addFinalizer(() => {
    const settled = follower.settled
    if (!parent.interrupted || (Option.isSome(settled) && settled.value._tag === "Complete")) return Effect.void
    return cancelRound(follower)
  })

/**
 * Awaits one dispatched round. A caller that awaits the lineage as one of its
 * actions counts the round among them, so its suspension waits on the round's.
 */
const settle = (
  follower: Follower,
  round: Dispatch
): Effect.Effect<Result, FlowRuntime.FlowCycleDetected | FlowRuntime.StoreUnavailable, FlowRuntime.FlowInstance> =>
  follower.waiter === undefined ? round : Flow.wrapActionResult(round, (result) => result._tag === "Suspended")

/**
 * The declaration a handoff names. DECIDED: a caller that cannot resolve the
 * target dies rather than answering with the raw handoff. The round is durable
 * either way, so the lineage is not lost; what is wrong is this caller's
 * wiring, and saying so is the posture `execute` takes for an unregistered
 * flow.
 */
const handoffTarget = (follower: Follower, handoff: Flow.Handoff): Effect.Effect<Flow.Any> => {
  const target = follower.declarations.get(handoff.flow)?.at(-1)?.flow
  if (target !== undefined) return Effect.succeed(target)
  const from = follower.lineage.flow._tag
  return Effect.die(
    new FlowNotRegistered({
      flowName: handoff.flow,
      message: `${from} handed off to flow ${handoff.flow}, which is not registered with this engine`
    })
  )
}

/**
 * Follows a handoff to the round it names, and dispatches that round. Each
 * round keeps its own execution id and journal; the caller sees one
 * `execute` that answers with the lineage's value.
 */
const handOff = Effect.fnUntraced(function*(follower: Follower, handoff: Flow.Handoff) {
  // DECIDED: `maxRounds` belongs to the lineage originator. A multi-flow
  // handoff cannot reset or replace the budget by naming a target with a
  // different declaration.
  const advanced = yield* Round.next(follower.lineage.round, {
    flowName: follower.origin._tag,
    maxRounds: follower.origin.maxRounds
  }).pipe(Effect.orDie)
  const target = yield* handoffTarget(follower, handoff)
  // A handoff payload travels encoded, so the next round's own schema is what
  // turns it back into the payload that round is planned with.
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(target.payloadSchema))
  const payload = yield* Effect.orDie(decode(handoff.payload)) as Effect.Effect<object>
  // A repeated ceiling is the same intersection, not another unit of history
  // to re-attenuate on every later dispatch. Preserve all distinct groups.
  follower.capabilityCeilings = CapabilitySet.fromGroups([
    ...follower.capabilityCeilings,
    ...(handoff.capabilityCeilings ?? [[]])
  ]).groups
  const previousExecutionId = follower.lineage.executionId
  follower.lineage = {
    flow: target,
    executionId: advanced.executionId,
    payload,
    round: advanced.round,
    ...(handoff.deadline === undefined ? {} : { deadline: handoff.deadline })
  }
  // Durable handoff already admitted and scheduled the successor. Join its
  // drive so a successor that parked before this follower arrived is not
  // replayed; memory adapters admit the round while joining it.
  return dispatch(follower, previousExecutionId, true)
})

/**
 * The wait before polling a suspended round again, from the caller's
 * suspended retry policy. A spent policy dies, naming whether the wall clock
 * or the attempt count gave out.
 */
const pollDelay = Effect.fnUntraced(function*(follower: Follower, attempt: number, startMs: number) {
  const policy = follower.suspendedRetryPolicy
  // A wall clock stepped back past the start reads as no time spent, not as
  // a negative elapsed time every policy gives up on.
  const elapsedMs = Math.max(0, (yield* Clock.currentTimeMillis) - startMs)
  const delay = yield* RetryPolicy.nextDelayEffect(policy, attempt, { elapsedMs })
  if (Option.isSome(delay)) return delay.value
  // The give-up is the wall clock's only when dropping `elapsedMs` would have
  // allowed another attempt.
  const reason = Option.isSome(RetryPolicy.nextDelay(policy, attempt)) ? "expired" : "exhausted"
  const flowName = follower.origin._tag
  return yield* Effect.die(
    new SuspendedResumeGaveUp({
      flowName,
      executionId: follower.executionId,
      attempt,
      elapsedMs,
      reason,
      message: `${flowName}.execute: suspendedRetryPolicy ${reason}`
    })
  )
})

/** Sleeps out a poll delay, or less if the driver wakes the round. Answers whether a wake ended it. */
const awaitWake = (follower: Follower, delayMs: number): Effect.Effect<boolean> => {
  const sleep = Effect.as(Effect.sleep(delayMs), false)
  const signal = follower.options.resumeSignal
  if (signal === undefined) return sleep
  return Effect.raceFirst(sleep, Effect.as(signal(follower.lineage.flow, follower.lineage.executionId), true))
}

/**
 * Follows the lineage from its first dispatch until a round completes: through
 * every handoff, and through every suspension, which a waiting parent takes
 * as its own and any other caller polls under its suspended retry policy.
 */
const followLineage = Effect.fnUntraced(function*(follower: Follower, first: Dispatch) {
  // The retry policy is 1-based; only elapsed polls advance this counter.
  let resumeAttempt = 1
  // The expiration origin is in-process by design: the loop lives only as
  // long as this caller, and a restart re-enters `execute` with a fresh
  // budget. What must not happen is the bound being silently inert (issue
  // #45): `expirationMs` caps the wall-clock time this caller keeps polling.
  const resumeStartMs = yield* Clock.currentTimeMillis
  let current = first
  while (true) {
    const settled = yield* settle(follower, current)
    follower.settled = Option.some(settled)
    if (settled._tag === "Complete") return yield* settled.exit as Exit.Exit<any>
    if (settled._tag === "Handoff") {
      current = yield* handOff(follower, settled)
      continue
    }
    if (follower.waiter !== undefined) return yield* Flow.suspend(follower.waiter)
    const delay = yield* pollDelay(follower, resumeAttempt, resumeStartMs)
    // Only an elapsed poll resumes and spends an attempt. A wake is published
    // by the write that already scheduled the re-drive, and resuming is itself
    // a wake: two callers following one parked run would wake each other
    // forever, re-driving it back to back with no delay.
    if (!(yield* awaitWake(follower, delay))) {
      resumeAttempt = resumeAttempt + 1
      yield* follower.options.resume(follower.lineage.flow, follower.lineage.executionId, { poll: true })
    }
    current = dispatch(follower, undefined, true)
  }
})

/**
 * Admits a discarded execution, then follows its settlements in the
 * registration's scope so closing the submitting scope cannot truncate the
 * lineage. A low-level adapter without a local handler uses the caller's
 * scope instead.
 */
const submit = Effect.fnUntraced(function*(follower: Follower, first: Dispatch) {
  const { executionId, lineage, origin } = follower
  yield* follower.options.execute(origin, {
    executionId,
    payload: lineage.payload,
    discard: true,
    parent: follower.parent,
    round: lineage.round
  })
  const scope = follower.declarations.get(origin._tag)?.at(-1)?.scope ?? (yield* Effect.scope)
  yield* Effect.forkIn(
    followLineage(follower, first).pipe(
      Effect.ignoreCause({ log: "Error" }),
      Effect.annotateLogs({ flow: origin._tag, executionId })
    ),
    scope
  )
  return executionId
})

/**
 * Builds the typed `execute` an engine answers with: it admits round 0 and
 * then follows the lineage — handoffs and suspended-resume polls alike —
 * until one round settles with an exit.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeExecute = (options: Encoded, declarations: Declarations) =>
  // Untraced because flow execution recursively invokes child flows.
  Effect.fnUntraced(function*<
    Name extends string,
    Payload extends Flow.AnyStructSchema,
    Success extends Schema.Top,
    Error extends Schema.Top,
    const Discard extends boolean = false
  >(
    self: Flow.Flow<Name, Payload, Success, Error, any>,
    opts: {
      readonly executionId: string
      readonly payload: Payload["Type"]
      readonly discard?: Discard | undefined
      readonly suspendedRetryPolicy?:
        | RetryPolicy.RetryPolicy
        | undefined
    }
  ) {
    const ceilings = yield* CapabilitySet.current
    const executionId = opts.executionId
    yield* Effect.annotateCurrentSpan({ executionId })
    const round = Round.initial(executionId)
    const parent = Option.getOrUndefined(yield* Effect.serviceOption(FlowRuntime.FlowInstance))
    const follower: Follower = {
      options,
      declarations,
      origin: self as Flow.Any,
      executionId,
      parent,
      waiter: opts.discard ? undefined : parent,
      suspendedRetryPolicy: opts.suspendedRetryPolicy ?? RetryPolicy.defaultRetryPolicy,
      capabilityCeilings: ceilings.groups,
      lineage: { flow: self as Flow.Any, executionId, payload: opts.payload as object, round },
      settled: Option.none()
    }
    if (parent !== undefined) yield* linkCancellation(follower, parent)
    // A discarded execution is admitted by `submit`, so its follower's first
    // dispatch already follows the round.
    const first = dispatch(follower, undefined, opts.discard === true)
    if (opts.discard) return yield* submit(follower, first)
    return yield* followLineage(follower, first)
  })
