/**
 * The queue as a durable flow.
 *
 * One flow round is one driver round. The round's work is a single recorded
 * action; its result, the queue's next position, is the payload of the next
 * round. So the queue's whole state lives in the flow's journal: a host that
 * crashes resumes at the last recorded position, and a round that crashed
 * before it was recorded runs again, which `Driver.round` makes safe.
 *
 * The flow has no pause, hold or freeze. The queue ends only when the inbox
 * was closed and every change has ended.
 *
 * One run of the flow is one lineage of the queue, and a lineage is bounded:
 * after `lineage` rounds the run ends and leaves its position with the
 * `Handover` service, and the host starts the next run from it. Every round of
 * a run stays in the engine's store and in the run's tree while the run lives,
 * so an unbounded lineage costs the engine more with every round. A hand-over
 * changes nothing the queue decides: the next lineage starts from exactly the
 * position the last round would have passed to its next round.
 *
 * @since 0.1.0
 */

import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Driver from "./Driver.ts"
import { Config, Ending, State } from "./Schema.ts"
import { Handover, TargetDiverged, Unavailable } from "./Services.ts"

const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * What a round starts from: the settings, the queue's position, and the
 * round's number in the lineage.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Payload = Schema.Struct({
  config: Config,
  state: State,
  cursor: Natural,
  closed: Schema.Boolean,
  /** The changes the round before ended, for this round to record. Start with none. */
  ended: Schema.Array(Ending),
  /** How many parts of the target's tree the queue has cut from its state. Start with 0. */
  settled: Natural,
  /** This round's number in its lineage. A lineage starts with 0. */
  round: Natural,
  /** How many rounds one lineage runs before it hands over; at least 1. {@link lineageRounds} unless a host says otherwise. */
  lineage: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
})

/**
 * What a lineage ends with: whether the queue is done, and the start value of
 * the next lineage (round 0 of it), which is also what the `Handover` service
 * was given.
 *
 * @category schemas
 * @since 0.1.0
 */
export const End = Schema.Struct({ done: Schema.Boolean, position: Payload })

/**
 * What a round ends with: the queue's next position, and whether it is done.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Outcome = Schema.Struct({
  state: State,
  cursor: Natural,
  closed: Schema.Boolean,
  ended: Schema.Array(Ending),
  settled: Natural,
  done: Schema.Boolean,
  /** Whether this round was its lineage's last and left its position with the `Handover` service. */
  handedOver: Schema.Boolean,
  /** What the lineage ends with if this round is its last: the next lineage's start value. */
  end: End
})

/**
 * The rounds one lineage runs unless a host says otherwise.
 *
 * @category constants
 * @since 0.1.0
 */
export const lineageRounds = 200

/**
 * Why a round attempt failed. The engine retries it; nothing was decided.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RoundError = Schema.Union([Unavailable, TargetDiverged])

/**
 * How a failed round is retried: from 200 ms, doubling to 30 s, without end.
 * The queue never gives up on the world, so an outage of CI, fix agents or the
 * target delays landings and loses nothing.
 *
 * @category constants
 * @since 0.1.0
 */
export const retryPolicy: RetryPolicy.RetryPolicy = RetryPolicy.make({ initialMs: 200, factor: 2, maxMs: 30_000 })

/**
 * The action one round runs. It is `nondeterministic`: a replayed round reads
 * the recorded outcome, and a round that crashed before recording runs again.
 *
 * @category actions
 * @since 0.1.0
 */
export const Round = Action.make("@smthrs/merge-queue/Round", {
  payload: Payload,
  success: Outcome,
  error: RoundError,
  nondeterministic: true,
  retryPolicy
})

/**
 * The implementation of {@link Round}: one `Driver.round` over the host's
 * `Inbox`, `Ci`, `Fixer`, `Target` and `Endings`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Round.toLayer((payload) =>
  Effect.gen(function*() {
    const { closed, config, cursor, ended, settled, state } = payload
    const outcome = yield* Driver.round(config, { state, cursor, closed, ended, settled })
    const handedOver = outcome.done || payload.round + 1 >= payload.lineage
    const end = { done: outcome.done, position: next(payload, outcome) }
    // Saved inside the round, so a round that is recorded as its lineage's
    // last has left its position. A round that runs again saves again.
    if (handedOver) yield* (yield* Handover).save(end)
    return { ...outcome, handedOver, end }
  })
)

/**
 * The start value of the lineage that follows a round: the round's outcome as
 * a position, at round 0.
 *
 * @category constructors
 * @since 0.1.0
 */
export const next = (
  payload: typeof Payload.Type,
  outcome: Driver.Outcome
): typeof Payload.Type => ({
  config: payload.config,
  state: outcome.state,
  cursor: outcome.cursor,
  closed: outcome.closed,
  ended: outcome.ended,
  settled: outcome.settled,
  round: 0,
  lineage: payload.lineage
})

/**
 * The engine's own bound on the rounds of one run. A lineage hands over long
 * before it (`Payload.lineage`), so the queue never reaches it.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxRounds = 1_000_000_000

/**
 * The declared form of the queue flow.
 *
 * @category models
 * @since 0.1.0
 */
export type QueueFlow<Tag extends string = "@smthrs/merge-queue/Queue"> = Flow.Flow<
  Tag,
  typeof Payload,
  typeof End,
  typeof RoundError,
  any
>

/**
 * The queue. Start it with `{ config, state: empty, cursor: 0, closed: false,
 * ended: [], settled: 0, round: 0, lineage: lineageRounds }`. A run succeeds
 * when its lineage ends: with `done` once the inbox is closed, every change
 * has ended and every ending is in the record, and otherwise with the
 * `position` to start the next run with.
 *
 * @category flows
 * @since 0.1.0
 */
export const Queue: QueueFlow = Flow.make("@smthrs/merge-queue/Queue", {
  description: "A merge queue: lands changes on a target branch only as trees whose every required check passed.",
  payload: Payload,
  success: End,
  error: RoundError,
  maxRounds,
  // The body names the flow it is the body of, which is what makes one round
  // open the next. It runs when a round is planned, after `Queue` is bound.
  body: ((payload: typeof Payload.Type) =>
    Round.call(payload).pipe(
      Node.branch({
        if: Node.capture({}, (outcome: typeof Outcome.Type) => outcome.handedOver),
        then: (outcome) => Flow.done(outcome.end),
        else: (outcome) =>
          Queue.to({
            config: payload.config,
            state: outcome.state,
            cursor: outcome.cursor,
            closed: outcome.closed,
            ended: outcome.ended,
            settled: outcome.settled,
            round: payload.round + 1,
            lineage: payload.lineage
          })
      })
    )) as never
})
