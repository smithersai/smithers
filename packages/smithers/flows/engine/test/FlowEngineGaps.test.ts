import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect, liveEffect, pollUntil } from "./Harness.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

/**
 * The same wiring on the live clock, for cases that wait on the real elapsed
 * time a retry or resume policy schedules rather than driving `TestClock`.
 */
const isSuspended = (result: Flow.Result<any, any>) => result._tag === "Suspended"

describe("boundary descriptor identity", () => {
  // `boundaryHermetic` only folds a *well-formed* descriptor into the content
  // key. Every malformed shape must be ignored — never partially applied and
  // never a crash — so two actions differing only in junk metadata keep the
  // same replay identity.
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ["non-object metadata", "not-an-object"],
    ["null metadata", null],
    ["undefined metadata", undefined],
    ["readSet not an array", { readSet: {}, writeSet: [], boundaryMode: "hard" }],
    ["writeSet not an array", { readSet: [], writeSet: "out", boundaryMode: "hard" }],
    ["unknown boundaryMode", { readSet: [], writeSet: [], boundaryMode: "soft" }],
    ["missing boundaryMode", { readSet: [], writeSet: [] }],
    ["readSet entry not an object", { readSet: ["x"], writeSet: [], boundaryMode: "hard" }],
    ["readSet entry null", { readSet: [null], writeSet: [], boundaryMode: "hard" }],
    [
      "readSet entry without a string path",
      { readSet: [{ path: 1, digest: "d" }], writeSet: [], boundaryMode: "hard" }
    ],
    [
      "readSet entry without a string digest",
      { readSet: [{ path: "p", digest: 1 }], writeSet: [], boundaryMode: "hard" }
    ],
    [
      "writeSet entry not a string",
      { readSet: [], writeSet: [1], boundaryMode: "hard" }
    ]
  ]

  for (const [label, metadata] of malformed) {
    effect(`ignores ${label} and replays the descriptor-free identity`, () => {
      let executions = 0
      const plain = Action.make({
        name: "Gaps/boundary",
        success: Schema.Number,
        idempotencyKey: "boundary/v1",
        execute: Effect.sync(() => ++executions)
      })
      const junk = Action.make({
        name: "Gaps/boundary",
        success: Schema.Number,
        idempotencyKey: "boundary/v1",
        metadata: metadata as any,
        execute: Effect.sync(() => ++executions)
      })
      const flowActionDeclaration = Action.make("Gaps/boundary-malformed/action", {
        payload: { id: Schema.String },
        success: Schema.Number
      })
      const flow = Flow.make("Gaps/boundary-malformed", {
        payload: { id: Schema.String },
        success: Schema.Number,
        body: (payload) => flowActionDeclaration.call(payload)
      })
      const layer = Layer.mergeAll(
        flowActionDeclaration.toLayer(() => Effect.andThen(plain, junk)),
        Interpreter.layer(flow)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations)
      ).pipe(
        Layer.provideMerge(FlowEngine.layerMemory)
      )
      return Effect.gen(function*() {
        expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(1)
        expect(executions).toBe(1)
      }).pipe(Effect.provide(layer))
    })
  }

  effect("distinguishes the two well-formed boundary modes", () => {
    let executions = 0
    const build = (boundaryMode: "hard" | "expected") =>
      Action.make({
        name: "Gaps/boundary-mode",
        success: Schema.Number,
        idempotencyKey: "mode/v1",
        metadata: { readSet: [], writeSet: [], boundaryMode },
        execute: Effect.sync(() => ++executions)
      })
    const flowActionDeclaration = Action.make("Gaps/boundary-modes/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Gaps/boundary-modes", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          yield* build("hard")
          yield* build("expected")
          return yield* build("hard")
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      // "hard" replays its own earlier result; "expected" is a distinct key
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(1)
      expect(executions).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("a well-formed descriptor only enters the key for sealed string identities", () => {
    // Ordinal-keyed (unsealed) actions never consult the descriptor.
    let executions = 0
    const build = (digest: string) =>
      Action.make({
        name: "Gaps/unsealed-boundary",
        success: Schema.Number,
        metadata: {
          readSet: [{ path: "a", digest }],
          writeSet: ["out"],
          boundaryMode: "hard"
        },
        execute: Effect.sync(() => ++executions)
      })
    const flowActionDeclaration = Action.make("Gaps/unsealed-boundary/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Gaps/unsealed-boundary", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => Effect.andThen(build("d1"), build("d1"))),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      // both run: invocation key input advances regardless of the descriptor
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(2)
      expect(executions).toBe(2)
    }).pipe(Effect.provide(layer))
  })
})

describe("annotateWaiting", () => {
  effect("does not let a finishing sibling dispatch clobber a newer waiting declaration", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const slow = Action.make({
        name: "gaps-waiting-slow",
        success: Schema.Void,
        execute: Effect.gen(function*() {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        })
      })
      const parked = Action.make({
        name: "gaps-waiting-parked",
        success: Schema.Void,
        execute: FlowRuntime.annotateWaiting({ reason: "approval", token: "winner" })
      })
      const declaration = Action.make("Gaps/waiting-race/action", { payload: {}, success: Schema.Any })
      const flow = Flow.make("Gaps/waiting-race", {
        payload: {},
        success: Schema.Any,
        body: () => declaration.call({})
      })
      const layer = Layer.mergeAll(
        declaration.toLayer(() =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            const slowFiber = yield* slow.pipe(Effect.forkChild)
            yield* Deferred.await(entered)
            yield* parked
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(slowFiber)
            return instance.waiting
          })
        ),
        Interpreter.layer(flow)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory)
      )

      expect(yield* flow.execute({}, { executionId: "waiting-race" }).pipe(Effect.provide(layer))).toEqual({
        reason: "approval",
        token: "winner"
      })
    }))

  effect("records the declared waiting classification on the running instance", () => {
    const flowActionDeclaration = Action.make("Gaps/waiting/action", {
      payload: { id: Schema.String },
      success: Schema.Any
    })
    const flow = Flow.make("Gaps/waiting", {
      payload: { id: Schema.String },
      success: Schema.Any,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          const before = instance.waiting
          yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "req-1", wakeAt: 42 })
          const during = instance.waiting
          yield* FlowRuntime.annotateWaiting(undefined)
          return { before, during, after: instance.waiting }
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const result = yield* flow.execute({ id: "x" }, { executionId: "run-waiting" })
      expect(result.before).toBeUndefined()
      expect(result.during).toEqual({ reason: "approval", token: "req-1", wakeAt: 42 })
      // clearing the annotation returns the instance to the derived default
      expect(result.after).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  effect("threads a dispatch's own declaration back onto the flow's instance", () => {
    // A dispatch runs under an instance of its own, so an implementation that
    // declares how it waits — the shape `Sleep` and `WaitFor` ship — would have
    // its declaration die with that instance unless the driver threads it. Both
    // directions matter: the declaration travels out, and a body that annotated
    // before dispatching is not clobbered by a dispatch that declares nothing.
    const declaring = Action.make({
      name: "gaps-annotating",
      success: Schema.String,
      tier: "sealed",
      idempotencyKey: "gaps-annotating-v1",
      execute: Effect.as(
        FlowRuntime.annotateWaiting({ reason: "approval", token: "req-2" }),
        "declared"
      )
    })
    const silent = Action.make({
      name: "gaps-silent",
      success: Schema.String,
      tier: "sealed",
      idempotencyKey: "gaps-silent-v1",
      execute: Effect.succeed("silent")
    })
    const flowActionDeclaration = Action.make("Gaps/waiting-action/action", {
      payload: { id: Schema.String },
      success: Schema.Any
    })
    const flow = Flow.make("Gaps/waiting-action", {
      payload: { id: Schema.String },
      success: Schema.Any,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          yield* declaring
          const declared = instance.waiting
          yield* silent
          return { declared, preserved: instance.waiting }
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const result = yield* flow.execute({ id: "x" }, { executionId: "run-waiting-action" })
      expect(result.declared).toEqual({ reason: "approval", token: "req-2" })
      expect(result.preserved).toEqual({ reason: "approval", token: "req-2" })
    }).pipe(Effect.provide(layer))
  })
})

describe("suspended resume policy", () => {
  effect("reports expiration rather than exhaustion when a suspended retry crosses its wall-clock budget", () => {
    const flow = Flow.make("Gaps/suspend-expired", {
      payload: { id: Schema.String },
      success: Schema.String,
      suspendedRetryPolicy: RetryPolicy.make({
        initialMs: 100,
        factor: 1,
        maxMs: 100,
        expirationMs: 150
      }),
      body: () => Node.succeed("ready")
    })
    let executions = 0
    const scripted = scriptedEngine({
      execute: (() =>
        Effect.sync(() => {
          executions++
          return new Flow.Suspended({})
        })) as never,
      actionExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.void }))
    })
    return Effect.gen(function*() {
      const fiber = yield* flow.execute({ id: "x" }, { executionId: "run-expired" }).pipe(
        Effect.exit,
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust(200)
      const exit = yield* Fiber.join(fiber)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("suspendedRetryPolicy expired")
      const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
      expect(defect).toBeInstanceOf(FlowEngine.SuspendedResumeGaveUp)
      expect(defect).toMatchObject({ code: "suspended_resume_gave_up", reason: "expired" })
      expect(executions).toBe(2)
    }).pipe(
      Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(scripted)),
      Effect.provide(TestClock.layer())
    )
  })

  effect("dies once the suspendedRetryPolicy stops offering delays", () => {
    const Gate = DurableDeferred.make("Gaps/never-resolved", {
      success: Schema.String
    })
    const flowActionDeclaration = Action.make("Gaps/suspend-exhausted/action", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("Gaps/suspend-exhausted", {
      payload: { id: Schema.String },
      success: Schema.String,
      // one resume attempt, then the policy is exhausted
      suspendedRetryPolicy: RetryPolicy.make({
        initialMs: 1,
        factor: 1,
        maxMs: 1,
        maxAttempts: 1
      }),
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => DurableDeferred.await(Gate)),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run-exhausted" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("suspendedRetryPolicy exhausted")
      const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
      expect(defect).toBeInstanceOf(FlowEngine.SuspendedResumeGaveUp)
      expect(defect).toMatchObject({ code: "suspended_resume_gave_up", reason: "exhausted" })
    }).pipe(Effect.provide(layer))
  })

  liveEffect("keeps re-polling a suspended flow until the deferred is completed", () => {
    const Gate = DurableDeferred.make("Gaps/late-resolved", {
      success: Schema.String
    })
    const flowActionDeclaration = Action.make("Gaps/suspend-resumes/action", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("Gaps/suspend-resumes", {
      payload: { id: Schema.String },
      success: Schema.String,
      suspendedRetryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1 }),
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => DurableDeferred.await(Gate)),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        flow.execute({ id: "x" }, { executionId: "run-late" })
      )
      // The forked execute may not have recorded the run on the first poll
      // tick, so a typed not-found during startup reads as "not settled yet"
      // for this loop.
      const suspended = yield* pollUntil(
        flow.poll("run-late").pipe(
          Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeedNone)
        ),
        isSuspended,
        { turns: 100 }
      )
      expect(Option.isSome(suspended)).toBe(true)
      const token = DurableDeferred.tokenFromExecutionId(Gate, { flow, executionId: "run-late" })
      yield* DurableDeferred.succeed(Gate, { token, value: "opened" })
      expect(yield* Fiber.join(fiber)).toBe("opened")
    }).pipe(Effect.provide(layer))
  })
})

describe("action retry give-up reasons", () => {
  effect("uses a durable retry origin when calculating an action expiration", () => {
    const action = Action.make({
      name: "Gaps/durable-retry-origin",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({
        initialMs: 10,
        factor: 1,
        maxMs: 10,
        expirationMs: 1
      }),
      execute: Effect.die("action executor must not run in this driver test")
    })
    const flow = Flow.make("Gaps/durable-retry-origin", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: () => Node.succeed(0)
    })
    let requestedKey: string | undefined
    const scripted = scriptedEngine({
      actionExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.fail("unavailable") })),
      actionRetryOrigin: ({ key }) => Effect.sync(() => (requestedKey = key, Option.some(0)))
    })
    return Effect.gen(function*() {
      const result = yield* scripted.actionExecute(action, 1)
      expect(requestedKey).toBeTypeOf("string")
      expect(result._tag).toBe("Complete")
      if (result._tag === "Complete") {
        expect(Exit.isFailure(result.exit)).toBe(true)
        expect(Exit.isFailure(result.exit) && Cause.squash(result.exit.cause)).toBe("unavailable")
      }
    }).pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        FlowEngine.makeInstance(flow, "run-origin")
      ),
      Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(scripted))
    )
  })

  effect("preserves the failure when a zero-delay policy stops without maxAttempts", () => {
    // A policy whose first delay is not positive gives up as `exhausted`
    // without ever declaring maxAttempts; the reported bound is the attempt
    // actually reached. `RetryPolicy.make` refuses `initialMs: 0`, so this
    // models a persisted row that bypassed the constructor.
    let attempts = 0
    const action = Action.make({
      name: "Gaps/exhausted-no-max",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: { initialMs: 0, factor: 2, maxMs: 100 } satisfies RetryPolicy.RetryPolicy,
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail("nope")
      })
    })
    const flowActionDeclaration = Action.make("Gaps/exhausted-no-max/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Gaps/exhausted-no-max", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => action), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(defect).toBe("nope")
      expect(attempts).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("a nonRetryable error propagates the original typed failure, not a retry defect", () => {
    let attempts = 0
    class Fatal extends Schema.Error<Fatal>("Gaps/Fatal")({
      _tag: Schema.tag("Fatal"),
      message: Schema.String
    }) {}
    const action = Action.make({
      name: "Gaps/nonretryable",
      success: Schema.Number,
      error: Fatal,
      retryPolicy: RetryPolicy.make({
        initialMs: 1,
        factor: 1,
        maxMs: 1,
        nonRetryable: ["Fatal"]
      }),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail(new Fatal({ message: "no retry" }))
      })
    })
    const flowActionDeclaration = Action.make("Gaps/nonretryable/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Fatal
    })
    const flow = Flow.make("Gaps/nonretryable", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Fatal,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => action), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && (Cause.squash(exit.cause) as Fatal).message).toBe("no retry")
      expect(attempts).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})

describe("memory engine lifecycle", () => {
  effect("interruptUnsafe on an unknown execution id is a no-op", () => {
    const flowActionDeclaration = Action.make("Gaps/interrupt-unknown/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const flow = Flow.make("Gaps/interrupt-unknown", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => Effect.void), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.interruptUnsafe(flow, "never-started")
      yield* engine.resume(flow, "never-started")
      // Neither no-op invented an execution: the id is still unknown, which
      // poll reports as a typed not-found rather than `Option.none`.
      const error = yield* Effect.flip(flow.poll("never-started"))
      expect(error).toMatchObject({
        _tag: "@smthrs/flow/FlowExecutionNotFound",
        executionId: "never-started"
      })
    }).pipe(Effect.provide(layer))
  })

  effect("polling a flow whose defect escaped capture surfaces the defect", () => {
    const flowActionDeclaration = Action.make("Gaps/uncaptured-defect/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const flow = Flow.make("Gaps/uncaptured-defect", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => flowActionDeclaration.call(payload)
    }).annotate(Flow.CaptureDefects, false)
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => Effect.die("boom")), Interpreter.layer(flow))
      .pipe(
        Layer.provideMerge(Action.layerImplementations)
      ).pipe(
        Layer.provideMerge(FlowEngine.layerMemory)
      )
    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-defect", discard: true }).pipe(Effect.exit)
      let polled = yield* flow.poll("run-defect").pipe(Effect.exit)
      for (let i = 0; i < 50 && Exit.isSuccess(polled) && Option.isNone(polled.value); i++) {
        yield* Effect.yieldNow
        polled = yield* flow.poll("run-defect").pipe(Effect.exit)
      }
      expect(Exit.isFailure(polled)).toBe(true)
      expect(Exit.isFailure(polled) && String(polled.cause)).toContain("boom")
    }).pipe(Effect.provide(layer))
  })

  effect("captures the same defect as a Complete failure exit by default", () => {
    const flowActionDeclaration = Action.make("Gaps/captured-defect/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const flow = Flow.make("Gaps/captured-defect", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => Effect.die("boom")), Interpreter.layer(flow))
      .pipe(
        Layer.provideMerge(Action.layerImplementations)
      ).pipe(
        Layer.provideMerge(FlowEngine.layerMemory)
      )
    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-captured", discard: true })
      let polled = yield* flow.poll("run-captured")
      for (let i = 0; i < 50 && (Option.isNone(polled) || polled.value._tag !== "Complete"); i++) {
        yield* Effect.yieldNow
        polled = yield* flow.poll("run-captured")
      }
      expect(Option.isSome(polled) && polled.value._tag).toBe("Complete")
      expect(
        Option.isSome(polled) && polled.value._tag === "Complete" &&
          Exit.isFailure(polled.value.exit) && String(polled.value.exit.cause)
      ).toContain("boom")
    }).pipe(Effect.provide(layer))
  })
})
