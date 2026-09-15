/**
 * The scheduler's contract, pinned without timers.
 *
 * Every case drives concurrency by hand: `runOne` hands back a promise the
 * test settles, so dependency order, the concurrency bound, and the failure
 * path are all observed at exact points rather than after a sleep.
 */
import { Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import { resolveJobs, schedule, scheduleEffect } from "../src/Executor.ts"
import type * as Planner from "../src/Planner.ts"

/** A planned target reduced to the two fields the scheduler reads. */
const target = (
  label: string,
  ...dependencies: ReadonlyArray<string>
): Planner.PlannedTarget => ({ label, dependencies } as unknown as Planner.PlannedTarget)

interface Controlled {
  readonly started: Array<string>
  readonly runOne: (label: string) => Promise<void>
  readonly settle: (label: string, cause?: unknown) => void
  readonly running: () => ReadonlyArray<string>
  readonly waitForStart: (label: string) => Promise<void>
}

/** A `runOne` whose every call is settled by the test, one label at a time. */
const controlled = (): Controlled => {
  const started: Array<string> = []
  const starts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const start = (label: string) => {
    if (!starts.has(label)) starts.set(label, Promise.withResolvers<void>())
    return starts.get(label)!
  }
  const pending = new Map<string, { resolve: () => void; reject: (cause: unknown) => void }>()
  return {
    started,
    waitForStart: (label) => start(label).promise,
    running: () => [...pending.keys()],
    runOne: (label) => {
      started.push(label)
      start(label).resolve()
      return new Promise<void>((resolve, reject) => {
        pending.set(label, { resolve, reject })
      })
    },
    settle: (label, cause) => {
      const entry = pending.get(label)
      if (entry === undefined) throw new Error(`${label} is not running`)
      pending.delete(label)
      if (cause === undefined) entry.resolve()
      else entry.reject(cause)
    }
  }
}

/** Yields an event-loop turn so Promise handlers and Effect's completion queue drain. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe("resolveJobs", () => {
  it("defaults to at least one job", () => {
    expect(resolveJobs()).toBeGreaterThanOrEqual(1)
  })

  it("accepts a positive integer", () => {
    expect(resolveJobs(3)).toBe(3)
  })

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["a negative count", -2],
    ["a fraction", 1.5]
  ])("refuses %s", (_name, jobs) => {
    expect(() => resolveJobs(jobs)).toThrow(/jobs must be a positive integer/)
  })
})

describe("schedule", () => {
  it("joins interrupted Effect workers and their finalizers before returning", async () => {
    const released = Promise.withResolvers<void>()
    const started: Array<string> = []
    let finalized = 0
    const fiber = Effect.runFork(scheduleEffect(
      [target("//:a"), target("//:b"), target("//:c")],
      2,
      (label) =>
        Effect.sync(() => started.push(label)).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.promise(() => released.promise).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  finalized++
                })
              )
            )
          )
        )
    ))
    await tick()
    let closed = false
    const done = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      closed = true
    })
    await tick()
    expect(closed).toBe(false)
    expect(started).toEqual(["//:a", "//:b"])
    released.resolve()
    await done
    expect(finalized).toBe(2)
  })

  it("resolves immediately for an empty work list", async () => {
    await expect(schedule([], 4, () => Promise.reject(new Error("must not run")))).resolves.toBeUndefined()
  })

  it("holds a dependent until its dependency settles", async () => {
    const work = controlled()
    const done = schedule([target("//:a"), target("//:b", "//:a")], 4, work.runOne)

    await tick()
    expect(work.started).toEqual(["//:a"])
    work.settle("//:a")
    await work.waitForStart("//:b")
    expect(work.started).toEqual(["//:a", "//:b"])
    work.settle("//:b")
    await expect(done).resolves.toBeUndefined()
  })

  it("never exceeds the concurrency bound", async () => {
    const work = controlled()
    const targets = ["//:a", "//:b", "//:c", "//:d"].map((label) => target(label))
    const done = schedule(targets, 2, work.runOne)

    await tick()
    expect(work.running()).toEqual(["//:a", "//:b"])
    work.settle("//:a")
    await work.waitForStart("//:c")
    expect(work.running()).toEqual(["//:b", "//:c"])
    work.settle("//:b")
    work.settle("//:c")
    await work.waitForStart("//:d")
    work.settle("//:d")
    await expect(done).resolves.toBeUndefined()
  })

  /**
   * `runOne` reports an ordinary target failure and still resolves, so a
   * rejection is an internal fault. Returning at that moment left the targets
   * already in flight running: they kept writing files and storing cache
   * entries after `execute` had closed the cache and returned. The scheduler
   * now stops dispatching and waits for them.
   */
  it("drains the targets in flight before reporting an internal fault", async () => {
    const work = controlled()
    const targets = ["//:a", "//:b", "//:c"].map((label) => target(label))
    const done = schedule(targets, 2, work.runOne)
    let settled = false
    void done.catch(() => {
      settled = true
    })

    await tick()
    expect(work.running()).toEqual(["//:a", "//:b"])
    work.settle("//:a", new Error("scheduler fault"))
    await tick()

    // Not settled: //:b is still running. And //:c was never dispatched.
    expect(settled).toBe(false)
    expect(work.started).toEqual(["//:a", "//:b"])

    work.settle("//:b")
    await expect(done).rejects.toThrow("scheduler fault")
  })

  it("reports the first fault, not the last", async () => {
    const work = controlled()
    const done = schedule(["//:a", "//:b"].map((label) => target(label)), 2, work.runOne)

    await tick()
    work.settle("//:a", new Error("first"))
    work.settle("//:b", new Error("second"))
    await expect(done).rejects.toThrow("first")
  })

  it("refuses an already-aborted schedule before dispatching anything", async () => {
    const work = controlled()
    const controller = new AbortController()
    controller.abort(new Error("cancelled before dispatch"))

    await expect(schedule([target("//:a")], 1, work.runOne, controller.signal))
      .rejects.toThrow("cancelled before dispatch")
    expect(work.started).toEqual([])
  })

  it("stops dispatching and drains in-flight targets after cancellation", async () => {
    const work = controlled()
    const controller = new AbortController()
    const done = schedule(
      [target("//:a"), target("//:b"), target("//:c")],
      2,
      work.runOne,
      controller.signal
    )
    let settled = false
    void done.catch(() => {
      settled = true
    })

    await tick()
    expect(work.started).toEqual(["//:a", "//:b"])
    controller.abort(new Error("cancelled in flight"))
    await tick()
    expect(settled).toBe(false)
    expect(work.started).toEqual(["//:a", "//:b"])

    work.settle("//:a")
    work.settle("//:b")
    await expect(done).rejects.toThrow("cancelled in flight")
    expect(work.started).toEqual(["//:a", "//:b"])
  })

  it("does not release a dependent when cancellation wins the completion microtask", async () => {
    const work = controlled()
    const controller = new AbortController()
    const done = schedule(
      [target("//:a"), target("//:b", "//:a")],
      1,
      work.runOne,
      controller.signal
    )

    await tick()
    work.settle("//:a")
    controller.abort(new Error("cancelled at dependency boundary"))
    await expect(done).rejects.toThrow("cancelled at dependency boundary")
    expect(work.started).toEqual(["//:a"])
  })

  it("wraps a non-error rejection", async () => {
    const work = controlled()
    const done = schedule([target("//:a")], 1, work.runOne)

    await tick()
    work.settle("//:a", "a thrown string")
    await expect(done).rejects.toThrow("a thrown string")
  })

  it("settles without invoking conversion on an object rejection", async () => {
    const work = controlled()
    const done = schedule([target("//:a")], 1, work.runOne)
    let calls = 0
    const cause = {
      toString: () => {
        calls += 1
        throw new Error("conversion must not run")
      }
    }

    await tick()
    work.settle("//:a", cause)
    await expect(done).rejects.toThrow("scheduled target rejected")
    expect(calls).toBe(0)
  })

  it("settles an object-valued abort without inspecting its Proxy", async () => {
    let calls = 0
    const reason = new Proxy(new Error("hidden"), {
      getOwnPropertyDescriptor: (target, property) => {
        calls += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      }
    })
    const controller = new AbortController()
    controller.abort(reason)

    await expect(schedule([target("//:a")], 1, () => Promise.resolve(), controller.signal))
      .rejects.toThrow("execution aborted")
    expect(calls).toBe(0)
  })

  /**
   * The regression: a drained scheduler resolved whenever the ready queue was
   * empty, even with targets it never dispatched. `execute` then summarized
   * only the dispatched subset and reported `ok: true` for a run that silently
   * dropped work. An unsatisfiable graph is now refused before anything runs,
   * so the run does not execute half of itself and then discover it can never
   * finish.
   */
  it("rejects, instead of resolving green, when the graph holds a dependency cycle", async () => {
    const work = controlled()
    const done = schedule(
      [target("//:a", "//:b"), target("//:b", "//:a"), target("//:c")],
      2,
      work.runOne
    )

    await expect(done).rejects.toThrow(
      /2 of 3 targets never became ready.*\/\/:a, \/\/:b/
    )
    expect(work.started).toEqual([])
  })

  it("rejects a cycle that only closes through a longer path", async () => {
    const work = controlled()
    await expect(
      schedule(
        [target("//:a", "//:c"), target("//:b", "//:a"), target("//:c", "//:b")],
        2,
        work.runOne
      )
    ).rejects.toThrow(/\/\/:a, \/\/:b, \/\/:c/)
    expect(work.started).toEqual([])
  })

  /**
   * The API's own invariants, checked by the API. `execute` validates its
   * flag, but `schedule` is exported and a caller reaching it directly used to
   * get a scheduler that hung, dropped work, or released a dependent early
   * with no diagnostic at all.
   */
  describe("refuses a work list it cannot schedule", () => {
    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["zero", 0],
      ["a negative count", -2],
      ["a fraction", 1.5]
    ])("rejects %s jobs instead of hanging", async (_name, jobs) => {
      const work = controlled()
      await expect(schedule([target("//:a")], jobs, work.runOne))
        .rejects.toThrow(/jobs must be a positive integer/)
      expect(work.started).toEqual([])
    })

    it("rejects a duplicate label", async () => {
      // Two targets sharing a label share one completion slot: one is dropped
      // and the other's dependents are released by the wrong completion.
      const work = controlled()
      await expect(schedule([target("//:a"), target("//:a")], 2, work.runOne))
        .rejects.toThrow(/names \/\/:a more than once/)
      expect(work.started).toEqual([])
    })

    it("rejects an unknown dependency", async () => {
      // Previously filtered out silently, which released the dependent as if
      // its dependency had succeeded.
      const work = controlled()
      await expect(schedule([target("//:b", "//:missing")], 2, work.runOne))
        .rejects.toThrow(/\/\/:b depends on \/\/:missing, which is not in the work list/)
      expect(work.started).toEqual([])
    })

    it("rejects a duplicate dependency edge", async () => {
      // The edge is counted twice and decremented once, so the dependent never
      // becomes ready and the scheduler used to wait forever.
      const work = controlled()
      await expect(schedule([target("//:a"), target("//:b", "//:a", "//:a")], 2, work.runOne))
        .rejects.toThrow(/lists the dependency \/\/:a more than once/)
      expect(work.started).toEqual([])
    })

    it("rejects a self-dependency", async () => {
      const work = controlled()
      await expect(schedule([target("//:a", "//:a")], 2, work.runOne))
        .rejects.toThrow(/\/\/:a depends on itself/)
      expect(work.started).toEqual([])
    })
  })

  /**
   * The regression: a synchronous throw from `runOne` dispatched inside a
   * completion handler rejected nothing anyone observed, so the returned
   * promise never settled. The throw now joins the ordinary internal-fault
   * path.
   */
  it("treats a synchronous throw from runOne as an internal fault", async () => {
    const work = controlled()
    const throwing = (label: string): Promise<void> => {
      if (label === "//:b") throw new Error("sync fault")
      return work.runOne(label)
    }
    const done = schedule([target("//:a"), target("//:b", "//:a")], 1, throwing)

    await tick()
    work.settle("//:a")
    await expect(done).rejects.toThrow("sync fault")
  })
})
