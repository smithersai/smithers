/**
 * The supervisor's seat beside the cell loop: a one-slot sliding queue the
 * loop offers to, a forked fiber that reads the newest snapshot, and a
 * mailbox the next turn boundary takes a nudge from.
 *
 * The loop never awaits any of it. `offer` is a sliding enqueue and returns
 * at once; `take` is a `Ref` swap. Everything Jev is asked, and everything
 * that comes back, happens on the forked fiber. A run that ends with a
 * reading in flight gives it `Supervisor.closeGraceMs` to settle and journal
 * as the scope closes, and no longer: a reading still unanswered then is
 * interrupted and journaled `supervisor-unjudged` with reason `interrupted`,
 * so a Jev call that was made is never missing from the record. A snapshot
 * the fiber never took is dropped and journals nothing: nobody asked.
 *
 * The reading is taken through `EngineLike.record`, keyed on the session,
 * the frame and the cell digest, so a resumed run is handed the reading its
 * original attempt recorded and never asks Jev again. Delivery is decided at
 * the boundary that takes it, inside that boundary's own recorded drain, so a
 * replayed boundary delivers exactly what it delivered the first time and a
 * mailbox left over from a replayed frame is discarded as stale rather than
 * delivered twice.
 *
 * @since 1.0.0-rc.0
 * @private
 */
import { ModelRequest } from "@smthrs/model"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Deferred, Effect, Fiber, Option, Queue, Ref, Schema, type Scope } from "effect"
import * as AgentEvent from "../AgentEvent.ts"
import type { State } from "../CellTurn.ts"
import type * as EngineLike from "../EngineLike.ts"
import * as Supervisor from "../Supervisor.ts"
import * as UnmovedTree from "../UnmovedTree.ts"
import type * as Frame from "./frame.ts"

const eventType = AgentEvent.eventType

/**
 * What one frame hands the supervisor: the snapshot without its recalled
 * rows, which the fiber fetches, and the cell digest the record is keyed on.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Offer {
  readonly frame: number
  readonly digest: string
  /** The frame just closed; the handle keeps the ones before it. */
  readonly current: Supervisor.Frame
  readonly snapshot: Omit<Supervisor.Snapshot, "recalled" | "frames">
}

/**
 * The loop's two calls into the supervisor.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Handle {
  /** Slides this frame's snapshot into the one-slot queue and returns at once. */
  readonly offer: (offer: Offer) => Effect.Effect<void>
  /**
   * The messages the boundary closing `frame` delivers: the newest verdict's
   * nudge and inserts when that verdict is of this frame or the one before,
   * nothing otherwise. Takes the mailbox either way, so a stale verdict is
   * dropped and never delivered later.
   */
  readonly take: (frame: number) => Effect.Effect<ReadonlyArray<ModelRequest.Message>>
}

/** Everything one recorded reading holds, so a replay re-emits and re-delivers it. */
const Recorded = Schema.Struct({
  settled: Schema.NullOr(AgentEvent.SupervisorSettled),
  decision: Schema.NullOr(AgentEvent.DecisionSettled),
  unjudged: Schema.NullOr(AgentEvent.SupervisorUnjudged),
  nudge: Schema.NullOr(Schema.String),
  inserts: Schema.Array(Schema.String),
  remembers: Schema.Array(Schema.String)
})

type Recorded = typeof Recorded.Type

interface Mailbox {
  readonly frame: number
  readonly messages: ReadonlyArray<ModelRequest.Message>
}

/**
 * The counts the deterministic controls keep, read off the state the frame
 * closed on. Nothing is re-derived: every field is a state field, a ledger
 * length, or a filter over a ledger the harness already wrote.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const signals = (
  state: State,
  facts: Frame.Accounting["facts"],
  workspaceDigest: string,
  paths: number
): Supervisor.Signals => ({
  frame: state.frame,
  maxFrames: state.maxFrames,
  readOnlyFrames: facts.readOnlyFrames,
  repeatFrames: facts.repeatFrames,
  mutations: facts.mutations,
  remoteMutations: facts.remoteMutations,
  treeMoved: UnmovedTree.find({
    opened: facts.openingDigest,
    digest: workspaceDigest,
    elsewhere: facts.remoteMutations
  }) === undefined,
  paths,
  checksRun: facts.checks.length,
  checksFailing: facts.checks.filter((check) => check.failing).length,
  failuresUnanswered: facts.failures.length,
  callsFailed: facts.callLedger.filter((entry) => !entry.ok).length,
  callsSettled: facts.callLedger.length,
  narrowingDemands: state.narrowingDemands,
  unmovedDemands: state.unmovedDemands,
  unresolvedDemands: state.unresolvedDemands,
  claimDemands: state.claimDemands,
  sufficiencyStated: state.sufficiencyStated
})

const fencedCell = /```(?:cell|typescript|ts|javascript|js)[^\n]*\n[\s\S]*?(?:```|$)/g

/**
 * What the model wrote around its cell, which is what a memory candidate is
 * read from and what the anxiety question reads.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const prose = (text: string): string => text.replace(fencedCell, "").trim()

/**
 * Opens the supervisor beside the loop: the queue, the mailbox, and the
 * forked fiber that serves them. Requires a scope, which is the loop's own,
 * so closing the loop closes the fiber.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const open = (input: {
  readonly session: string
  readonly engine: EngineLike.EngineLike
  readonly emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
  readonly options: Supervisor.Options
}): Effect.Effect<Handle, never, Scope.Scope | Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const { emit, engine, options, session } = input
    const mailbox = yield* Ref.make<Option.Option<Mailbox>>(Option.none())
    const memory = yield* Supervisor.Memory
    // The evaluator the loop was given, captured once so the fiber asks the
    // same transport the completion brake does.
    const services = yield* Effect.context<Evaluator.Evaluator>()
    // The newest frames ahead of the one just closed, kept in memory: they
    // are evidence for a reading nothing replays, so durable state need not
    // carry them. A resumed run's first snapshots see fewer frames, which is
    // the honest reading of a past this process did not witness.
    const recent: Array<Supervisor.Frame> = []
    // The frame whose reading the fiber is taking, and a latch released when
    // that reading is done, whatever it came to. Read only by the scope's
    // closing grace below.
    const inFlight = yield* Ref.make<Option.Option<{ readonly frame: number; readonly done: Deferred.Deferred<void> }>>(
      Option.none()
    )

    // A store that refused a read or a write is journaled, typed, and the
    // reading goes on: memory is the supervisor's aid, not its evidence.
    const memoryFailed = (frame: number, operation: "recall" | "remember", failure: Supervisor.MemoryFailure) =>
      emit(
        new AgentEvent.SupervisorMemoryFailed({
          eventType: eventType.supervisorMemoryFailed,
          scope: session,
          frame,
          operation,
          detail: failure.detail
        })
      )

    const supervise = (offer: Offer & { readonly frames: ReadonlyArray<Supervisor.Frame> }): Effect.Effect<void> =>
      Effect.gen(function*() {
        const recorded = yield* engine.record({
          name: "supervisor",
          identity: { session, frame: offer.frame, boundary: `supervisor:${offer.digest}` },
          success: Recorded,
          execute: Effect.gen(function*() {
            const recalled = memory.bound
              ? yield* memory.recall(offer.snapshot.task, Supervisor.recalledLimit).pipe(
                Effect.catch((failure) => Effect.as(memoryFailed(offer.frame, "recall", failure), []))
              )
              : []
            const snapshot: Supervisor.Snapshot = {
              ...offer.snapshot,
              frames: offer.frames,
              recalled: recalled.slice(0, Supervisor.recalledLimit)
            }
            const result = yield* Effect.result(Supervisor.read(snapshot).pipe(Effect.provideContext(services)))
            if (result._tag === "Failure") {
              const record: Recorded = {
                settled: null,
                decision: null,
                unjudged: new AgentEvent.SupervisorUnjudged({
                  eventType: eventType.supervisorUnjudged,
                  scope: session,
                  frame: offer.frame,
                  reason: result.failure.reason,
                  detail: result.failure.detail
                }),
                nudge: null,
                inserts: [],
                remembers: []
              }
              return record
            }
            const reading = result.success
            const verdict = Supervisor.judge(snapshot, reading, options)
            const record: Recorded = {
              settled: new AgentEvent.SupervisorSettled({
                eventType: eventType.supervisorSettled,
                scope: session,
                frame: offer.frame,
                thrashing: reading.thrashing,
                onTarget: reading.onTarget,
                suspect: reading.suspect,
                outdatedContext: reading.outdatedContext,
                irrelevantContext: reading.irrelevantContext,
                ...reading.emotions,
                needsHelp: reading.needsHelp,
                crossed: verdict.crossed,
                nudged: verdict.nudge !== undefined,
                steer: options.steer,
                inserted: snapshot.recalled.flatMap((_, index) =>
                  reading.insert[index] === true && options.steer ? [index] : []
                ),
                remembered: snapshot.candidates.flatMap((_, index) =>
                  reading.remember[index] === true && options.remember ? [index] : []
                ),
                latencyMs: reading.latencyMs,
                ...(reading.usage === undefined ? {} : { usage: reading.usage })
              }),
              decision: new AgentEvent.DecisionSettled({
                eventType: eventType.decisionSettled,
                scope: session,
                frame: offer.frame,
                classifier: Supervisor.classifier.id,
                digest: reading.asked.digest,
                state: reading.asked.state,
                questions: reading.asked.questions,
                answers: reading.asked.answers,
                latencyMs: reading.latencyMs,
                acted: verdict.nudge !== undefined || verdict.inserts.length > 0,
                decidedBy: "jev"
              }),
              unjudged: null,
              nudge: verdict.nudge ?? null,
              inserts: verdict.inserts,
              remembers: verdict.remembers
            }
            return record
          })
        })
        // Posted before anything is journaled: an observer's checkpoint sits
        // inside `emit`, and a boundary that wakes on the settled event must
        // find the nudge already waiting for it.
        const messages = [
          ...(recorded.nudge === null ? [] : [recorded.nudge]),
          ...recorded.inserts
        ].map((text) => ModelRequest.Message.user(text))
        if (messages.length > 0) yield* Ref.set(mailbox, Option.some({ frame: offer.frame, messages }))
        // Written before the reading is journaled, and idempotent by
        // construction: a note is keyed on its own text, so a frame that
        // writes what it wrote the first time writes nothing new.
        for (const text of recorded.remembers) {
          yield* memory.remember(text).pipe(
            Effect.catch((failure) => memoryFailed(offer.frame, "remember", failure))
          )
        }
        // The verdict is the last thing this fiber does with a reading: the
        // full decision goes ahead of it, so a host that acts on the verdict
        // the moment it is checkpointed never finds the record behind it
        // missing, and the reading's whole side effect is complete by then.
        if (recorded.decision !== null) yield* emit(recorded.decision)
        if (recorded.unjudged !== null) yield* emit(recorded.unjudged)
        if (recorded.settled !== null) yield* emit(recorded.settled)
      }).pipe(
        // A reading the fiber could not even record is logged and dropped:
        // the supervisor may not fail the run it watches.
        Effect.catchCause((cause) =>
          Effect.annotateLogs(Effect.logWarning("A supervisor reading could not be recorded", cause), {
            frame: offer.frame
          })
        )
      )

    const offers = yield* Queue.make<Offer & { readonly frames: ReadonlyArray<Supervisor.Frame> }>({
      capacity: 1,
      strategy: "sliding"
    })
    // The reading the fiber was taking when it was interrupted, if it was.
    const cut = yield* Ref.make<Option.Option<number>>(Option.none())
    const serve = (offer: Offer & { readonly frames: ReadonlyArray<Supervisor.Frame> }) =>
      Effect.gen(function*() {
        const done = yield* Deferred.make<void>()
        yield* Ref.set(inFlight, Option.some({ frame: offer.frame, done }))
        yield* supervise(offer).pipe(
          Effect.onInterrupt(() => Ref.set(cut, Option.some(offer.frame))),
          Effect.ensuring(Ref.set(inFlight, Option.none()).pipe(Effect.andThen(Deferred.succeed(done, undefined))))
        )
      })
    const fiber = yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(offers), serve)))
    // Registered after the fork, so it runs before the fork's own interruption:
    // a finalizer added later runs earlier. A reading in flight gets the grace
    // to settle and journal itself; one still unanswered after it is
    // interrupted and journaled as such. Nothing here waits past the grace.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        const held = yield* Ref.get(inFlight)
        if (Option.isSome(held)) {
          yield* Deferred.await(held.value.done).pipe(Effect.timeoutOption(Supervisor.closeGraceMs))
        }
        yield* Fiber.interrupt(fiber)
        const interrupted = yield* Ref.get(cut)
        if (Option.isNone(interrupted)) return
        yield* emit(
          new AgentEvent.SupervisorUnjudged({
            eventType: eventType.supervisorUnjudged,
            scope: session,
            frame: interrupted.value,
            reason: "interrupted",
            detail:
              `The run ended with this reading in flight; it was interrupted after a ${Supervisor.closeGraceMs} ms grace.`
          })
        )
      })
    )

    return {
      offer: (offer) =>
        Effect.suspend(() => {
          // Fixed at offer time, on the loop's fiber, so the snapshot is of
          // the frames as they stood when this one closed whatever the fiber
          // reaches it.
          const frames = [...recent.slice(-(Supervisor.recentFrames - 1)), offer.current]
          recent.push(offer.current)
          if (recent.length > Supervisor.recentFrames) recent.splice(0, recent.length - Supervisor.recentFrames)
          return Effect.asVoid(Queue.offer(offers, { ...offer, frames }))
        }),
      take: (frame) =>
        Ref.modify(mailbox, (held) =>
          Option.match(held, {
            onNone: (): readonly [ReadonlyArray<ModelRequest.Message>, Option.Option<Mailbox>] => [[], Option.none()],
            onSome: (value) => [value.frame >= frame - 1 ? value.messages : [], Option.none()]
          }))
    }
  })

/**
 * A handle for a loop that supervises nothing: offers are dropped and every
 * boundary takes nothing.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const none: Handle = {
  offer: () => Effect.void,
  take: () => Effect.succeed([])
}
