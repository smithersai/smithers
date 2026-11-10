/**
 * Fuzzes fiber interleavings and time as part of a `Fuzz` input.
 *
 * `FuzzSimulation.execution()` runs every property evaluation in a fresh closed world: a scheduler whose dispatchers
 * share one priority/FIFO queue, preemption points chosen by a schedule tape that the fuzzer mutates like any other
 * input, and a virtual clock. A race that ordinary cooperative scheduling never exposes becomes a reproducible finding
 * with a replay token, and a program that waits forever is a `Deadlock` finding.
 *
 * @stability unstable
 * @since 4.0.0
 */
import type * as Fuzz from "../Fuzz.ts"
import * as Internal from "../internal/fuzz/simulation.ts"

/**
 * Configures {@link execution}.
 *
 * **Details**
 *
 * `maxSteps`, default 100,000, bounds dispatched tasks and timer wakes in one evaluation; reaching it counts as a
 * discard when cleanup completes. Cleanup gets another `maxSteps`; exceeding it or deadlocking is an execution-driver
 * error. `maxOpsBeforeYield`, default 2048, is the slice length for schedule word 0, the ordinary cooperative
 * schedule. Other words preempt a fiber after 3, 4, 5, 6, 8, 12, 16 or 32 run-loop operations.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Options {
  readonly maxSteps?: number | undefined
  readonly maxOpsBeforeYield?: number | undefined
}

/**
 * Creates a `Fuzz.Execution` that makes fiber preemption points and virtual time part of the fuzzed input.
 *
 * **When to use**
 *
 * Use with `Fuzz.run` or `Fuzz.runTarget` as the `execution` option to find check-then-act races, lost updates,
 * deadlocks and timeout ties in Effect code.
 *
 * **Details**
 *
 * Queued tasks run in the order the scheduler contract documents: lower priority first, FIFO within a priority. The
 * schedule tape decides how many operations each fiber slice runs before the runtime yields it, exploring yield
 * points while preserving queue ordering. `Effect.sleep`, `Clock` and timeouts use virtual
 * time: when no task is queued, time jumps to the earliest timer and every timer due then wakes, in registration order.
 * When no task is queued and no timer is pending but the property has not finished, the result is a `Deadlock`
 * finding if cleanup completes. Shrinking zeroes schedule words toward more cooperative scheduling within the shrink
 * budget. Cleanup that deadlocks or exceeds its step budget raises an execution-driver error; a suspended
 * uninterruptible root or finalizer may still retain resources.
 *
 * **Gotchas**
 *
 * The world is closed: real I/O, native timers, `Date.now`, `Math.random` and promises from outside Effect escape it.
 * An escape looks like a deadlock or makes replay diverge. Provide deterministic in-memory services to the property.
 *
 * **Example** (Finding a check-then-act race)
 *
 * ```ts
 * import { Arbitrary, Effect, Fuzz, Ref, Schema } from "effect"
 * import { FuzzSimulation } from "effect/testing"
 *
 * // Reads, checks, then writes: a preemption between the read and the write loses an update.
 * const withdraw = (balance: Ref.Ref<number>, paid: Ref.Ref<number>, amount: number) =>
 *   Effect.gen(function*() {
 *     const current = yield* Ref.get(balance)
 *     if (current < amount) return
 *     yield* Ref.set(balance, current - amount)
 *     yield* Ref.update(paid, (total) => total + amount)
 *   })
 *
 * const amount = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })))
 * const report = Fuzz.run(Arbitrary.all([amount, amount]), ([a, b]) =>
 *   Effect.gen(function*() {
 *     const balance = yield* Ref.make(100)
 *     const paid = yield* Ref.make(0)
 *     yield* Effect.all([withdraw(balance, paid, a), withdraw(balance, paid, b)], { concurrency: 2 })
 *     return (yield* Ref.get(balance)) + (yield* Ref.get(paid)) === 100
 *   }), { execution: FuzzSimulation.execution(), executions: 10_000, seed: 1 })
 * ```
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const execution: (options?: Options) => Fuzz.Execution = Internal.execution
