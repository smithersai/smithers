import * as Control from "@smthrs/control/Control"
import { Unavailable } from "@smthrs/control/ControlError"
import type { Receipt, RunStatus } from "@smthrs/control/ControlSchema"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Scheduler from "../src/Scheduler.ts"
import * as TestTriggers from "../src/test/TestTriggers.ts"
import type { Trigger } from "../src/Trigger.ts"
import { TriggerError } from "../src/TriggerError.ts"
import * as TriggerStore from "../src/TriggerStore.ts"

const hour = 60 * 60 * 1_000

interface RunnerFixture {
  readonly service: Scheduler.RunnerService
  readonly starts: Array<Scheduler.StartInput>
  readonly active: Set<string>
  readonly cancels: Set<string>
  /** Every cancel, in order, so a double cancel is visible. */
  readonly cancelled: Array<string>
  /** Every run id the scheduler asked the runner about. */
  readonly inspected: Array<string>
  failures: number
}

const runnerFixture = (failures = 0): RunnerFixture => {
  const starts: Array<Scheduler.StartInput> = []
  const active = new Set<string>()
  const cancels = new Set<string>()
  const cancelled: Array<string> = []
  const inspected: Array<string> = []
  const fixture: RunnerFixture = {
    starts,
    active,
    cancels,
    cancelled,
    inspected,
    failures,
    service: Scheduler.makeRunner({
      start: (input) =>
        Effect.suspend(() => {
          starts.push(input)
          if (fixture.failures > 0) {
            fixture.failures--
            return Effect.fail(
              new TriggerError({ code: "store", message: "runner launch failed" })
            )
          }
          const runId = `run-${starts.length}`
          active.add(runId)
          return Effect.succeed(runId)
        }),
      isActive: (runId) =>
        Effect.sync(() => {
          inspected.push(runId)
          return active.has(runId)
        }),
      cancel: (runId) =>
        Effect.sync(() => {
          cancels.add(runId)
          cancelled.push(runId)
          active.delete(runId)
        })
    })
  }
  return fixture
}

const trigger = (
  overlap: Trigger["overlap"] = "skip",
  catchUp: Trigger["catchUp"] = "one"
): Trigger => ({
  id: "hourly",
  flowId: "flow",
  input: { source: "schedule" },
  cron: "0 * * * *",
  timezone: "UTC",
  overlap,
  catchUp,
  maxCatchUp: 3,
  enabled: true
})

const recordingStore = (
  results: Array<TriggerStore.Result>
): Layer.Layer<TriggerStore.TriggerStore> =>
  Layer.effect(
    TriggerStore.TriggerStore,
    Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      return TriggerStore.TriggerStore.of({
        ...store,
        recordResult: (result) =>
          Effect.sync(() => {
            results.push(result)
          }).pipe(Effect.andThen(store.recordResult(result)))
      })
    })
  ).pipe(Layer.provide(TestTriggers.layer))

const provideTest = <A, E>(
  effect: Effect.Effect<A, E, TriggerStore.TriggerStore>,
  results: Array<TriggerStore.Result>
) =>
  effect.pipe(
    Effect.provide(recordingStore(results)),
    Effect.provide(TestClock.layer())
  )

const seed = (
  store: TriggerStore.Service,
  declaration: Trigger,
  fixture: RunnerFixture,
  outcome: TriggerStore.Outcome = "launched"
) =>
  Effect.gen(function*() {
    const registered = yield* store.register(declaration)
    yield* store.claimFire({
      triggerId: declaration.id,
      occurrence: 0,
      expectedRevision: registered.revision
    })
    if (outcome === "launched") fixture.active.add("seed")
    yield* store.recordResult({
      triggerId: declaration.id,
      occurrence: 0,
      ...(outcome === "launched"
        ? { outcome, runId: "seed", reservationId: (yield* store.inspect(declaration.id)).activeRunId! }
        : { outcome })
    })
  })

describe("Scheduler", () => {
  it("recovers disabled active occurrences without scheduling new ones", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(provideTest(
      Effect.scoped(Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const declaration = trigger("skip", "none")
        yield* seed(store, declaration, runner)
        yield* store.register({ ...declaration, enabled: false })
        yield* TestClock.setTime(hour)
        const scheduler = yield* Scheduler.make().pipe(Effect.provide(Layer.succeed(Scheduler.Runner)(runner.service)))
        yield* scheduler.runOnce
        expect(runner.inspected).toContain("seed")
        expect(runner.starts).toEqual([])
        runner.active.delete("seed")
        yield* scheduler.runOnce
        expect(yield* store.activeRun(declaration.id)).toMatchObject({ _tag: "None" })
        expect(runner.starts).toEqual([])
      })),
      results
    ))
  })

  for (const overlap of ["skip", "buffer-one", "supersede"] as const) {
    for (const catchUp of ["none", "one", "all"] as const) {
      it(`${overlap} × ${catchUp}`, async () => {
        const results: Array<TriggerStore.Result> = []
        const runner = runnerFixture()
        await Effect.runPromise(
          provideTest(
            Effect.scoped(
              Effect.gen(function*() {
                const store = yield* TriggerStore.TriggerStore
                yield* seed(store, trigger(overlap, catchUp), runner)
                results.length = 0
                yield* TestClock.setTime(3 * hour)
                const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
                  Effect.provideService(Scheduler.Runner, runner.service)
                )
                yield* scheduler.runOnce
                yield* Effect.yieldNow
              })
            ),
            results
          )
        )

        const count = catchUp === "none" ? 0 : catchUp === "one" ? 1 : 3
        if (overlap === "skip") {
          expect(runner.starts).toHaveLength(0)
          expect(results.filter((result) => result.outcome === "skipped")).toHaveLength(count)
        } else if (overlap === "buffer-one") {
          expect(runner.starts).toHaveLength(0)
          expect(results.filter((result) => result.outcome === "buffered")).toHaveLength(count)
        } else {
          expect(runner.starts).toHaveLength(count)
          expect(results.filter((result) => result.outcome === "launched")).toHaveLength(count)
        }
      })
    }
  }

  it("coalesces buffer-one to the latest pending occurrence and launches it after terminal", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger("buffer-one", "all"), runner)
            results.length = 0
            yield* TestClock.setTime(3 * hour)
            const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* scheduler.runOnce
            expect(runner.starts).toHaveLength(0)

            runner.active.delete("seed")
            yield* scheduler.runOnce
            yield* Effect.yieldNow
          })
        ),
        results
      )
    )

    expect(runner.starts).toHaveLength(1)
    expect(runner.starts[0]?.idempotencyKey).toBe(
      `hourly:${new Date(3 * hour).toISOString()}`
    )
  })

  it("supersedes by interrupting the prior child and cancelling its run", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger("supersede", "one"), runner, "skipped")
            results.length = 0
            const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )

            yield* TestClock.setTime(hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            yield* TestClock.setTime(2 * hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
          })
        ),
        results
      )
    )

    expect(runner.starts).toHaveLength(2)
    expect(runner.cancels.has("run-1")).toBe(true)
    expect(results.some((result) => result.outcome === "superseded")).toBe(true)
  })

  it("recovers missed work from durable lastFiredAt after restart", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seed(store, trigger("skip", "one"), runner, "skipped")
          results.length = 0

          yield* TestClock.setTime(hour)
          yield* Effect.scoped(
            Effect.gen(function*() {
              const scheduler = yield* Scheduler.make().pipe(
                Effect.provideService(Scheduler.Runner, runner.service)
              )
              yield* scheduler.runOnce
              yield* Effect.yieldNow
            })
          )
          runner.active.clear()

          yield* TestClock.setTime(3 * hour)
          yield* Effect.scoped(
            Effect.gen(function*() {
              const scheduler = yield* Scheduler.make().pipe(
                Effect.provideService(Scheduler.Runner, runner.service)
              )
              yield* scheduler.runOnce
              yield* Effect.yieldNow
            })
          )
        }),
        results
      )
    )

    expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(hour).toISOString()}`,
      `hourly:${new Date(3 * hour).toISOString()}`
    ])
  })

  it("allows only one claim winner across two competing schedulers", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger("skip", "one"), runner, "skipped")
            results.length = 0
            yield* TestClock.setTime(hour)
            const first = yield* Scheduler.make().pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            const second = yield* Scheduler.make().pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* Effect.all([first.runOnce, second.runOnce], {
              concurrency: "unbounded",
              discard: true
            })
            yield* Effect.yieldNow
          })
        ),
        results
      )
    )

    expect(runner.starts).toHaveLength(1)
    expect(results.filter((result) => result.outcome === "launched")).toHaveLength(1)
  })

  it("polls active runs every fifteen seconds by default", async () => {
    const runner = runnerFixture()
    await Effect.runPromise(provideTest(
      Effect.scoped(Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* seed(store, trigger(), runner, "skipped")
        const scheduler = yield* Scheduler.make().pipe(Effect.provideService(Scheduler.Runner, runner.service))
        yield* TestClock.setTime(hour)
        yield* scheduler.runOnce
        yield* Effect.yieldNow
        expect(runner.inspected).toEqual(["run-1"])
        yield* TestClock.adjust("14 seconds")
        expect(runner.inspected).toEqual(["run-1"])
        yield* TestClock.adjust("1 second")
        expect(runner.inspected).toEqual(["run-1", "run-1"])
      })),
      []
    ))
  })

  it("records launch failure and advances to the next occurrence", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture(1)
    let lastFiredAt: number | undefined
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger("skip", "one"), runner, "skipped")
            results.length = 0
            const scheduler = yield* Scheduler.make().pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )

            yield* TestClock.setTime(hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            yield* TestClock.setTime(2 * hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            lastFiredAt = (yield* store.get("hourly")).pipe(
              (option) => option._tag === "Some" ? option.value.lastFiredAt : undefined
            )
          })
        ),
        results
      )
    )

    expect(runner.starts).toHaveLength(2)
    expect(results.some((result) => result.outcome === "failed")).toBe(true)
    expect(results.some((result) => result.outcome === "launched")).toBe(true)
    expect(lastFiredAt).toBe(2 * hour)
  })

  it("does not dispatch after an interrupted claim", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger("skip", "one"), runner, "skipped")
            results.length = 0
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const blocked = TriggerStore.TriggerStore.of({
              ...store,
              claimFire: (fire) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(store.claimFire(fire))
                )
            })
            yield* TestClock.setTime(hour)
            const scheduler = yield* Scheduler.make().pipe(
              Effect.provideService(TriggerStore.TriggerStore, blocked),
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            const fiber = yield* Effect.forkScoped(scheduler.runOnce)
            yield* Deferred.await(entered)
            yield* Fiber.interrupt(fiber)
            yield* Deferred.succeed(release, undefined)
            yield* Effect.yieldNow
          })
        ),
        results
      )
    )

    expect(runner.starts).toHaveLength(0)
    expect(results).toHaveLength(0)
  })

  // The scheduler never approves its own plan. It re-offers the same
  // idempotent run request and takes the run id once somebody else approves.
  it("retries a parked plan until approval accepts it, never approving it itself", async () => {
    let runAttempts = 0
    const fixture = controlFixture({
      run: () =>
        Effect.sync(() => {
          runAttempts++
          return runAttempts === 1
            ? {
              _tag: "Parked" as const,
              receiptId: "parked",
              planId: "plan-1",
              status: "waiting-approval" as const
            }
            : { _tag: "Accepted" as const, receiptId: "started", runId: "run-1" }
        }),
      approve: () => Effect.die("the scheduler must never approve a plan")
    })
    const input = {
      flowId: "flow",
      input: { source: "schedule", occurrence: hour },
      idempotencyKey: "trigger:occurrence"
    }
    const runId = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const runner = yield* Scheduler.Runner
          const fiber = yield* Effect.forkScoped(
            runner.start(input)
          )
          yield* TestClock.adjust("1 second")
          return yield* Fiber.join(fiber)
        })
      ).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(
          Scheduler.layerControlRunner.pipe(Layer.provide(fixture.layer))
        )
      )
    )

    expect(runId).toBe("run-1")
    expect(fixture.calls).toEqual(["plan", "run", "run"])
    expect(fixture.calls).not.toContain("approve")
    expect(fixture.planRequests).toEqual([input])
    const request = {
      _tag: "Plan",
      planId: "plan-1",
      digest: "digest",
      envelope: { capabilities: ["network"], flows: ["flow"], budget: { tokens: 123 }, host: "worker" },
      idempotencyKey: "trigger:occurrence"
    }
    expect(fixture.runRequests).toEqual([request, request])
  })

  // The store orders due triggers by id, so an aborting trigger takes every
  // trigger after it alphabetically down with it. Every store refuses an
  // unsatisfiable expression at registration, so the row a downgrade or a
  // hand-edit left behind is spelled out here as a listing that reads one back.
  it("keeps one failing trigger from silencing the triggers after it", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* store.register({ ...trigger("skip", "none"), id: "a-february-30" })
            yield* store.register({ ...trigger("skip", "none"), id: "b-hourly" })
            const legacy = TriggerStore.TriggerStore.of({
              ...store,
              list: () =>
                Effect.map(
                  store.list(),
                  (rows) =>
                    rows.map((row) =>
                      row.triggerId === "a-february-30"
                        ? {
                          ...row,
                          trigger: Result.map(row.trigger, (registration) => ({
                            ...registration,
                            cron: "0 0 30 2 *"
                          }))
                        }
                        : row
                    )
                )
            })
            yield* TestClock.setTime(hour + 30 * 60 * 1_000)
            const scheduler = yield* Scheduler.make().pipe(
              Effect.provideService(Scheduler.Runner, runner.service),
              Effect.provideService(TriggerStore.TriggerStore, legacy)
            )
            yield* scheduler.runOnce
            yield* TestClock.setTime(2 * hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
          })
        ),
        results
      )
    )

    expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
      `b-hourly:${new Date(2 * hour).toISOString()}`
    ])
  })

  it("keeps the supervisor polling after a tick fails", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    let dueCalls = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* store.register(trigger("skip", "none"))
          const failing = TriggerStore.TriggerStore.of({
            ...store,
            // The first tick dies the way an exhausted occurrence search used
            // to: a defect, which `Effect.catch` does not handle.
            list: () => dueCalls++ === 0 ? Effect.die(new Error("Unable to find cron date")) : store.list()
          })
          // A minute and a half before the hour, so the tick after the failing
          // one establishes the watermark and the tick after that crosses the
          // boundary and fires. A supervisor that stopped at the defect never
          // reaches either.
          yield* TestClock.setTime(hour - 90_000)
          yield* Effect.provide(
            TestClock.adjust("2 minutes").pipe(Effect.andThen(Effect.yieldNow)),
            Scheduler.layer({ pollInterval: "1 minute" }).pipe(
              Layer.provide(Layer.succeed(TriggerStore.TriggerStore)(failing)),
              Layer.provide(Layer.succeed(Scheduler.Runner)(runner.service))
            )
          )
        })
      ).pipe(
        Effect.provide(TestTriggers.layer),
        Effect.provide(TestClock.layer())
      )
    )

    expect(dueCalls).toBeGreaterThan(1)
    expect(runner.starts).toHaveLength(1)
    expect(results).toHaveLength(0)
  })

  // A trigger that has never fired owes nothing for the occurrence that
  // happened to pass before it existed: `catchUp: "none"` says exactly that.
  // The first poll establishes the watermark, and the trigger fires from the
  // next boundary.
  it("establishes a watermark without firing a stale occurrence on a new trigger's first poll", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* store.register(trigger("skip", "none"))
            yield* TestClock.setTime(hour + 30 * 60 * 1_000)
            const scheduler = yield* Scheduler.make().pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            expect(runner.starts).toHaveLength(0)

            yield* TestClock.setTime(2 * hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
          })
        ),
        results
      )
    )
    expect(runner.starts).toHaveLength(1)
    expect(runner.starts[0]?.idempotencyKey).toBe(
      `hourly:${new Date(2 * hour).toISOString()}`
    )
  })

  it("provides an inert scheduler and an inert runner without doing work", async () => {
    const noop = Scheduler.makeNoop()
    expect(await Effect.runPromise(noop.runOnce)).toBeUndefined()

    const runner = Scheduler.makeNoopRunner()
    expect(await Effect.runPromise(runner.start({ flowId: "flow", input: {}, idempotencyKey: "key" })))
      .toBe("key")
    expect(await Effect.runPromise(runner.isActive("key"))).toBe(false)
    expect(await Effect.runPromise(runner.cancel("key"))).toBeUndefined()

    const overridden = Scheduler.makeNoopRunner({ isActive: () => Effect.succeed(true) })
    expect(await Effect.runPromise(overridden.isActive("key"))).toBe(true)
    expect(await Effect.runPromise(overridden.start({ flowId: "flow", input: {}, idempotencyKey: "k2" })))
      .toBe("k2")

    const fromLayers = await Effect.runPromise(
      Effect.gen(function*() {
        const scheduler = yield* Scheduler.Scheduler
        const injected = yield* Scheduler.Runner
        yield* scheduler.runOnce
        return yield* injected.isActive("anything")
      }).pipe(
        Effect.provide(Scheduler.layerNoop),
        Effect.provide(Scheduler.layerNoopRunner())
      )
    )
    expect(fromLayers).toBe(false)
  })

  // Zero polls a CPU-tight loop and an infinite interval never detects
  // completion; `Duration.fromInput` accepts both.
  it("refuses a poll interval that is not finite and positive", async () => {
    const failures = await Effect.runPromise(
      Effect.all([
        Effect.flip(Effect.scoped(Scheduler.make({ runPollInterval: 0 }))),
        Effect.flip(Effect.scoped(Scheduler.make({ runPollInterval: -1 }))),
        Effect.flip(Effect.scoped(Scheduler.make({ runPollInterval: Number.POSITIVE_INFINITY }))),
        Effect.flip(Effect.scoped(Scheduler.make({ runPollInterval: "nonsense" as never })))
      ]).pipe(
        Effect.provide(TestTriggers.layer),
        Effect.provideService(Scheduler.Runner, Scheduler.makeNoopRunner())
      )
    )
    for (const failure of failures) {
      expect(failure).toMatchObject({ code: "invalid_options", path: "runPollInterval" })
    }
    expect(failures[0]?.message).toBe("runPollInterval must be a finite positive duration")
    expect(failures[3]?.message).toBe("runPollInterval must be a valid Effect duration")

    const pollInterval = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(Layer.build(Scheduler.layer({ pollInterval: 0 }))).pipe(
          Effect.provide(TestTriggers.layer),
          Effect.provide(Scheduler.layerNoopRunner())
        )
      )
    )
    expect(pollInterval).toMatchObject({ code: "invalid_options", path: "pollInterval" })
  })
})

interface ControlFixture {
  readonly layer: Layer.Layer<Control.Control>
  readonly calls: Array<string>
  readonly listRequests: Array<unknown>
  readonly planRequests: Array<Control.PlanInput>
  readonly runRequests: Array<Control.RunInput>
  readonly cancelRequests: Array<Control.RunMutationInput>
}

const controlFixture = (
  overrides: Partial<Parameters<typeof Control.make>[0]> = {}
): ControlFixture => {
  const { plan, run, cancel, ...otherOverrides } = overrides
  const calls: Array<string> = []
  const listRequests: Array<unknown> = []
  const planRequests: Array<Control.PlanInput> = []
  const runRequests: Array<Control.RunInput> = []
  const cancelRequests: Array<Control.RunMutationInput> = []
  return {
    calls,
    listRequests,
    planRequests,
    runRequests,
    cancelRequests,
    layer: Layer.succeed(
      Control.Control,
      Control.make({
        plan: (input) =>
          Effect.gen(function*() {
            calls.push("plan")
            planRequests.push(input)
            if (plan) return yield* plan(input)
            return {
              planId: "plan-1",
              flowId: input.flowId,
              digest: "digest",
              inputSummary: "input",
              envelope: { capabilities: ["network"], flows: ["flow"], budget: { tokens: 123 }, host: "worker" },
              deployClass: false,
              nodes: [],
              approval: {
                target: {
                  _tag: "Plan" as const,
                  planId: "plan-1",
                  digest: "digest",
                  envelope: { capabilities: ["network"], flows: ["flow"], budget: { tokens: 123 }, host: "worker" }
                },
                scope: "run" as const,
                idempotencyKey: "approval"
              }
            }
          }),
        run: (input) =>
          Effect.gen(function*() {
            calls.push("run")
            runRequests.push(input)
            if (run) return yield* run(input)
            return { _tag: "Accepted" as const, receiptId: "started", runId: "run-1" }
          }),
        approve: () => Effect.die("unused"),
        deny: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        signal: () => Effect.die("unused"),
        cancel: (input) =>
          Effect.gen(function*() {
            calls.push("cancel")
            cancelRequests.push(input)
            if (cancel) return yield* cancel(input)
            return { _tag: "Accepted" as const, receiptId: "cancelled" }
          }),
        resume: () => Effect.die("unused"),
        list: (request) =>
          Effect.sync(() => {
            calls.push("list")
            listRequests.push(request)
            return { _tag: "runs" as const, items: [] }
          }),
        watch: () => Stream.empty,
        ...otherOverrides
      })
    )
  }
}

const summary = (status: RunStatus) => ({
  runId: "run-1",
  flowId: "flow",
  status,
  startedAt: 0,
  updatedAt: 0
})

const withRunner = <A, E>(
  effect: Effect.Effect<A, E, Scheduler.Runner>,
  fixture: ControlFixture
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(Scheduler.layerControlRunner.pipe(Layer.provide(fixture.layer)))
    )
  )

describe("Scheduler.layerControlRunner", () => {
  // Liveness is the complement of the settled set. `accepted` is the status
  // every run holds between its claim and its first executed step, and reading
  // liveness as a list of live statuses is what dropped it: the monitor exited
  // on its first poll and recorded a run that had not started as completed.
  it("treats every unsettled status as live, accepted included", async () => {
    for (
      const [status, live] of [
        ["accepted", true],
        ["running", true],
        ["parked", true],
        ["waiting-approval", true],
        ["cancelled", false],
        ["completed", false],
        ["failed", false]
      ] as const
    ) {
      const fixture = controlFixture({
        list: () => Effect.succeed({ _tag: "runs" as const, items: [summary(status)] as never })
      })
      const actual = await withRunner(
        Effect.flatMap(Scheduler.Runner, (runner) => runner.isActive("run-1")),
        fixture
      )
      expect([status, actual]).toEqual([status, live])
    }
  })

  it("asks Control for the one run it cares about rather than listing every run", async () => {
    const fixture = controlFixture()
    await withRunner(Effect.flatMap(Scheduler.Runner, (runner) => runner.isActive("run-7")), fixture)
    expect(fixture.listRequests).toEqual([{ _tag: "runs", filters: { runId: "run-7" }, limit: 1 }])
  })

  it("reports an unknown run and a mismatched page as not active", async () => {
    const missing = controlFixture()
    expect(
      await withRunner(Effect.flatMap(Scheduler.Runner, (runner) => runner.isActive("run-1")), missing)
    ).toBe(false)

    const other = controlFixture({
      list: () => Effect.succeed({ _tag: "runs" as const, items: [{ ...summary("running"), runId: "run-2" }] as never })
    })
    expect(
      await withRunner(Effect.flatMap(Scheduler.Runner, (runner) => runner.isActive("run-1")), other)
    ).toBe(false)

    const flows = controlFixture({
      list: () => Effect.succeed({ _tag: "flows" as const, items: [] })
    })
    expect(
      await withRunner(Effect.flatMap(Scheduler.Runner, (runner) => runner.isActive("run-1")), flows)
    ).toBe(false)
  })

  it("cancels through Control under a derived idempotency key", async () => {
    const fixture = controlFixture()
    await withRunner(Effect.flatMap(Scheduler.Runner, (runner) => runner.cancel("run-1")), fixture)
    expect(fixture.calls).toEqual(["cancel"])
    expect(fixture.cancelRequests).toEqual([{ runId: "run-1", idempotencyKey: "trigger-cancel:run-1" }])
  })

  it("accepts cancellation acknowledgement receipts", async () => {
    const receipts: Array<Receipt> = [
      { _tag: "Accepted", receiptId: "cancelled" },
      { _tag: "AlreadyApplied", receiptId: "cancelled" },
      { _tag: "Terminal", runId: "run-1", status: "cancelled" }
    ]
    for (const receipt of receipts) {
      const fixture = controlFixture({ cancel: () => Effect.succeed(receipt) })
      expect(await withRunner(Effect.flatMap(Scheduler.Runner, (runner) => runner.cancel("run-1")), fixture))
        .toBeUndefined()
    }
  })

  it("rejects cancellation Conflict and Parked receipts as runner failures", async () => {
    const receipts: Array<Receipt> = [
      { _tag: "Conflict", message: "cancellation rejected" },
      { _tag: "Parked", receiptId: "parked", planId: "plan-1", status: "waiting-approval" }
    ]
    for (const receipt of receipts) {
      const fixture = controlFixture({ cancel: () => Effect.succeed(receipt) })
      const failure = await withRunner(
        Effect.flip(Effect.flatMap(Scheduler.Runner, (runner) => runner.cancel("run-1"))),
        fixture
      )
      expect(failure).toMatchObject({ code: "runner" })
      expect(failure.message).toContain(receipt._tag === "Conflict" ? receipt.message : "Parked")
    }
  })

  it("retains the predecessor and queues the replacement when Control refuses cancellation", async () => {
    const results: Array<TriggerStore.Result> = []
    const runtime = runnerFixture()
    const fixture = controlFixture({
      cancel: () => Effect.succeed({ _tag: "Conflict", message: "cancellation rejected" })
    })
    const held = await Effect.runPromise(
      provideTest(
        Effect.scoped(Effect.gen(function*() {
          const adapter = yield* Scheduler.Runner
          const store = yield* TriggerStore.TriggerStore
          yield* seed(store, trigger("supersede"), runtime)
          yield* TestClock.setTime(hour)
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(
              Scheduler.Runner,
              Scheduler.makeRunner({
                ...runtime.service,
                cancel: adapter.cancel
              })
            )
          )
          yield* scheduler.runOnce
          return yield* store.inspect("hourly")
        })).pipe(Effect.provide(Scheduler.layerControlRunner.pipe(Layer.provide(fixture.layer)))),
        results
      )
    )
    expect(fixture.cancelRequests).toEqual([{ runId: "seed", idempotencyKey: "trigger-cancel:seed" }])
    expect(runtime.starts).toEqual([])
    expect([...runtime.active]).toEqual(["seed"])
    expect(held).toMatchObject({ activeRunId: "seed", pendingAt: hour })
    expect(results.some((result) => result.outcome === "superseded")).toBe(false)
  })

  // Control failures are the runner's, not the store's. They used to arrive as
  // `store`, which is the one code a caller reads as "persistence is broken".
  it("reports every Control failure as a runner failure", async () => {
    const planning = controlFixture({ plan: () => Effect.die("boom") })
    const listing = controlFixture({ list: () => Effect.die("list down") })
    const cancelling = controlFixture({ cancel: () => Effect.die("cancel down") })

    const planFailure = await withRunner(
      Effect.flip(
        Effect.flatMap(Scheduler.Runner, (runner) => runner.start({ flowId: "flow", input: {}, idempotencyKey: "key" }))
      ),
      planning
    )
    expect(planFailure).toMatchObject({ code: "runner" })
    expect(planFailure.message).toBe("Control could not launch the scheduled run")

    const listFailure = await withRunner(
      Effect.flip(Effect.flatMap(Scheduler.Runner, (runner) => runner.isActive("run-1"))),
      listing
    )
    expect(listFailure).toMatchObject({ code: "runner" })
    expect(listFailure.message).toBe("Control could not inspect run run-1")

    const cancelFailure = await withRunner(
      Effect.flip(Effect.flatMap(Scheduler.Runner, (runner) => runner.cancel("run-1"))),
      cancelling
    )
    expect(cancelFailure).toMatchObject({ code: "runner" })
    expect(cancelFailure.message).toBe("Control could not cancel run run-1")
  })

  it("wraps a Control launch failure as a runner failure", async () => {
    const planFailed = controlFixture({
      plan: () => Effect.fail(new Unavailable({ feature: "plan", ticket: "control" }))
    })
    const planFailure = await withRunner(
      Effect.flip(
        Effect.flatMap(Scheduler.Runner, (runner) => runner.start({ flowId: "flow", input: {}, idempotencyKey: "key" }))
      ),
      planFailed
    )
    expect(planFailure).toMatchObject({ code: "runner" })
    expect(planFailure.message).toBe("Control could not launch the scheduled run")

    const runFailed = controlFixture({
      run: () => Effect.fail(new Unavailable({ feature: "run", ticket: "control" }))
    })
    const runFailure = await withRunner(
      Effect.flip(
        Effect.flatMap(Scheduler.Runner, (runner) => runner.start({ flowId: "flow", input: {}, idempotencyKey: "key" }))
      ),
      runFailed
    )
    expect(runFailure).toMatchObject({ code: "runner" })
    expect(runFailure.message).toBe("Control could not launch the scheduled run")
  })

  it("reads a run id out of every receipt that carries one", async () => {
    for (
      const [receipt, expected] of [
        [{ _tag: "Accepted", receiptId: "r", runId: "run-1" }, "run-1"],
        [{ _tag: "AlreadyApplied", receiptId: "r", runId: "run-2" }, "run-2"],
        [{ _tag: "Terminal", receiptId: "r", runId: "run-3", status: "completed" }, "run-3"]
      ] as const
    ) {
      const fixture = controlFixture({ run: () => Effect.succeed(receipt as never) })
      const runId = await withRunner(
        Effect.flatMap(
          Scheduler.Runner,
          (runner) => runner.start({ flowId: "flow", input: {}, idempotencyKey: "key" })
        ),
        fixture
      )
      expect(runId).toBe(expected)
    }
  })

  it("refuses a receipt with no run id and a rejected run", async () => {
    const anonymous = controlFixture({
      run: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "r" })
    })
    const anonymousFailure = await withRunner(
      Effect.flip(
        Effect.flatMap(Scheduler.Runner, (runner) => runner.start({ flowId: "flow", input: {}, idempotencyKey: "key" }))
      ),
      anonymous
    )
    expect(anonymousFailure).toMatchObject({ code: "runner" })
    expect(anonymousFailure.message).toBe("Control Accepted receipt did not include a run id")

    const conflicting = controlFixture({
      run: () => Effect.succeed({ _tag: "Conflict" as const, receiptId: "r", reason: "digest", message: "stale plan" })
    })
    const conflictFailure = await withRunner(
      Effect.flip(
        Effect.flatMap(Scheduler.Runner, (runner) => runner.start({ flowId: "flow", input: {}, idempotencyKey: "key" }))
      ),
      conflicting
    )
    expect(conflictFailure.message).toBe("Control rejected the scheduled run: stale plan")
  })

  // A parked plan used to be re-offered once a second for the life of the
  // scope while the launch reservation behind it quietly expired. The retry is
  // bounded and this adapter never approves the plan itself.
  it("gives up on a plan nobody approves without ever approving it", async () => {
    let attempts = 0
    const fixture = controlFixture({
      run: () =>
        Effect.sync(() => {
          attempts++
          return {
            _tag: "Parked" as const,
            receiptId: "parked",
            planId: "plan-1",
            status: "waiting-approval" as const
          }
        }),
      approve: () => Effect.die("the scheduler must never approve a plan")
    })
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const runner = yield* Scheduler.Runner
          const fiber = yield* Effect.forkScoped(
            Effect.flip(runner.start({ flowId: "flow", input: {}, idempotencyKey: "key" }))
          )
          yield* TestClock.adjust("10 minutes")
          return yield* Fiber.join(fiber)
        })
      ).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(Scheduler.layerControlRunner.pipe(Layer.provide(fixture.layer)))
      )
    )
    expect(attempts).toBe(Scheduler.parkedAttempts)
    expect(fixture.planRequests).toEqual([{ flowId: "flow", input: {}, idempotencyKey: "key" }])
    expect(fixture.runRequests).toEqual(Array.from({ length: Scheduler.parkedAttempts }, () => ({
      _tag: "Plan",
      planId: "plan-1",
      digest: "digest",
      envelope: { capabilities: ["network"], flows: ["flow"], budget: { tokens: 123 }, host: "worker" },
      idempotencyKey: "key"
    })))
    expect(failure).toMatchObject({ code: "runner" })
    expect(failure.message).toContain("still parked awaiting approval")
    expect(fixture.calls).not.toContain("approve")
  })
})

describe("Scheduler heartbeat", () => {
  const tick = (options: Scheduler.Options, store: Layer.Layer<TriggerStore.TriggerStore>) =>
    Effect.gen(function*() {
      const scheduler = yield* Scheduler.make(options)
      yield* scheduler.runOnce
    }).pipe(
      Effect.scoped,
      Effect.provideService(Scheduler.Runner, runnerFixture().service),
      Effect.provide(store)
    )

  it("records nothing before its first poll and its host at every poll after", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const before = yield* store.lastHeartbeat()
        yield* tick({ host: "box-1" }, Layer.succeed(TriggerStore.TriggerStore)(store))
        const first = yield* store.lastHeartbeat()
        yield* TestClock.adjust(hour)
        yield* tick({ host: "box-1" }, Layer.succeed(TriggerStore.TriggerStore)(store))
        const second = yield* store.lastHeartbeat()
        yield* TestClock.adjust(hour)
        yield* tick({}, Layer.succeed(TriggerStore.TriggerStore)(store))
        const unnamed = yield* store.lastHeartbeat()
        return { before, first, second, unnamed }
      }).pipe(Effect.provide(TestTriggers.layer), Effect.provide(TestClock.layer()))
    )
    expect(result.before).toMatchObject({ _tag: "None" })
    expect(result.first).toMatchObject({ _tag: "Some", value: { host: "box-1", tickedAt: 0 } })
    expect(result.second).toMatchObject({ _tag: "Some", value: { host: "box-1", tickedAt: hour } })
    expect(result.unnamed).toMatchObject({ _tag: "Some", value: { host: Scheduler.defaultHost, tickedAt: 2 * hour } })
  })

  it("keeps dispatching when the store cannot record the heartbeat", async () => {
    let listed = 0
    const store = TriggerStore.makeNoop({
      list: () =>
        Effect.sync(() => {
          listed++
          return []
        })
    })
    await Effect.runPromise(
      tick({ host: "box-1" }, Layer.succeed(TriggerStore.TriggerStore)(store)).pipe(
        Effect.provide(TestClock.layer())
      )
    )
    expect(listed).toBe(1)
  })
})

// One tick used to walk its triggers in series and wait on every launch, so a
// runtime that never answered for one trigger held every trigger after it, and
// the tick itself, for the life of the scope. Dispatch is now bounded on both
// axes: independent triggers run concurrently and every runner call carries a
// deadline whose failure keeps the durable state a retry needs.
describe("Scheduler tick dispatch", () => {
  const named = (id: string, overlap: Trigger["overlap"] = "skip"): Trigger => ({ ...trigger(overlap), id })

  const settle = Effect.gen(function*() {
    for (let round = 0; round < 8; round++) yield* Effect.yieldNow
  })

  const provideStore = <A, E>(effect: Effect.Effect<A, E, TriggerStore.TriggerStore>) =>
    effect.pipe(Effect.provide(TestTriggers.layer), Effect.provide(TestClock.layer()))

  // "a" waits two minutes for its runner; "z" is alphabetically behind it and
  // used to wait the same two minutes for a launch that had nothing to do with
  // it.
  const slowFirst = (concurrency: number | undefined) =>
    Effect.runPromise(
      provideStore(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            const fixture = runnerFixture()
            yield* seed(store, named("a"), fixture, "completed")
            yield* seed(store, named("z"), fixture, "completed")
            const runner = Scheduler.makeRunner({
              ...fixture.service,
              start: (input) =>
                input.idempotencyKey.startsWith("a:")
                  ? Effect.sleep("2 minutes").pipe(Effect.andThen(fixture.service.start(input)))
                  : fixture.service.start(input)
            })
            const scheduler = yield* Scheduler.make({ concurrency }).pipe(
              Effect.provideService(Scheduler.Runner, runner)
            )
            yield* TestClock.setTime(hour)
            const tick = yield* Effect.forkScoped(scheduler.runOnce)
            yield* settle
            const beforeAdjust = fixture.starts.map((start) => start.idempotencyKey)
            yield* TestClock.adjust("2 minutes")
            yield* Fiber.join(tick)
            return { beforeAdjust, after: fixture.starts.map((start) => start.idempotencyKey) }
          })
        )
      )
    )

  it("launches a later trigger while an earlier one is still waiting on its runner", async () => {
    const { after, beforeAdjust } = await slowFirst(undefined)
    expect(beforeAdjust).toEqual([`z:${new Date(hour).toISOString()}`])
    expect(after).toEqual([`z:${new Date(hour).toISOString()}`, `a:${new Date(hour).toISOString()}`])
  })

  it("serializes triggers when concurrency is one", async () => {
    const { after, beforeAdjust } = await slowFirst(1)
    expect(beforeAdjust).toEqual([])
    expect(after).toEqual([`a:${new Date(hour).toISOString()}`, `z:${new Date(hour).toISOString()}`])
  })

  it("refuses a concurrency that is not a positive integer and a deadline that is not finite and positive", async () => {
    const failures = await Effect.runPromise(
      Effect.all([
        Effect.flip(Effect.scoped(Scheduler.make({ concurrency: 0 }))),
        Effect.flip(Effect.scoped(Scheduler.make({ concurrency: 1.5 }))),
        Effect.flip(Effect.scoped(Scheduler.make({ startTimeout: 0 }))),
        Effect.flip(Effect.scoped(Scheduler.make({ inspectTimeout: Number.POSITIVE_INFINITY }))),
        Effect.flip(Effect.scoped(Scheduler.make({ cancelTimeout: -1 })))
      ]).pipe(
        Effect.provide(TestTriggers.layer),
        Effect.provideService(Scheduler.Runner, Scheduler.makeNoopRunner())
      )
    )
    expect(failures.map((failure) => [failure.code, failure.path])).toEqual([
      ["invalid_options", "concurrency"],
      ["invalid_options", "concurrency"],
      ["invalid_options", "startTimeout"],
      ["invalid_options", "inspectTimeout"],
      ["invalid_options", "cancelTimeout"]
    ])
    expect(failures[0]?.message).toBe("concurrency must be a positive integer")
  })

  // The runtime may or may not hold the run after a start that never answered,
  // so the occurrence is neither failed nor forgotten: it stays pending under
  // the same idempotency key, and the runtime's durable deduplication decides.
  it("abandons a start that never answers and retries the occurrence under the same key", async () => {
    const results: Array<TriggerStore.Result> = []
    const fixture = runnerFixture()
    let hung = false
    const outcome = await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger(), fixture, "completed")
            const runner = Scheduler.makeRunner({
              ...fixture.service,
              start: (input) =>
                Effect.suspend(() => {
                  if (hung) return fixture.service.start(input)
                  hung = true
                  fixture.starts.push(input)
                  return Effect.never
                })
            })
            const scheduler = yield* Scheduler.make({ startTimeout: "1 minute" }).pipe(
              Effect.provideService(Scheduler.Runner, runner)
            )
            yield* TestClock.setTime(hour)
            const tick = yield* Effect.forkScoped(scheduler.runOnce)
            yield* settle
            yield* TestClock.adjust("1 minute")
            yield* settle
            const finished = tick.pollUnsafe() !== undefined
            const active = yield* store.activeRun("hourly")
            const held = yield* store.inspect("hourly")
            yield* scheduler.runOnce
            return {
              finished,
              activeAfterTimeout: active,
              pendingAfterTimeout: held.pendingAt,
              activeAfterRetry: yield* store.activeRun("hourly"),
              history: (yield* store.history({ triggerId: "hourly" })).items
                .filter((item) => item.occurrence === hour)
                .map((item) => [item.outcome, item.runId])
            }
          })
        ),
        results
      )
    )
    expect(outcome.finished).toBe(true)
    expect(outcome.activeAfterTimeout._tag).toBe("None")
    expect(outcome.pendingAfterTimeout).toBe(hour)
    expect(results.map((result) => result.outcome)).not.toContain("failed")
    expect(fixture.starts.map((start) => start.idempotencyKey)).toEqual([
      `hourly:${new Date(hour).toISOString()}`,
      `hourly:${new Date(hour).toISOString()}`
    ])
    expect(outcome.activeAfterRetry).toEqual(Option.some("run-2"))
    expect(outcome.history).toEqual([["launched", "run-2"]])
  })

  // An inspection that never answers is an inspection failure like any other:
  // the monitor retries, then detaches and leaves the durable owner in place.
  it("treats an inspection that never answers as a failed inspection", async () => {
    const fixture = runnerFixture()
    let inspections = 0
    const active = await Effect.runPromise(
      provideStore(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger(), fixture, "completed")
            const runner = Scheduler.makeRunner({
              ...fixture.service,
              isActive: () =>
                Effect.suspend(() => {
                  inspections++
                  return Effect.never
                })
            })
            const scheduler = yield* Scheduler.make({
              runPollInterval: "1 second",
              inspectTimeout: "10 seconds"
            }).pipe(Effect.provideService(Scheduler.Runner, runner))
            yield* TestClock.setTime(hour)
            yield* scheduler.runOnce
            yield* settle
            yield* TestClock.adjust("1 minute")
            yield* settle
            return yield* store.activeRun("hourly")
          })
        )
      )
    )
    expect(inspections).toBe(4)
    expect(active).toEqual(Option.some("run-1"))
  })

  // The claim already replaced the prior run with the replacement's
  // reservation. A cancellation that never answers fails the supersede the
  // same way a refused one does: the prior run stays active and the
  // replacement is queued, instead of the tick waiting forever.
  it("restores the prior run when its cancellation never answers", async () => {
    const fixture = runnerFixture()
    const outcome = await Effect.runPromise(
      provideStore(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger("supersede"), fixture)
            const runner = Scheduler.makeRunner({ ...fixture.service, cancel: () => Effect.never })
            const scheduler = yield* Scheduler.make({ cancelTimeout: "10 seconds" }).pipe(
              Effect.provideService(Scheduler.Runner, runner)
            )
            yield* TestClock.setTime(hour)
            const tick = yield* Effect.forkScoped(scheduler.runOnce)
            yield* settle
            yield* TestClock.adjust("10 seconds")
            yield* settle
            return {
              finished: tick.pollUnsafe() !== undefined,
              active: yield* store.activeRun("hourly"),
              pending: (yield* store.inspect("hourly")).pendingAt
            }
          })
        )
      )
    )
    expect(outcome.finished).toBe(true)
    expect(outcome.active).toEqual(Option.some("seed"))
    expect(outcome.pending).toBe(hour)
    expect(fixture.starts).toHaveLength(0)
  })

  // The occurrence was computed from the hourly cron the tick listed. By the
  // time it claims, the trigger fires at noon, so the 01:00 boundary is owed
  // by nobody; retrying that claim under the new revision launched it anyway.
  it("recomputes due occurrences from the refreshed declaration on a revision mismatch", async () => {
    const fixture = runnerFixture()
    const edited: Trigger = { ...trigger("skip", "one"), id: "edited" }
    const claims: Array<number> = []
    await Effect.runPromise(
      provideStore(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, edited, fixture, "completed")
            let reregistered = false
            const racing = TriggerStore.TriggerStore.of({
              ...store,
              claimFire: (fire) =>
                Effect.gen(function*() {
                  claims.push(fire.expectedRevision)
                  if (!reregistered) {
                    reregistered = true
                    yield* store.register({ ...edited, cron: "0 12 * * *" })
                  }
                  return yield* store.claimFire(fire)
                })
            })
            const scheduler = yield* Scheduler.make().pipe(
              Effect.provideService(TriggerStore.TriggerStore, racing),
              Effect.provideService(Scheduler.Runner, fixture.service)
            )
            yield* TestClock.setTime(hour)
            yield* scheduler.runOnce
            yield* TestClock.setTime(12 * hour)
            yield* scheduler.runOnce
          })
        )
      )
    )
    expect(claims).toEqual([1, 2])
    expect(fixture.starts.map((start) => start.idempotencyKey)).toEqual([`edited:${new Date(12 * hour).toISOString()}`])
  })
})

// What a tick reads before it decides anything: one listing, and the store
// again only for the rows that say there is something to ask about.
describe("Scheduler tick reads", () => {
  const declaration = (id: string): TriggerStore.Registered => ({
    ...trigger("skip", "one"),
    id,
    revision: 1,
    lastFiredAt: 0
  })

  // `activeRun` and `claimPending` are left unavailable: a row listed holding
  // neither a run nor a buffered occurrence answers both of those reads by
  // itself, and each one the scheduler asked for cost a write transaction.
  const listing = (
    rows: ReadonlyArray<TriggerStore.Listed>,
    stored: TriggerStore.Registered
  ): TriggerStore.Service =>
    TriggerStore.makeNoop({
      heartbeat: () => Effect.void,
      list: () => Effect.succeed(rows),
      get: () => Effect.succeed(Option.some(stored)),
      activeOccurrence: () => Effect.succeed(Option.none()),
      claimFire: (fire) =>
        Effect.succeed({
          claimed: true as const,
          action: "fire" as const,
          reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence)
        }),
      recordResult: () => Effect.void,
      clearActive: () => Effect.void
    })

  const tick = (store: TriggerStore.Service, runner: RunnerFixture) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )

  it("dispatches a listed idle trigger without asking for its active run or buffered occurrence", async () => {
    const runner = runnerFixture()
    const idle = declaration("hourly")
    await tick(listing([TriggerStore.listed(idle)], idle), runner)
    expect(runner.starts.map((start) => start.idempotencyKey)).toEqual([`hourly:${new Date(hour).toISOString()}`])
  })

  it("keeps scheduling the triggers listed beside a row the store could not decode", async () => {
    const runner = runnerFixture()
    const healthy = declaration("b-hourly")
    const corrupt: TriggerStore.Listed = {
      triggerId: "a-corrupt",
      trigger: Result.fail(
        new TriggerError({ code: "store", message: "could not decode trigger row a-corrupt" })
      )
    }
    await tick(listing([corrupt, TriggerStore.listed(healthy)], healthy), runner)
    expect(runner.starts.map((start) => start.idempotencyKey)).toEqual([`b-hourly:${new Date(hour).toISOString()}`])
  })

  // The testing guide's no-op example. A tick polls `list`, so a store that
  // overrode `listEnabled` instead failed the tick with `list is unavailable`.
  it("takes its triggers from list, so overriding only list supplies a tick", async () => {
    const runOnce = (overrides: Partial<TriggerStore.Service>) =>
      Effect.runPromise(
        Effect.exit(
          Effect.scoped(
            Effect.gen(function*() {
              const scheduler = yield* Scheduler.make().pipe(
                Effect.provideService(Scheduler.Runner, runnerFixture().service)
              )
              yield* scheduler.runOnce
            })
          ).pipe(
            Effect.provide(TriggerStore.layerNoop(overrides)),
            Effect.provide(TestClock.layer())
          )
        )
      )
    expect((await runOnce({ list: () => Effect.succeed([]) }))._tag).toBe("Success")
    const enabledOnly = await runOnce({ listEnabled: () => Effect.succeed([]) })
    expect(enabledOnly._tag).toBe("Failure")
  })
})
