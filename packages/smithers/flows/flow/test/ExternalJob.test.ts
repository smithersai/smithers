import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Action, ExternalJob, Flow, FlowRuntime, Interpreter, Sleep } from "@smthrs/flow"
import type { Node } from "@smthrs/plan"
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { ExecutionMiddleware } from "../src/internal/ExecutionMiddleware.vibe"
import { effectOnTestClock as effect } from "./Harness.ts"
import { layerWired, makeInstance, makeMemoryState, type MemoryState } from "./MemoryFlowRuntime.ts"

const Job = ExternalJob.make("test/external-job", {
  payload: { value: Schema.String },
  handle: Schema.String,
  success: Schema.String,
  error: Schema.String,
  probe: { every: "100 millis", max: "200 millis" },
  timeout: "1 second",
  restarts: 1
})

const turns = Effect.gen(function*() {
  for (let index = 0; index < 100; index++) yield* Effect.yieldNow
})

/** Observe ordinary registered continuation flows without exposing them in the public API. */
type StoredFlow = Flow.Flow<string, Schema.Struct<{}>, typeof Schema.Unknown, typeof Schema.Unknown, never>

const harness = (
  status: Array<ExternalJob.Status>,
  again = false,
  holdStatus = false,
  startFails = false,
  probeDelay = 0,
  options: {
    /** The provider call that never answers once called. */
    readonly hold?: "start" | "collect"
    /** Whether the adapter implements `abandon`. */
    readonly abandon?: boolean
    /** Whether the provider refuses every `cancel` and `abandon`. */
    readonly stopFails?: boolean
    /** The durable record a restarted host reads. */
    readonly state?: MemoryState
  } = {}
) => {
  const calls: Array<string> = []
  const declarations = new Map<string, StoredFlow>()
  const implementations = Job.toLayer({
    start: (_payload, key) =>
      Effect.suspend(() => {
        calls.push(`start:${key}`)
        if (options.hold === "start") return Effect.never
        return startFails ? Effect.fail("start failed") : Effect.succeed(key)
      }),
    status: (_handle, key) =>
      Effect.suspend(() => {
        calls.push(`status:${key}`)
        return holdStatus
          ? Effect.never
          : Effect.sleep(probeDelay).pipe(
            Effect.andThen(Effect.succeed(status.shift() ?? { _tag: "Running" as const }))
          )
      }),
    collect: (_handle, key) =>
      Effect.suspend(() => {
        calls.push(`collect:${key}`)
        if (options.hold === "collect") return Effect.never
        if (again) {
          again = false
          return Effect.fail(new ExternalJob.Again({ message: "retry" }))
        }
        return Effect.succeed("done")
      }),
    cancel: (_handle, key) =>
      Effect.suspend(() => {
        calls.push(`cancel:${key}`)
        return options.stopFails === true ? Effect.fail("cancel refused") : Effect.void
      }),
    ...(options.abandon === true
      ? {
        abandon: (_payload: { readonly value: string }, key: string) =>
          Effect.suspend(() => {
            calls.push(`abandon:${key}`)
            return options.stopFails === true ? Effect.fail("abandon refused") : Effect.void
          })
      }
      : {})
  })
  const registered = Layer.unwrap(
    Effect.map(
      FlowRuntime.FlowRuntime,
      (runtime) =>
        implementations.pipe(Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, {
          ...runtime,
          register: (flow, handler) => {
            declarations.set(flow._tag, flow as unknown as StoredFlow)
            return runtime.register(flow, handler)
          }
        })))
    )
  )
  const layer = layerWired(registered, options.state)
  const round = (declaration: Flow.AnyWithProps, payload: unknown, id: string) =>
    Effect.gen(function*() {
      const flow = declaration as unknown as StoredFlow
      yield* flow.execute(payload as never, { executionId: id, discard: true })
      yield* turns
      const result = yield* flow.poll(id)
      if (Option.isNone(result)) return yield* Effect.die("round did not settle")
      return result.value
    })
  const next = (result: Flow.Result<unknown, unknown>, id: string) =>
    Effect.gen(function*() {
      if (result._tag !== "Handoff") return yield* Effect.die(`expected handoff, got ${result._tag}`)
      const flow = declarations.get(result.flow)
      if (!flow) return yield* Effect.die(`missing ${result.flow}`)
      return yield* round(flow, result.payload, id)
    })
  return { calls, declarations, layer, round, next, implementations }
}

/** The job execution as its stored continuations are: driven by id, with no requirements left to type. */
const stored = Job as unknown as StoredFlow

/**
 * What a host that stopped leaves behind. This fixture records an interrupted
 * dispatch as an outcome; a durable engine keeps no settlement for one, so the
 * next host runs it again. Dropping those records gives the next host here
 * the same journal.
 */
const forgetInterrupted = (state: MemoryState) => {
  for (const [id, exit] of state.actions) {
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) state.actions.delete(id)
  }
}

/** Asserts a round completed with `ExternalJobTimedOut`. */
const expectTimedOut = (result: Flow.Result<unknown, unknown>) => {
  expect(result._tag).toBe("Complete")
  if (result._tag === "Complete" && Exit.isFailure(result.exit)) {
    expect(result.exit.cause.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ error: expect.objectContaining({ _tag: "@smthrs/flow/ExternalJobTimedOut" }) })
    ]))
  } else expect.unreachable("the round did not fail")
}

describe("ExternalJob", () => {
  it("preserves provider and lifecycle errors through generic flow composition", () => {
    type LifecycleError = ExternalJob.ExternalJobLost | ExternalJob.ExternalJobTimedOut | Sleep.SleepRequestInvalid
    expectTypeOf<typeof Job.errorSchema.Type>().toEqualTypeOf<string | LifecycleError>()
    const noProviderError = ExternalJob.make("test/external-job-no-provider-error", {
      payload: Schema.Struct({ count: Schema.Number }),
      handle: Schema.String,
      success: Schema.Number,
      probe: { every: "100 millis", max: "200 millis" },
      timeout: "1 second"
    })
    expectTypeOf<typeof noProviderError.errorSchema.Type>().toEqualTypeOf<LifecycleError>()
    expectTypeOf<typeof noProviderError.payloadSchema.Type>().toEqualTypeOf<{ readonly count: number }>()
    expectTypeOf<typeof noProviderError.successSchema.Type>().toEqualTypeOf<number>()
    expect(Schema.decodeUnknownSync(Job.errorSchema)("provider failed")).toBe("provider failed")
    const lost = new ExternalJob.ExternalJobLost({ key: "test#g1", message: "lost" })
    expect(Schema.decodeUnknownSync(noProviderError.errorSchema)(lost)).toEqual(lost)
  })

  it("calls as an ordinary child boundary so parent composition owns a separate job execution", () => {
    const child: Node.Node<string, typeof Job.errorSchema.Type> = Job.call({ value: "x" })
    expect(child.ast).toMatchObject({ _tag: "FlowCall", mode: "boundary" })
    const parent = Flow.make("test/external-parent", {
      payload: {},
      success: Schema.String,
      error: Job.errorSchema,
      body: () => Job.call({ value: "x" })
    })
    expect(parent.body({}).ast).toMatchObject({ _tag: "FlowCall", mode: "boundary" })
  })

  it("validates bounded exponential probing", () => {
    expect(() =>
      ExternalJob.make("invalid", {
        payload: {},
        handle: Schema.String,
        success: Schema.Void,
        probe: { every: "0 millis", max: "1 second" },
        timeout: "1 second"
      })
    ).toThrow(RangeError)
  })

  it.each([
    { probe: { every: NaN, max: 100 }, timeout: 100 },
    { probe: { every: 100, max: 99 }, timeout: 100 },
    { probe: { every: 1, max: 100 }, timeout: Infinity },
    { probe: { every: 1, max: 100 }, timeout: -1 },
    { probe: { every: 1, max: 100 }, timeout: 100, restarts: -1 },
    { probe: { every: 1, max: 100 }, timeout: 100, restarts: 0.5 }
  ])("rejects invalid schedules %j", (schedule) => {
    expect(() => ExternalJob.make("invalid", { payload: {}, handle: Schema.String, success: Schema.Void, ...schedule }))
      .toThrow(RangeError)
  })

  effect("its stop, run on its own as a cancellation run, asks the provider to cancel the generation once", () => {
    const h = harness([], false, true)
    return Effect.gen(function*() {
      const initial = yield* h.round(Job, { value: "stopped" }, "stopped-root")
      if (initial._tag !== "Handoff") return yield* Effect.die("missing handoff")
      // The observation's payload, as an engine that cancelled it admits the stop with.
      const stop = h.declarations.get("test/external-job/stop")!
      const result = yield* h.round(stop as unknown as Flow.AnyWithProps, initial.payload, "cancel:stopped-root#g1")
      expect(result._tag).toBe("Complete")
      expect(h.calls.filter((call) => call.startsWith("cancel:"))).toEqual(["cancel:stopped-root#g1"])
    }).pipe(Effect.provide(h.layer))
  })

  effect("separate hosts retain their own cancellation adapter for the same declaration", () => {
    const first = harness([], false, true)
    const second = harness([], false, true)
    const cancelOnHost = (h: ReturnType<typeof harness>, id: string) =>
      Effect.gen(function*() {
        const initial = yield* h.round(Job, { value: "same" }, id)
        if (initial._tag !== "Handoff") return yield* Effect.die("missing handoff")
        const flow = h.declarations.get(initial.flow)!
        yield* flow.execute(initial.payload as never, { executionId: `${id}-observe`, discard: true })
        yield* turns
        yield* flow.interrupt(`${id}-observe`)
        yield* turns
      }).pipe(Effect.provide(h.layer))
    return Effect.gen(function*() {
      yield* Effect.all([cancelOnHost(first, "host-a"), cancelOnHost(second, "host-b")], { concurrency: "unbounded" })
      expect(first.calls.filter((call) => call.startsWith("cancel:"))).toEqual(["cancel:host-a#g1"])
      expect(second.calls.filter((call) => call.startsWith("cancel:"))).toEqual(["cancel:host-b#g1"])
    })
  })

  it("accepts schema payload and defaults to no replacement and no provider errors", () => {
    const declared = ExternalJob.make("schema-input", {
      payload: Schema.Struct({ value: Schema.String }),
      handle: Schema.String,
      success: Schema.String,
      probe: { every: 1, max: 1 },
      timeout: 1
    })
    expect(Schema.is(declared.payloadSchema)({ value: "same" })).toBe(true)
    expect(() =>
      ExternalJob.make("invalid-duration", {
        payload: {},
        handle: Schema.String,
        success: Schema.Void,
        probe: { every: "invalid" as Duration.Input, max: 1 },
        timeout: 1
      })
    ).toThrow(RangeError)
  })

  effect("missing adapter binding fails visibly before external work", () => {
    return Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      const exit = yield* runtime.execute(Job, { payload: { value: "x" }, executionId: "unwired" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toEqual(expect.arrayContaining([
          expect.objectContaining({
            defect: expect.objectContaining({ _tag: "@smthrs/flow/InterpreterError", code: "unresolved_action" })
          })
        ]))
      }
    }).pipe(Effect.provide(layerWired(Interpreter.layer(Job))))
  })

  effect("disposing the adapter removes cancellation from retained table views", () => {
    const h = harness([])
    return Effect.gen(function*() {
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(h.implementations, scope)
      const table = yield* Action.Implementations
      const view = Action.Implementations.of({ add: table.add, get: table.get })
      const middleware = Context.get(Job.annotations, ExecutionMiddleware)!
      // The internal wrapper erases its requirements; this check supplies its
      // actual table and per-execution state without dispatching remote work.
      const check = middleware.wrap({ value: "x" }, Effect.succeed("bound")) as Effect.Effect<
        unknown,
        unknown,
        Action.Implementations | FlowRuntime.FlowInstance
      >
      const execute = check.pipe(
        Effect.provideService(Action.Implementations, view),
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Job, "disposed-adapter"))
      )
      expect(yield* execute).toBe("bound")
      yield* Scope.close(scope, Exit.void)
      const exit = yield* Effect.exit(execute)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toEqual(expect.arrayContaining([
          expect.objectContaining({
            defect: expect.objectContaining({ _tag: "@smthrs/flow/InterpreterError", code: "unresolved_action" })
          })
        ]))
      }
      expect(h.calls).toEqual([])
    }).pipe(Effect.provide(layerWired(Interpreter.layer(Job))))
  })

  effect("a failed initial Start does not Cancel a nonexistent handle", () => {
    const h = harness([], false, false, true)
    return Effect.gen(function*() {
      const result = yield* h.round(Job, { value: "x" }, "failed-start")
      expect(result._tag).toBe("Complete")
      if (result._tag === "Complete") expect(Exit.isFailure(result.exit)).toBe(true)
      expect(h.calls).toEqual(["start:failed-start#g1"])
    }).pipe(Effect.provide(h.layer))
  })

  effect("host shutdown during a live probe preserves the external worker", () => {
    const h = harness([], false, true)
    const running = Effect.gen(function*() {
      const initial = yield* h.round(Job, { value: "x" }, "host-release")
      if (initial._tag !== "Handoff") return yield* Effect.die("missing handoff")
      yield* h.declarations.get(initial.flow)!.execute(initial.payload as never, {
        executionId: "host-release-observe",
        discard: true
      })
      yield* turns
    }).pipe(Effect.provide(h.layer))
    return Effect.gen(function*() {
      yield* running
      expect(h.calls).toEqual(["start:host-release#g1", "status:host-release#g1"])
    })
  })

  effect("a probe that never answers still times out and cancels", () => {
    const h = harness([], false, true)
    return Effect.gen(function*() {
      const initial = yield* h.round(Job, { value: "x" }, "hung-probe")
      if (initial._tag !== "Handoff") return yield* Effect.die("missing handoff")
      const flow = h.declarations.get(initial.flow)!
      yield* flow.execute(initial.payload as never, { executionId: "hung-observe", discard: true })
      yield* turns
      yield* TestClock.adjust("1 second")
      yield* turns
      const result = yield* flow.poll("hung-observe")
      expect(Option.isSome(result)).toBe(true)
      expect(h.calls).toEqual(["start:hung-probe#g1", "status:hung-probe#g1", "cancel:hung-probe#g1"])
    }).pipe(Effect.provide(h.layer))
  })

  effect("a slow probe crossing the original deadline cancels instead of collecting", () => {
    const h = harness([{ _tag: "Exited", exitCode: 0 }], false, false, false, 1500)
    return Effect.gen(function*() {
      const initial = yield* h.round(Job, { value: "x" }, "slow-probe")
      if (initial._tag !== "Handoff") return yield* Effect.die("missing handoff")
      const flow = h.declarations.get(initial.flow)!
      yield* flow.execute(initial.payload as never, { executionId: "slow-observe", discard: true })
      yield* turns
      yield* TestClock.adjust("1500 millis")
      yield* turns
      const result = Option.getOrThrow(yield* flow.poll("slow-observe"))
      expect(result._tag).toBe("Complete")
      expect(h.calls).toEqual(["start:slow-probe#g1", "status:slow-probe#g1", "cancel:slow-probe#g1"])
    }).pipe(Effect.provide(h.layer))
  })

  effect("a replacement delayed past the initial deadline never starts", () => {
    const h = harness([{ _tag: "Lost" }])
    return Effect.gen(function*() {
      const initial = yield* h.round(Job, { value: "x" }, "late-replacement")
      yield* h.next(initial, "late-observe")
      yield* TestClock.adjust("1 second")
      yield* turns
      const wake = Option.getOrThrow(yield* h.declarations.get("test/external-job/observe")!.poll("late-observe"))
      const result = yield* h.next(wake, "late-launch")
      expect(result._tag).toBe("Complete")
      if (result._tag === "Complete") expect(Exit.isFailure(result.exit)).toBe(true)
      expect(h.calls.filter((call) => call.startsWith("start:"))).toEqual(["start:late-replacement#g1"])
    }).pipe(Effect.provide(h.layer))
  })

  effect("two competing adapter layers on one host fail before starting work", () => {
    const first = harness([])
    const second = harness([])
    return Effect.gen(function*() {
      const exit = yield* Effect.void.pipe(
        Effect.provide(layerWired(Layer.mergeAll(first.implementations, second.implementations))),
        Effect.exit
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(first.calls).toEqual([])
      expect(second.calls).toEqual([])
    })
  })

  effect("probe delays double and stop growing at probe.max", () => {
    const h = harness([{ _tag: "Running" }, { _tag: "Running" }, { _tag: "Running" }, { _tag: "Exited", exitCode: 0 }])
    return Effect.gen(function*() {
      const initial = yield* h.round(Job, { value: "x" }, "backoff")
      yield* h.next(initial, "backoff-1")
      for (const [index, delay] of [100, 200, 200].entries()) {
        const id = `backoff-${index + 1}`
        const flow = h.declarations.get("test/external-job/observe")!
        yield* TestClock.adjust(delay - 1)
        yield* turns
        expect(Option.getOrThrow(yield* flow.poll(id))._tag).toBe("Suspended")
        expect(h.calls.filter((call) => call.startsWith("status:"))).toHaveLength(index + 1)
        yield* TestClock.adjust(1)
        yield* turns
        const wake = Option.getOrThrow(yield* flow.poll(id))
        const result = yield* h.next(wake, `backoff-${index + 2}`)
        expect(result._tag).toBe(index === 2 ? "Complete" : "Suspended")
      }
      expect(h.calls.filter((call) => call.startsWith("start:"))).toEqual(["start:backoff#g1"])
    }).pipe(Effect.provide(h.layer))
  })

  effect("derives distinct generation keys from execution identity for identical payloads", () => {
    const h = harness([{ _tag: "Exited", exitCode: 0 }, { _tag: "Exited", exitCode: 0 }])
    return Effect.gen(function*() {
      const first = yield* h.round(Job, { value: "same" }, "execution-a")
      const second = yield* h.round(Job, { value: "same" }, "execution-b")
      const a = yield* h.next(first, "observe-a")
      const b = yield* h.next(second, "observe-b")
      expect(a._tag).toBe("Complete")
      expect(b._tag).toBe("Complete")
      expect(h.calls.filter((call) => call.startsWith("start:"))).toEqual([
        "start:execution-a#g1",
        "start:execution-b#g1"
      ])
      expect(h.calls.filter((call) => call.startsWith("cancel:"))).toEqual([])
    }).pipe(Effect.provide(h.layer))
  })

  effect("parks without cancellation and probes again without starting again", () => {
    const h = harness([{ _tag: "Running" }, { _tag: "Exited", exitCode: 0 }])
    return Effect.gen(function*() {
      const started = yield* h.round(Job, { value: "x" }, "park")
      const parked = yield* h.next(started, "observe")
      expect(parked._tag).toBe("Suspended")
      expect(h.calls).toEqual(["start:park#g1", "status:park#g1"])
      yield* TestClock.adjust("100 millis")
      yield* turns
      const flow = h.declarations.get("test/external-job/observe")!
      const wake = yield* flow.poll("observe")
      expect(Option.isSome(wake)).toBe(true)
      const completed = yield* h.next(Option.getOrThrow(wake), "observe-2")
      expect(completed._tag).toBe("Complete")
      expect(h.calls.filter((call) => call.startsWith("start:"))).toEqual(["start:park#g1"])
      expect(h.calls.filter((call) => call.startsWith("cancel:"))).toEqual([])
    }).pipe(Effect.provide(h.layer))
  })

  for (const outcome of ["Lost", "Again"] as const) {
    effect(`${outcome} cancels before advancing generation`, () => {
      const h = harness(
        outcome === "Lost" ? [{ _tag: "Lost" }, { _tag: "Exited", exitCode: 0 }] : [
          { _tag: "Exited", exitCode: 0 },
          { _tag: "Exited", exitCode: 0 }
        ],
        outcome === "Again"
      )
      return Effect.gen(function*() {
        const initial = yield* h.round(Job, { value: "x" }, `retry-${outcome}`)
        const parked = yield* h.next(initial, "retry-observe")
        expect(parked._tag).toBe("Suspended")
        expect(h.calls).toContain(`cancel:retry-${outcome}#g1`)
        expect(h.calls).not.toContain(`start:retry-${outcome}#g2`)
        yield* TestClock.adjust("100 millis")
        yield* turns
        const wake = Option.getOrThrow(yield* h.declarations.get("test/external-job/observe")!.poll("retry-observe"))
        const relaunched = yield* h.next(wake, "retry-launch")
        const completed = yield* h.next(relaunched, "retry-complete")
        expect(completed._tag).toBe("Complete")
        expect(h.calls.indexOf(`cancel:retry-${outcome}#g1`)).toBeLessThan(h.calls.indexOf(`start:retry-${outcome}#g2`))
      }).pipe(Effect.provide(h.layer))
    })
  }

  effect("real cancellation during a live probe invokes Cancel", () => {
    const h = harness([{ _tag: "Running" }], false, true)
    return Effect.gen(function*() {
      const initial = yield* h.round(Job, { value: "x" }, "cancel")
      if (initial._tag !== "Handoff") return yield* Effect.die("missing initial handoff")
      yield* h.declarations.get(initial.flow)!.execute(initial.payload as never, {
        executionId: "cancel-observe",
        discard: true
      })
      yield* turns
      yield* h.declarations.get("test/external-job/observe")!.interrupt("cancel-observe")
      yield* turns
      expect(h.calls).toContain("cancel:cancel#g1")
    }).pipe(Effect.provide(h.layer))
  })
  effect("an interrupted run whose provider refuses the stop still ends: the rollback asks once", () => {
    const h = harness([{ _tag: "Running" }], false, true, false, 0, { stopFails: true })
    return Effect.gen(function*() {
      const initial = yield* h.round(Job, { value: "x" }, "refused")
      if (initial._tag !== "Handoff") return yield* Effect.die("missing initial handoff")
      yield* h.declarations.get(initial.flow)!.execute(initial.payload as never, {
        executionId: "refused-observe",
        discard: true
      })
      yield* turns
      const observe = h.declarations.get("test/external-job/observe")!
      yield* observe.interrupt("refused-observe")
      yield* turns
      expect(h.calls.filter((call) => call.startsWith("cancel:"))).toEqual(["cancel:refused#g1"])
      // The run ended anyway: the refused stop never kept it open.
      const ended = yield* observe.poll("refused-observe")
      expect(Option.isSome(ended) && ended.value._tag).not.toBe("Suspended")
      expect(Option.isSome(ended)).toBe(true)
    }).pipe(Effect.provide(h.layer))
  })

  effect("an interrupted admission whose provider refuses the abandon still ends: the rollback asks once", () => {
    const h = harness([], false, false, false, 0, { hold: "start", abandon: true, stopFails: true })
    return Effect.gen(function*() {
      yield* stored.execute({ value: "x" }, { executionId: "refused-admission", discard: true })
      yield* turns
      yield* stored.interrupt("refused-admission")
      yield* turns
      expect(h.calls).toEqual(["start:refused-admission#g1", "abandon:refused-admission#g1"])
      const ended = yield* stored.poll("refused-admission")
      expect(Option.isSome(ended) && ended.value._tag).not.toBe("Suspended")
      expect(Option.isSome(ended)).toBe(true)
    }).pipe(Effect.provide(h.layer))
  })

  it("lists its own declaration, its two continuations and its stop for a host that routes by tag", () => {
    expect(Job.flows.map((flow) => flow._tag)).toEqual([
      "test/external-job",
      "test/external-job/launch",
      "test/external-job/observe",
      "test/external-job/stop"
    ])
  })

  it("declares its observation's durable cancellation: its stop, run as cancel:<key>", () => {
    const observe = Job.flows[2]!
    const declared = Context.getOption(observe.annotations, Flow.OnCancel)
    expect(Option.isSome(declared)).toBe(true)
    if (Option.isNone(declared)) return
    expect(declared.value.flow).toBe(Job.flows[3])
    expect(declared.value.executionId({ origin: "run-1", generation: 2 })).toBe("cancel:run-1#g2")
    // Only the observation parks with a live generation; the job itself and its launch declare none.
    expect(Option.isNone(Context.getOption(Job.flows[0]!.annotations, Flow.OnCancel))).toBe(true)
    expect(Option.isNone(Context.getOption(Job.flows[1]!.annotations, Flow.OnCancel))).toBe(true)
  })

  effect("timeout keeps the initial deadline across generations", () => {
    const h = harness([{ _tag: "Lost" }, { _tag: "Running" }])
    return Effect.gen(function*() {
      const initial = yield* h.round(Job, { value: "x" }, "timeout")
      yield* h.next(initial, "timeout-observe")
      yield* TestClock.adjust("100 millis")
      yield* turns
      const wake = Option.getOrThrow(yield* h.declarations.get("test/external-job/observe")!.poll("timeout-observe"))
      const relaunched = yield* h.next(wake, "timeout-launch")
      yield* TestClock.adjust("1 second")
      const completed = yield* h.next(relaunched, "timeout-complete")
      expect(completed._tag).toBe("Complete")
      if (completed._tag === "Complete") {
        expect(Exit.isFailure(completed.exit)).toBe(true)
        if (Exit.isFailure(completed.exit)) {
          expect(completed.exit.cause.reasons).toEqual(expect.arrayContaining([
            expect.objectContaining({ error: expect.objectContaining({ _tag: "@smthrs/flow/ExternalJobTimedOut" }) })
          ]))
        }
      }
      expect(h.calls).toContain("cancel:timeout#g2")
    }).pipe(Effect.provide(h.layer))
  })

  effect("exhausted Lost settles an infra failure without another start", () => {
    const h = harness([{ _tag: "Lost" }, { _tag: "Lost" }])
    return Effect.gen(function*() {
      const initial = yield* h.round(Job, { value: "x" }, "lost")
      yield* h.next(initial, "lost-observe")
      yield* TestClock.adjust("100 millis")
      yield* turns
      const wake = Option.getOrThrow(yield* h.declarations.get("test/external-job/observe")!.poll("lost-observe"))
      const relaunched = yield* h.next(wake, "lost-launch")
      const failed = yield* h.next(relaunched, "lost-final")
      expect(failed._tag).toBe("Complete")
      if (failed._tag === "Complete") {
        expect(Exit.isFailure(failed.exit)).toBe(true)
        if (Exit.isFailure(failed.exit)) {
          expect(failed.exit.cause.reasons).toEqual(expect.arrayContaining([
            expect.objectContaining({ error: expect.objectContaining({ _tag: "@smthrs/flow/ExternalJobLost" }) })
          ]))
        }
      }
      expect(h.calls.filter((call) => call.startsWith("start:"))).toEqual(["start:lost#g1", "start:lost#g2"])
    }).pipe(Effect.provide(h.layer))
  })

  effect("an interrupted admission abandons the key the provider may have admitted", () => {
    const h = harness([], false, false, false, 0, { hold: "start", abandon: true })
    return Effect.gen(function*() {
      yield* stored.execute({ value: "x" }, { executionId: "admission", discard: true })
      yield* turns
      expect(h.calls).toEqual(["start:admission#g1"])
      yield* stored.interrupt("admission")
      yield* turns
      expect(h.calls).toEqual(["start:admission#g1", "abandon:admission#g1"])
    }).pipe(Effect.provide(h.layer))
  })

  effect("a failed start abandons its key, since the provider may have admitted it", () => {
    const h = harness([], false, false, true, 0, { abandon: true })
    return Effect.gen(function*() {
      const result = yield* h.round(Job, { value: "x" }, "failed-admission")
      expect(result._tag).toBe("Complete")
      if (result._tag === "Complete") expect(Exit.isFailure(result.exit)).toBe(true)
      expect(h.calls).toEqual(["start:failed-admission#g1", "abandon:failed-admission#g1"])
    }).pipe(Effect.provide(h.layer))
  })

  effect("a start still running at the deadline is abandoned before the job times out", () => {
    const h = harness([], false, false, false, 0, { hold: "start", abandon: true })
    return Effect.gen(function*() {
      yield* stored.execute({ value: "x" }, { executionId: "slow-start", discard: true })
      yield* turns
      yield* TestClock.adjust("1 second")
      yield* turns
      const result = Option.getOrThrow(yield* stored.poll("slow-start"))
      expectTimedOut(result)
      expect(h.calls).toEqual(["start:slow-start#g1", "abandon:slow-start#g1"])
    }).pipe(Effect.provide(h.layer))
  })

  effect("a host that stops during admission leaves the key, and no start runs after the deadline", () => {
    const state = makeMemoryState()
    const before = harness([], false, false, false, 0, { hold: "start", abandon: true, state })
    const after = harness([], false, false, false, 0, { abandon: true, state })
    return Effect.gen(function*() {
      yield* Effect.gen(function*() {
        yield* stored.execute({ value: "x" }, { executionId: "late-start", discard: true })
        yield* turns
      }).pipe(Effect.provide(before.layer))
      yield* turns
      expect(before.calls).toEqual(["start:late-start#g1"])
      forgetInterrupted(state)
      yield* TestClock.adjust("1 second")
      const result = yield* after.round(Job, { value: "x" }, "late-start").pipe(Effect.provide(after.layer))
      expectTimedOut(result)
      expect(after.calls).toEqual(["abandon:late-start#g1"])
    })
  })

  effect("a collect still running at the deadline cancels before the job times out", () => {
    const h = harness([{ _tag: "Exited", exitCode: 0 }], false, false, false, 0, { hold: "collect" })
    return Effect.gen(function*() {
      const initial = yield* h.round(Job, { value: "x" }, "slow-collect")
      if (initial._tag !== "Handoff") return yield* Effect.die("missing handoff")
      const observe = h.declarations.get(initial.flow)!
      yield* observe.execute(initial.payload as never, { executionId: "slow-collect-observe", discard: true })
      yield* turns
      yield* TestClock.adjust("1 second")
      yield* turns
      const result = Option.getOrThrow(yield* observe.poll("slow-collect-observe"))
      expectTimedOut(result)
      expect(h.calls).toEqual([
        "start:slow-collect#g1",
        "status:slow-collect#g1",
        "collect:slow-collect#g1",
        "cancel:slow-collect#g1"
      ])
    }).pipe(Effect.provide(h.layer))
  })

  effect("a collect reached after the deadline cancels without collecting", () => {
    const state = makeMemoryState()
    const before = harness([{ _tag: "Exited", exitCode: 0 }], false, false, false, 0, { hold: "collect", state })
    const after = harness([], false, false, false, 0, { state })
    return Effect.gen(function*() {
      const payload = yield* Effect.gen(function*() {
        const initial = yield* before.round(Job, { value: "x" }, "late-collect")
        if (initial._tag !== "Handoff") return yield* Effect.die("missing handoff")
        yield* before.declarations.get(initial.flow)!.execute(initial.payload as never, {
          executionId: "late-collect-observe",
          discard: true
        })
        yield* turns
        return initial.payload
      }).pipe(Effect.provide(before.layer))
      yield* turns
      expect(before.calls).toEqual([
        "start:late-collect#g1",
        "status:late-collect#g1",
        "collect:late-collect#g1"
      ])
      forgetInterrupted(state)
      yield* TestClock.adjust("1 second")
      const result = yield* Effect.gen(function*() {
        // Registering the root declaration registers its continuations.
        yield* after.round(Job, { value: "x" }, "late-collect")
        return yield* after.round(after.declarations.get("test/external-job/observe")!, payload, "late-collect-observe")
      }).pipe(Effect.provide(after.layer))
      expectTimedOut(result)
      expect(after.calls).toEqual(["cancel:late-collect#g1"])
    })
  })
})
