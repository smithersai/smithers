import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import type * as Fiber from "effect/Fiber"
import type * as Fuzz from "../../Fuzz.ts"
import * as Scheduler from "effect/Scheduler"

interface Timer {
  readonly deadline: bigint
  readonly sequence: number
  readonly wake: () => void
}

/** @internal */
export type Outcome = "Completed" | "Deadlock" | "Limited"

/**
 * Steps the driver runs before it yields its own fiber, so an interruption of the fuzz run is observed while a long
 * evaluation is still running.
 */
const stepsPerSlice = 4096

/**
 * One closed world: a scheduler whose dispatchers share a single priority/FIFO queue, a virtual clock, and preemption
 * points read from the schedule tape.
 *
 * Queued tasks always run in the documented order (lower priority first, FIFO within a priority). The schedule tape
 * chooses only how many operations each fiber slice may run before the runtime yields it: word 0 is the ceiling, so
 * a zero tape is ordinary cooperative scheduling. Reordering queued tasks would break the dispatcher contract and
 * report races that cannot happen.
 *
 * @internal
 */
export class World {
  readonly buckets: Array<[priority: number, tasks: Array<() => void>]> = []
  readonly timers: Array<Timer> = []
  readonly slices = new WeakMap<Fiber.Fiber<unknown, unknown>, number>()
  // Every fiber that has run in the world, so the ones still alive when the root exits can be released.
  readonly fibers = new Set<Fiber.Fiber<unknown, unknown>>()
  readonly schedule: Fuzz.ScheduleTape
  readonly quanta: ReadonlyArray<number>
  // Virtual time in integer nanoseconds, so sub-millisecond sleeps keep their precision.
  now = BigInt(0)
  sequence = 0
  steps = 0
  limit: number

  constructor(schedule: Fuzz.ScheduleTape, maxSteps: number, ceiling: number) {
    this.schedule = schedule
    // Resuming after a preemption costs two run-loop operations (the resumed exit and its continuation), so a slice
    // shorter than three operations would preempt the fiber again before it does any work.
    this.quanta = [ceiling, 3, 4, 5, 6, 8, 12, 16, 32]
    this.limit = maxSteps
  }

  readonly scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    shouldYield: (fiber) => {
      // The run loop resets the operation count at the start of every slice, so a count of one is a new slice.
      if (fiber.currentOpCount === 1) {
        this.fibers.add(fiber)
        const word = this.schedule.next()
        const index = word === 0 ? 0 : 1 + Math.floor(word / 0x100000000 * (this.quanta.length - 1))
        this.slices.set(fiber, this.quanta[index]!)
      }
      return fiber.currentOpCount >= this.slices.get(fiber)!
    },
    makeDispatcher: () => ({
      scheduleTask: (task, priority) => this.enqueue(task, priority),
      flush: () => {
        let task = this.dequeue()
        while (task !== undefined) {
          task()
          task = this.dequeue()
        }
      }
    })
  }

  readonly clock: Clock.Clock = {
    // Whole milliseconds, like `Date.now`.
    currentTimeMillisUnsafe: () => Number(this.now / BigInt(1_000_000)),
    currentTimeMillis: Effect.sync(() => Number(this.now / BigInt(1_000_000))),
    currentTimeNanosUnsafe: () => this.now,
    currentTimeNanos: Effect.sync(() => this.now),
    monotonicTimeNanosUnsafe: () => this.now,
    monotonicTimeNanos: Effect.sync(() => this.now),
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        // An infinite sleep never wakes; with nothing else to run it is a deadlock.
        if (!Duration.isFinite(duration)) return
        const timer: Timer = {
          deadline: this.now + Duration.toNanosUnsafe(duration),
          sequence: this.sequence++,
          wake: () => resume(Effect.void)
        }
        let index = this.timers.length
        while (index > 0 && this.timers[index - 1]!.deadline > timer.deadline) index--
        this.timers.splice(index, 0, timer)
        // An interrupted sleep withdraws its timer. A woken timer has already left the list.
        return Effect.sync(() => {
          this.timers.splice(0, this.timers.length, ...this.timers.filter((other) => other !== timer))
        })
      })
  }

  enqueue(task: () => void, priority: number): void {
    let index = 0
    while (index < this.buckets.length && this.buckets[index]![0] < priority) index++
    const bucket = this.buckets[index]
    if (bucket !== undefined && bucket[0] === priority) bucket[1].push(task)
    else this.buckets.splice(index, 0, [priority, [task]])
  }

  dequeue(): (() => void) | undefined {
    const bucket = this.buckets[0]
    if (bucket === undefined) return undefined
    const task = bucket[1].shift()!
    if (bucket[1].length === 0) this.buckets.shift()
    return task
  }

  /**
   * Runs queued tasks until `done` holds, at most `slice` loop turns at a time. When no task is queued, virtual time
   * jumps to the earliest timer and wakes every timer due then, in registration order. A wake resumes its fiber
   * synchronously, so each wake counts as a step like a task: a loop of sleeps reaches the limit too. The limit is
   * checked before a task leaves the queue, so a limited world keeps every pending continuation.
   */
  run(done: () => boolean, slice: number): Outcome | "Paused" {
    for (let turn = 0; !done(); turn++) {
      if (this.steps >= this.limit) return "Limited"
      if (turn === slice) return "Paused"
      const task = this.dequeue()
      if (task !== undefined) {
        this.steps++
        task()
        continue
      }
      const first = this.timers[0]
      if (first === undefined) return "Deadlock"
      this.now = first.deadline
      while (this.timers.length > 0 && this.timers[0]!.deadline === this.now) {
        if (this.steps >= this.limit) return "Limited"
        this.steps++
        this.timers.shift()!.wake()
      }
    }
    return "Completed"
  }

  /**
   * Interrupts every fiber still alive in the world, including fibers that queued work starts meanwhile, and runs
   * their finalizers inside the world with a fresh budget of `steps`. Returns `"Completed"` when every fiber has
   * exited and no task is queued, `"Limited"` when work was still running at the end of that budget, or
   * `"Deadlock"` when an interrupted fiber remains suspended with no runnable work or timers.
   */
  release(steps: number): Outcome {
    const interrupted = new Set<Fiber.Fiber<unknown, unknown>>()
    this.limit = this.steps + steps
    return this.run(() => {
      // An interruption can exit the fiber at once, or start more fibers, so exits are read after every interruption.
      for (const fiber of this.fibers) {
        if (!interrupted.has(fiber)) {
          interrupted.add(fiber)
          fiber.interruptUnsafe()
        }
      }
      for (const fiber of this.fibers) {
        if (fiber.pollUnsafe() !== undefined) this.fibers.delete(fiber)
      }
      return this.fibers.size === 0 && this.buckets.length === 0
    }, Infinity) as Outcome
  }
}

/** @internal */
export const execution = (options?: {
  readonly maxSteps?: number | undefined
  readonly maxOpsBeforeYield?: number | undefined
}): Fuzz.Execution => {
  const maxSteps = options?.maxSteps ?? 100_000
  const ceiling = options?.maxOpsBeforeYield ?? 2048
  return {
    name: "simulation",
    run: (self, schedule) =>
      Effect.withFiber((parent) => {
        const world = new World(schedule, maxSteps, ceiling)
        const context = Context.add(
          Context.add(Context.add(parent.context, Scheduler.Scheduler, world.scheduler), Clock.Clock, world.clock),
          Scheduler.PreventSchedulerYield,
          false
        )
        const fiber = Effect.runForkWith(context)(self as Effect.Effect<Exit.Exit<unknown, unknown>>)
        world.fibers.add(fiber)
        const exited = () => fiber.pollUnsafe() !== undefined
        const drive = (): Effect.Effect<Outcome> =>
          Effect.suspend(() => {
            const outcome = world.run(exited, stepsPerSlice)
            return outcome === "Paused" ? Effect.flatMap(Effect.yieldNow, drive) : Effect.succeed(outcome)
          })
        return drive().pipe(
          // Interrupting the fuzz run releases what the evaluation holds before the interruption propagates.
          Effect.onInterrupt(() => Effect.sync(() => world.release(maxSteps))),
          Effect.flatMap((outcome): Effect.Effect<Fuzz.ExecutionResult> => {
            // Release what the program still holds: a stuck root, and fibers that outlive the root, such as detached
            // forks. Their finalizers run inside the world. A finalizer that is still running when the budget ends
            // would be abandoned half done: that is a driver failure, not a finding.
            const cleanup = world.release(maxSteps)
            if (cleanup !== "Completed") {
              return Effect.die(
                new Error(
                  `the simulation ${
                    outcome === "Completed"
                      ? "completed an"
                      : `interrupted a ${outcome === "Deadlock" ? "deadlocked" : "step-limited"}`
                  } evaluation, but ${
                    cleanup === "Deadlock"
                      ? "cleanup deadlocked: a finalizer or uninterruptible fiber remains suspended"
                      : `its finalizers did not finish within ${maxSteps} more steps; raise maxSteps`
                  }`
                )
              )
            }
            if (outcome === "Completed") {
              return Effect.map(fiber.pollUnsafe()!, (exit): Fuzz.ExecutionResult => ({ _tag: "Completed", exit }))
            }
            return Effect.succeed({ _tag: outcome })
          })
        )
      })
  }
}
