/**
 * The queue as a durable flow.
 *
 * One flow round is one driver round. The round's work is a single recorded
 * action; its result, the queue's next position, is the payload of the next
 * round. So the queue's whole state lives in the flow's journal: a host that
 * crashes resumes at the last recorded position, and a round that crashed
 * before it was recorded runs again, which `Driver.round` makes safe.
 *
 * The flow has no pause, hold or freeze. It ends only when the inbox was
 * closed and every change has ended.
 *
 * @since 0.1.0
 */

import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Schema from "effect/Schema"
import * as Driver from "./Driver.ts"
import { Config, Ending, State } from "./Schema.ts"
import { TargetDiverged, Unavailable } from "./Services.ts"

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
  round: Natural
})

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
  done: Schema.Boolean
})

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
export const layer = Round.toLayer(({ closed, config, cursor, ended, state }) =>
  Driver.round(config, { state, cursor, closed, ended })
)

/**
 * The most rounds one queue lineage runs before the engine stops it. A queue
 * that reaches it is started again from its last position.
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
  typeof State,
  typeof RoundError,
  any
>

/**
 * The queue. Start it with `{ config, state: empty, cursor: 0, closed: false,
 * ended: [], round: 0 }`; it succeeds with the final state once the inbox is
 * closed, every change has ended and every ending is in the record.
 *
 * @category flows
 * @since 0.1.0
 */
export const Queue: QueueFlow = Flow.make("@smthrs/merge-queue/Queue", {
  description: "A merge queue: lands changes on a target branch only as trees whose every required check passed.",
  payload: Payload,
  success: State,
  error: RoundError,
  maxRounds,
  // The body names the flow it is the body of, which is what makes one round
  // open the next. It runs when a round is planned, after `Queue` is bound.
  body: ((payload: typeof Payload.Type) =>
    Round.call(payload).pipe(
      Node.branch({
        if: Node.capture({}, (outcome: typeof Outcome.Type) => outcome.done),
        then: (outcome) => Flow.done(outcome.state),
        else: (outcome) =>
          Queue.to({
            config: payload.config,
            state: outcome.state,
            cursor: outcome.cursor,
            closed: outcome.closed,
            ended: outcome.ended,
            round: payload.round + 1
          })
      })
    )) as never
})
