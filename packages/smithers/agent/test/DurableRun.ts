/**
 * Watches a forked run on the durable engine by what it commits, never by elapsed time.
 *
 * A run parks, wakes, and settles in fibers the case does not own, so the case
 * has to learn when the run changed. The journal tells it: a park or a
 * settlement commits its journal entry in the same transaction as the state it
 * describes, and `Journal.changes` publishes that entry once the transaction
 * commits. Re-reading the engine's state at each published entry therefore
 * sees the commit a case waits for as soon as it lands, with no wall-clock
 * bound for host load to exceed. The buffer slides: a slow reader loses old
 * entries but always receives the newest, and the newest is the one a re-read
 * needs.
 *
 * Time moves only on the TEST clock, and only to a wake the run recorded. The
 * engine's clock timer takes its delay from the persisted due time when the
 * timer starts (`DeferredPersistence.armTimer`), so moving the clock to that
 * due time fires the timer whether it started before the move or after it.
 */
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Journal } from "@smthrs/journal"
import { Clock, Effect, Exit, Fiber, PubSub } from "effect"
import { TestClock } from "effect/testing"

/** Waits for the run's next journal commit or for the run to end, whichever comes first. */
const nextCommit = <A>(changes: PubSub.Subscription<A>, running: Fiber.Fiber<unknown, unknown>) =>
  Effect.raceFirst(Effect.asVoid(PubSub.take(changes)), Effect.asVoid(Fiber.await(running)))

/**
 * Re-reads `holds` at every journal commit until it is true, without moving the clock.
 *
 * Answers true once it holds. A run that fails first fails the wait with the
 * run's own cause; a run that succeeds first answers false, so the case's
 * assertion reports what the run did instead of hanging.
 */
export const untilCommitted = <E, R>(
  running: Fiber.Fiber<unknown, unknown>,
  holds: Effect.Effect<boolean, E, R>
): Effect.Effect<boolean, unknown, R | Journal.Journal> =>
  Effect.scoped(Effect.gen(function*() {
    // Subscribed before the first read, so no commit can land between the two.
    const changes = yield* (yield* Journal.Journal).changes
    while (!(yield* holds)) {
      const exit = running.pollUnsafe()
      if (exit !== undefined) return Exit.isFailure(exit) ? yield* Effect.failCause(exit.cause) : false
      yield* nextCommit(changes, running)
    }
    return true
  }))

/**
 * Joins a forked run on the durable engine and a TEST clock.
 *
 * Whenever every clock the run has pending is still ahead of the test clock,
 * the clock moves to the earliest of them. Otherwise nothing the run waits on
 * needs time to pass, and the case waits for its next commit or its end.
 */
export const settle = <A, E>(
  running: Fiber.Fiber<A, E>,
  executionId: string
): Effect.Effect<A, E, DurableEngineState.DurableEngineState | Journal.Journal> =>
  Effect.scoped(Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const changes = yield* (yield* Journal.Journal).changes
    while (running.pollUnsafe() === undefined) {
      const due = (yield* state.pendingClocks({ executionId })).map((clock) => clock.dueAtMs)
      const nextWakeMs = due.length === 0 ? undefined : Math.min(...due)
      if (nextWakeMs !== undefined && nextWakeMs > (yield* Clock.currentTimeMillis)) {
        yield* TestClock.setTime(nextWakeMs)
      } else {
        yield* nextCommit(changes, running)
      }
    }
    return yield* Fiber.join(running)
  }))
