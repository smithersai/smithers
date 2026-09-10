// Deep reviewed and polished by a human on 2026-08-10.

/**
 * The in-memory engine's durable-wait paths: scheduled clocks, externally
 * completed deferreds, interruption of a parked execution, and the no-op
 * shape of driving an execution the engine has never seen.
 *
 * The authoring semantics of `DurableClock`, `DurableDeferred`, and
 * suspension live in `@smthrs/flow`'s suite. What is asserted here is the
 * engine's side of the same interaction.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableClock, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Cause, Deferred, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { layerDurable, makeLog } from "./DurableLogEngine.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body().pipe(Effect.provide(TestClock.layer()))))

const pollSuspended = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, FlowRuntime.FlowExecutionNotFound, R>
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 20 && Option.isNone(result); i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 milli")
      result = yield* poll
    }
    return result
  })

const pollComplete = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, FlowRuntime.FlowExecutionNotFound, R>
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 20 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 milli")
      result = yield* poll
    }
    return result
  })

describe("action dispatch interruption", () => {
  effect("does not replay a cancelled dispatch into another run sharing a cache key", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      let executions = 0
      const cached = Action.make({
        name: "InterruptedCache/shared",
        success: Schema.String,
        idempotencyKey: "shared-v1",
        execute: Effect.gen(function*() {
          executions += 1
          yield* Deferred.succeed(entered, undefined)
          if (executions === 1) return yield* Effect.never
          return `run-${executions}`
        })
      })
      const step = Action.make("InterruptedCache/step", { payload: {}, success: Schema.String })
      const flow = Flow.make("InterruptedCache/flow", {
        payload: {},
        success: Schema.String,
        body: (payload) => step.call(payload)
      })
      const layer = Layer.mergeAll(step.toLayer(() => cached), Interpreter.layer(flow)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(Action.layerCacheEnvironment({ layers: ["shared-model"], capabilities: {} }))
      )
      yield* Effect.gen(function*() {
        const runA = yield* flow.execute({}, { executionId: "run-a", discard: true })
        yield* Deferred.await(entered)
        yield* flow.interrupt(runA)
        const cancelled = yield* pollComplete(flow.poll(runA))
        expect(Option.isSome(cancelled) && cancelled.value._tag === "Complete" && cancelled.value.exit._tag)
          .toBe("Failure")

        const runB = yield* flow.execute({}, { executionId: "run-b" }).pipe(Effect.exit)
        expect(runB).toEqual(Exit.succeed("run-2"))
        expect(executions).toBe(2)
      }).pipe(Effect.provide(layer))
    }))

  for (
    const [name, engine] of [
      ["memory", FlowEngine.layerMemory],
      ["durable", layerDurable(makeLog())]
    ] as const
  ) {
    effect(`${name}: re-executes a raced dispatch after a deferred wake`, () =>
      Effect.gen(function*() {
        let executions = 0
        const slow = Action.make({
          name: "InterruptedRace/slow",
          success: Schema.String,
          execute: Effect.gen(function*() {
            executions += 1
            yield* Effect.sleep("1 hour")
            return "slow"
          })
        })
        const gate = DurableDeferred.make("InterruptedRace/gate", { success: Schema.String })
        const step = Action.make("InterruptedRace/step", { payload: {}, success: Schema.String })
        const flow = Flow.make("InterruptedRace/flow", {
          payload: {},
          success: Schema.String,
          body: (payload) => step.call(payload)
        })
        const layer = Layer.mergeAll(
          step.toLayer(() =>
            Effect.gen(function*() {
              const first = yield* Effect.raceFirst(slow, Effect.as(Effect.sleep("5 millis"), "timed-out"))
              const woken = yield* DurableDeferred.await(gate)
              return `${first}:${woken}`
            })
          ),
          Interpreter.layer(flow)
        ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(engine))
        yield* Effect.gen(function*() {
          const executionId = yield* flow.execute({}, { executionId: "race-run", discard: true })
          const parked = yield* pollSuspended(flow.poll(executionId))
          expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
          expect(executions).toBe(1)

          const token = DurableDeferred.tokenFromExecutionId(gate, { flow, executionId })
          yield* DurableDeferred.succeed(gate, { token, value: "opened" })
          const woken = yield* pollComplete(flow.poll(executionId))
          expect(Option.isSome(woken) && woken.value._tag === "Complete" && woken.value.exit).toEqual(
            Exit.succeed("timed-out:opened")
          )
          expect(executions).toBe(2)
        }).pipe(Effect.provide(layer))
      }))
  }
})

describe("FlowEngine.layerMemory durable waits", () => {
  const ParkedActionDeclaration = Action.make("Memory/Parked/action", {
    payload: { id: Schema.String },
    success: Schema.String
  })
  const Parked = Flow.make("Memory/Parked", {
    payload: { id: Schema.String },
    success: Schema.String,
    idempotencyKey: ({ id }) => id,
    body: (payload) => ParkedActionDeclaration.call(payload)
  })
  const gate = DurableDeferred.make("Memory/gate", { success: Schema.String })

  const ParkedLayer = Layer.mergeAll(
    ParkedActionDeclaration.toLayer(() => DurableDeferred.await(gate)),
    Interpreter.layer(Parked)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations)
  ).pipe(
    Layer.provideMerge(FlowEngine.layerMemory)
  )

  effect("records a deferred result once and resumes the parked execution", () =>
    Effect.gen(function*() {
      const executionId = yield* Parked.execute({ id: "wake" }, { discard: true })
      expect(Option.isSome(yield* pollSuspended(Parked.poll(executionId)))).toBe(true)

      const token = DurableDeferred.tokenFromExecutionId(gate, { flow: Parked, executionId })
      yield* DurableDeferred.succeed(gate, { token, value: "first" })
      const woken = yield* pollComplete(Parked.poll(executionId))
      expect(Option.isSome(woken) && woken.value._tag).toBe("Complete")

      // re-driving a completed execution is a no-op, and a second completion
      // of the same deferred is ignored rather than overwritten
      yield* Parked.resume(executionId)
      yield* DurableDeferred.succeed(gate, { token, value: "second" })
      const settled = yield* pollComplete(Parked.poll(executionId))
      expect(
        Option.isSome(settled) && settled.value._tag === "Complete" && settled.value.exit._tag
      ).toBe("Success")
    }).pipe(Effect.provide(ParkedLayer)))

  effect("interrupting a parked execution drives it to a terminal result", () =>
    Effect.gen(function*() {
      const executionId = yield* Parked.execute({ id: "cancel" }, { discard: true })
      expect(Option.isSome(yield* pollSuspended(Parked.poll(executionId)))).toBe(true)
      yield* Parked.interrupt(executionId)
      yield* Effect.yieldNow
      const polled = yield* Parked.poll(executionId)
      expect(Option.isSome(polled)).toBe(true)
    }).pipe(Effect.provide(ParkedLayer)))

  effect("resuming or interrupting an unknown execution is a no-op", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.resume(Parked, "never-started")
      yield* engine.interrupt(Parked, "never-started")
      // Neither no-op invented an execution: poll still reports the id as a
      // typed not-found rather than `Option.none`.
      const error = yield* Effect.flip(Parked.poll("never-started"))
      expect(error).toMatchObject({
        _tag: "@smthrs/flow/FlowExecutionNotFound",
        executionId: "never-started"
      })
    }).pipe(Effect.provide(ParkedLayer)))

  effect("a wake with no remaining registration leaves the execution parked", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const Fleeting = Flow.make("Memory/Fleeting", {
        payload: { id: Schema.String },
        success: Schema.String,
        body: (payload) => ParkedActionDeclaration.call(payload)
      })
      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* engine.register(Fleeting, () =>
            Effect.gen(function*() {
              const instance = yield* FlowRuntime.FlowInstance
              return yield* Flow.suspend(instance)
            }))
          yield* engine.execute(Fleeting, { executionId: "fleeting-run", payload: { id: "x" }, discard: true })
          expect(Option.isSome(yield* pollSuspended(engine.poll(Fleeting, "fleeting-run")))).toBe(true)
        })
      )
      // Every registration of the tag is closed: the wake is a no-op and the
      // execution stays parked for a process that registers the flow again —
      // the durable driver takes the same posture for a run that wakes where
      // its flow is unknown.
      yield* engine.resume(Fleeting, "fleeting-run")
      const polled = yield* engine.poll(Fleeting, "fleeting-run")
      expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended")
    }).pipe(Effect.provide(FlowEngine.layerMemory)))

  effect("arms a scheduled clock and completes its deferred at the deadline", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const clock = DurableClock.make({ name: "armed", duration: "10 minutes" })
      yield* engine.scheduleClock(Parked, { executionId: "clock-run", clock })

      const instance = FlowEngine.makeInstance(Parked, "clock-run")
      const read = engine.deferredResult(clock.deferred).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
      expect(Option.isNone(yield* read)).toBe(true)
      yield* TestClock.adjust("10 minutes")
      expect(Option.isSome(yield* read)).toBe(true)
    }).pipe(Effect.provide(FlowEngine.layerMemory)))

  effect("keeps flow, execution, and wait-name tuples injective", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const Left = Flow.make("Memory/Wait/Left", {
        payload: {},
        success: Schema.Void,
        body: () => {
          throw new Error("not executed")
        }
      })
      const Right = Flow.make("Memory/Wait/Right", {
        payload: {},
        success: Schema.Void,
        body: () => {
          throw new Error("not executed")
        }
      })
      const left = DurableDeferred.make("c", { success: Schema.String })
      const right = DurableDeferred.make("b/c", { success: Schema.String })
      yield* engine.deferredDone(left, {
        flowName: Left._tag,
        executionId: "a/b",
        deferredName: left.name,
        exit: Exit.succeed("left")
      })
      const readLeft = engine.deferredResult(left).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(Left, "a/b"))
      )
      const readRight = engine.deferredResult(right).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(Right, "a"))
      )
      expect(Option.isSome(yield* readLeft)).toBe(true)
      expect(Option.isNone(yield* readRight)).toBe(true)

      const leftClock = DurableClock.make({ name: "c", duration: "1 minute" })
      const rightClock = DurableClock.make({ name: "b/c", duration: "2 minutes" })
      yield* engine.scheduleClock(Left, { executionId: "a/b", clock: leftClock })
      yield* engine.scheduleClock(Right, { executionId: "a", clock: rightClock })
      const leftClockRead = engine.deferredResult(leftClock.deferred).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(Left, "a/b"))
      )
      const rightClockRead = engine.deferredResult(rightClock.deferred).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(Right, "a"))
      )
      yield* TestClock.adjust("1 minute")
      expect(Option.isSome(yield* leftClockRead)).toBe(true)
      expect(Option.isNone(yield* rightClockRead)).toBe(true)
      yield* TestClock.adjust("1 minute")
      expect(Option.isSome(yield* rightClockRead)).toBe(true)
    }).pipe(Effect.provide(FlowEngine.layerMemory)))

  effect("decodes a fresh payload snapshot for every re-drive", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const Mutable = Flow.make("Memory/PayloadSnapshot", {
          payload: { nested: Schema.Struct({ value: Schema.String }), values: Schema.Array(Schema.String) },
          success: Schema.String,
          body: () => {
            throw new Error("not executed")
          }
        })
        let passes = 0
        const entered = yield* Deferred.make<void>()
        yield* engine.register(Mutable, (payload) =>
          Effect.gen(function*() {
            passes += 1
            if (passes === 1) {
              const mutable = payload as { nested: { value: string }; values: Array<string> }
              mutable.nested.value = "handler-mutated"
              mutable.values.push("handler-mutated")
              yield* Deferred.succeed(entered, undefined)
              const instance = yield* FlowRuntime.FlowInstance
              return yield* Flow.suspend(instance)
            }
            return `${payload.nested.value}:${payload.values.join(",")}`
          }))
        const input = { nested: { value: "before" }, values: ["before"] }
        const started = yield* engine.execute(Mutable, {
          executionId: "payload-snapshot",
          payload: input,
          discard: true
        })
        yield* Deferred.await(entered)
        expect(Option.isSome(yield* pollSuspended(engine.poll(Mutable, started)))).toBe(true)
        input.nested.value = "caller-mutated"
        input.values.push("caller-mutated")
        yield* engine.resume(Mutable, started)
        const settled = yield* pollComplete(engine.poll(Mutable, started))
        expect(Option.isSome(settled) && settled.value._tag === "Complete" && settled.value.exit).toEqual(
          Exit.succeed("before:before")
        )
      }).pipe(Effect.provide(FlowEngine.layerMemory))
    ))

  effect("keeps a payload member the schema declares opaque", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        // A declared member has no JSON form. Snapshotting the payload through
        // `Schema.toCodecJson` refused every such payload until 2026-09-01,
        // which took out every `smithers-build` target that names a
        // dependency, so the reference reaching the body is pinned here.
        const reference = { open: () => "opened" }
        const Reference = Schema.declare<typeof reference>(
          (value): value is typeof reference =>
            typeof value === "object" && value !== null && typeof (value as typeof reference).open === "function",
          { identifier: "test/OpaqueReference" }
        )
        const Opaque = Flow.make("Memory/OpaquePayload", {
          payload: { refs: Schema.Array(Reference), label: Schema.String },
          success: Schema.String,
          body: () => {
            throw new Error("not executed")
          }
        })
        yield* engine.register(Opaque, (payload) => Effect.succeed(`${payload.label}:${payload.refs[0]!.open()}`))
        const started = yield* engine.execute(Opaque, {
          executionId: "opaque-payload",
          payload: { refs: [reference], label: "held" },
          discard: true
        })
        const settled = yield* pollComplete(engine.poll(Opaque, started))
        expect(Option.isSome(settled) && settled.value._tag === "Complete" && settled.value.exit).toEqual(
          Exit.succeed("held:opened")
        )
      }).pipe(Effect.provide(FlowEngine.layerMemory))
    ))

  effect("refuses a deferred completion addressed to another flow", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const Known = Flow.make("Memory/KnownFlow", {
          payload: {},
          success: Schema.Void,
          body: () => {
            throw new Error("not executed")
          }
        })
        const Other = Flow.make("Memory/OtherFlow", {
          payload: {},
          success: Schema.Void,
          body: () => {
            throw new Error("not executed")
          }
        })
        yield* engine.register(Known, () => Effect.succeed(undefined))
        yield* engine.execute(Known, { executionId: "known-flow", payload: {}, discard: true })
        const exit = yield* Effect.exit(engine.deferredDone(gate, {
          flowName: Other._tag,
          executionId: "known-flow",
          deferredName: gate.name,
          exit: Exit.succeed("wrong-flow")
        }))
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
        expect(defect).toBeInstanceOf(FlowEngine.ExecutionIdentityConflict)
        expect(defect).toMatchObject({
          code: "execution_identity_conflict",
          field: "flow",
          expected: "Memory/KnownFlow",
          actual: "Memory/OtherFlow"
        })
      }).pipe(Effect.provide(FlowEngine.layerMemory))
    ))

  effect("atomically completes only the exact active wait and preserves the first answer", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const Waiting = Flow.make("Memory/WaitingCas", {
          payload: {},
          success: Schema.Void,
          body: () => {
            throw new Error("registered directly")
          }
        })
        yield* engine.register(Waiting, () =>
          Effect.gen(function*() {
            yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "attempt-1" })
            const instance = yield* FlowRuntime.FlowInstance
            return yield* Flow.suspend(instance)
          }))
        yield* engine.execute(Waiting, { executionId: "waiting-cas", payload: {}, discard: true })
        expect(Option.isSome(yield* pollSuspended(engine.poll(Waiting, "waiting-cas")))).toBe(true)

        const complete = (overrides: Partial<{
          readonly flowName: string
          readonly executionId: string
          readonly reason: string
          readonly token: string
          readonly value: string
        }> = {}) =>
          engine.deferredDoneIfWaiting(gate, {
            flowName: overrides.flowName ?? Waiting._tag,
            executionId: overrides.executionId ?? "waiting-cas",
            deferredName: gate.name,
            reason: overrides.reason ?? "approval",
            token: overrides.token ?? "attempt-1",
            exit: Exit.succeed(overrides.value ?? "first")
          })

        expect(yield* complete({ executionId: "unknown" })).toBe("NotWaiting")
        expect(yield* complete({ flowName: "Memory/OtherFlow" })).toBe("NotWaiting")
        expect(yield* complete({ reason: "event" })).toBe("NotWaiting")
        expect(yield* complete({ token: "attempt-2" })).toBe("NotWaiting")
        expect(yield* complete()).toBe("Completed")
        expect(Option.isSome(yield* pollSuspended(engine.poll(Waiting, "waiting-cas")))).toBe(true)
        expect(yield* complete({ value: "second" })).toBe("Existing")

        const recorded = yield* engine.deferredResult(gate).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(Waiting, "waiting-cas"))
        )
        expect(recorded).toEqual(Option.some(Exit.succeed("first")))
      }).pipe(Effect.provide(FlowEngine.layerMemory))
    ))

  effect("fails closed when an encoded driver has no conditional completion primitive", () =>
    Effect.gen(function*() {
      const engine = FlowEngine.makeUnsafe({
        register: () => Effect.void,
        execute: () => Effect.die("not used"),
        poll: () => Effect.succeedNone,
        interrupt: () => Effect.void,
        interruptUnsafe: () => Effect.void,
        resume: () => Effect.void,
        actionExecute: () => Effect.die("not used"),
        deferredResult: () => Effect.succeedNone,
        deferredDone: () => Effect.void,
        scheduleClock: () => Effect.void
      })
      expect(
        yield* engine.deferredDoneIfWaiting(gate, {
          flowName: Parked._tag,
          executionId: "missing-conditional-driver",
          deferredName: gate.name,
          reason: "approval",
          token: "attempt-1",
          exit: Exit.succeed("ignored")
        })
      ).toBe("NotWaiting")
    }))
})

describe("FlowEngine.layerMemory normal interrupt of a live action", () => {
  /** A flow whose single action is genuinely RUNNING — blocked on an in-process
   * deferred, never parked — so `interrupt` targets live work rather than a
   * settled `Suspended` round. */
  const liveCase = (tag: string) => {
    const events: Array<string> = []
    const actionDeclaration = Action.make(`${tag}/action`, {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make(tag, {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => actionDeclaration.call(payload)
    })
    return { actionDeclaration, events, flow }
  }

  effect("a cancel of an uninterruptible live action lets it settle, then reports the recorded cancellation", () => {
    const { actionDeclaration, events, flow } = liveCase("Memory/LiveSettle")
    return Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = Layer.mergeAll(
        actionDeclaration.toLayer(() =>
          // Uninterruptible: the prompt delivery below cannot tear this body,
          // so it is the case that still settles on its own after a cancel.
          Effect.uninterruptible(Effect.gen(function*() {
            events.push("enter")
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            events.push("settle")
            return "done"
          })).pipe(Effect.ensuring(Effect.sync(() => void events.push("cleanup"))))
        ),
        Interpreter.layer(flow)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations)
      ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
      return yield* Effect.gen(function*() {
        const executionId = yield* flow.execute({ id: "live-settle" }, { discard: true })
        yield* Deferred.await(entered)
        // The normal interrupt records the request and delivers the
        // interruption, but the uninterruptible body holds it off: nothing
        // settles until the body does.
        yield* flow.interrupt(executionId)
        yield* Effect.yieldNow
        expect(Option.isNone(yield* flow.poll(executionId))).toBe(true)
        // The action then settles on its own — and the recorded cancellation,
        // not the action's value, is the round's terminal result.
        yield* Deferred.succeed(release, undefined)
        const polled = yield* pollComplete(flow.poll(executionId))
        expect(Option.isSome(polled) && polled.value._tag).toBe("Complete")
        const exit = Option.isSome(polled) && polled.value._tag === "Complete"
          ? polled.value.exit
          : undefined
        expect(exit !== undefined && Exit.isFailure(exit)).toBe(true)
        expect(
          exit !== undefined && Exit.isFailure(exit) &&
            exit.cause.reasons.some(Cause.isInterruptReason)
        ).toBe(true)
        // The action ran to completion and its cleanup fired before the
        // cancellation reported.
        expect(events).toEqual(["enter", "settle", "cleanup"])
      }).pipe(Effect.provide(layer))
    })
  })

  // `layerMemory.interrupt` delivers the interruption to the live body fiber:
  // an action blocked in flight is cancelled, its finalizers run, and the
  // round fiber converts the interruption into the recorded cancellation —
  // `interrupt`'s contract that the engine "interrupts active work while
  // preserving its normal cleanup".
  effect("normal interrupt cancels a live blocked action promptly with its cleanup", () => {
    const { actionDeclaration, events, flow } = liveCase("Memory/LivePrompt")
    return Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const layer = Layer.mergeAll(
        actionDeclaration.toLayer(() =>
          Effect.gen(function*() {
            events.push("enter")
            yield* Deferred.succeed(entered, undefined)
            return yield* Effect.never
          }).pipe(Effect.ensuring(Effect.sync(() => void events.push("cleanup"))))
        ),
        Interpreter.layer(flow)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations)
      ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
      return yield* Effect.gen(function*() {
        const executionId = yield* flow.execute({ id: "live-prompt" }, { discard: true })
        yield* Deferred.await(entered)
        yield* flow.interrupt(executionId)
        const polled = yield* pollComplete(flow.poll(executionId))
        // The advertised contract: active work is interrupted, its cleanup
        // runs, and the poll observes the terminal cancellation.
        expect(Option.isSome(polled) && polled.value._tag).toBe("Complete")
        expect(events).toContain("cleanup")
      }).pipe(Effect.provide(layer))
    })
  })

  effect("an interrupt landing before the round fiber starts cancels without dispatching the action", () => {
    const { actionDeclaration, events, flow } = liveCase("Memory/LiveUnstarted")
    return Effect.gen(function*() {
      const layer = Layer.mergeAll(
        actionDeclaration.toLayer(() =>
          Effect.sync(() => {
            events.push("enter")
            return "done"
          })
        ),
        Interpreter.layer(flow)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations)
      ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
      return yield* Effect.gen(function*() {
        const executionId = yield* flow.execute({ id: "live-unstarted" }, { discard: true })
        // Same tick as `execute`: the round fiber is installed but has not
        // run, so there is no body fiber to signal yet — the request lands on
        // the instance and the body observes it the moment it starts.
        yield* flow.interrupt(executionId)
        const polled = yield* pollComplete(flow.poll(executionId))
        expect(Option.isSome(polled) && polled.value._tag).toBe("Complete")
        const exit = Option.isSome(polled) && polled.value._tag === "Complete"
          ? polled.value.exit
          : undefined
        expect(exit !== undefined && Exit.isFailure(exit)).toBe(true)
        // The cancellation arrived before the body started: no action work
        // was ever dispatched.
        expect(events).toEqual([])
      }).pipe(Effect.provide(layer))
    })
  })
})

describe("FlowEngine.layerMemory resume and wake contract", () => {
  const ParkedActionDeclaration = Action.make("Memory/Wake/action", {
    payload: { id: Schema.String },
    success: Schema.String
  })
  const Parked = Flow.make("Memory/Wake", {
    payload: { id: Schema.String },
    success: Schema.String,
    idempotencyKey: ({ id }) => id,
    body: (payload) => ParkedActionDeclaration.call(payload)
  })
  const gate = DurableDeferred.make("Memory/Wake/gate", { success: Schema.String })
  const ParkedLayer = Layer.mergeAll(
    ParkedActionDeclaration.toLayer(() => DurableDeferred.await(gate)),
    Interpreter.layer(Parked)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations)
  ).pipe(
    Layer.provideMerge(FlowEngine.layerMemory)
  )

  /** A handful of scheduler turns with the clock untouched. */
  const settle = Effect.gen(function*() {
    for (let i = 0; i < 8; i++) yield* Effect.yieldNow
  })

  effect("keeps a round that died with an escaped defect terminal across resumes", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const Dying = Flow.make("Memory/Dying", {
          payload: {},
          success: Schema.String,
          body: () => {
            throw new Error("registered directly")
          }
        }).annotate(Flow.CaptureDefects, false)
        let runs = 0
        yield* engine.register(Dying, () =>
          Effect.suspend(() => {
            runs += 1
            return Effect.die("boom")
          }))
        yield* engine.execute(Dying, { executionId: "dies", payload: {}, discard: true })
        yield* settle
        expect(runs).toBe(1)
        const before = yield* Effect.exit(engine.poll(Dying, "dies"))
        expect(Exit.isFailure(before) && Cause.hasDies(before.cause)).toBe(true)

        // A Failure exit is a settlement, not a suspension: neither a bare
        // resume nor a deferred completion addressed to the run re-runs the
        // body's effects.
        yield* engine.resume(Dying, "dies")
        yield* settle
        yield* engine.deferredDone(gate, {
          flowName: Dying._tag,
          executionId: "dies",
          deferredName: gate.name,
          exit: Exit.succeed("late")
        })
        yield* settle
        expect(runs).toBe(1)
        const after = yield* Effect.exit(engine.poll(Dying, "dies"))
        expect(Exit.isFailure(after) && Cause.hasDies(after.cause)).toBe(true)
      }).pipe(Effect.provide(FlowEngine.layerMemory))
    ))

  effect("answers NotWaiting for an annotation on a running, completed, or cancelled execution", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const Annotated = Flow.make("Memory/Annotated", {
          payload: { mode: Schema.Literals(["running", "completed", "cancelled"]) },
          success: Schema.String,
          body: () => {
            throw new Error("registered directly")
          }
        })
        const hold = yield* Deferred.make<void>()
        yield* engine.register(Annotated, (payload) =>
          Effect.gen(function*() {
            yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "attempt-1" })
            const { mode } = payload as { mode: "running" | "completed" | "cancelled" }
            if (mode === "completed") return "done"
            if (mode === "running") {
              yield* Deferred.await(hold)
              return "released"
            }
            const instance = yield* FlowRuntime.FlowInstance
            return yield* Flow.suspend(instance)
          }))
        const complete = (executionId: string) =>
          engine.deferredDoneIfWaiting(gate, {
            flowName: Annotated._tag,
            executionId,
            deferredName: gate.name,
            reason: "approval",
            token: "attempt-1",
            exit: Exit.succeed("answer")
          })
        const recorded = (executionId: string) =>
          engine.deferredResult(gate).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(Annotated, executionId))
          )

        // Running: the body annotated but has not parked, so there is no
        // wait to complete yet. The durable store answers the same way
        // because its waiting row is written when the round parks.
        yield* engine.execute(Annotated, { executionId: "running", payload: { mode: "running" }, discard: true })
        yield* settle
        expect(yield* engine.poll(Annotated, "running")).toEqual(Option.none())
        expect(yield* complete("running")).toBe("NotWaiting")
        expect(Option.isNone(yield* recorded("running"))).toBe(true)
        yield* Deferred.succeed(hold, undefined)
        yield* settle

        // Completed: the annotation outlived the round that made it.
        yield* engine.execute(Annotated, { executionId: "completed", payload: { mode: "completed" }, discard: true })
        const completed = yield* pollComplete(engine.poll(Annotated, "completed"))
        expect(Option.isSome(completed) && completed.value._tag).toBe("Complete")
        expect(yield* complete("completed")).toBe("NotWaiting")
        expect(Option.isNone(yield* recorded("completed"))).toBe(true)

        // Cancelled: the parked wait was overtaken by an interrupt.
        yield* engine.execute(Annotated, { executionId: "cancelled", payload: { mode: "cancelled" }, discard: true })
        expect(Option.isSome(yield* pollSuspended(engine.poll(Annotated, "cancelled")))).toBe(true)
        yield* engine.interrupt(Annotated, "cancelled")
        const cancelled = yield* pollComplete(engine.poll(Annotated, "cancelled"))
        expect(Option.isSome(cancelled) && cancelled.value._tag).toBe("Complete")
        expect(yield* complete("cancelled")).toBe("NotWaiting")
        expect(Option.isNone(yield* recorded("cancelled"))).toBe(true)
      }).pipe(Effect.provide(FlowEngine.layerMemory))
    ))

  effect("wakes a waiting caller within a scheduler turn of the deferred completing", () =>
    Effect.gen(function*() {
      const executionId = "wake-caller"
      const caller = yield* Parked.execute({ id: executionId }, { executionId }).pipe(Effect.forkChild)
      yield* settle
      expect(Option.isSome(yield* pollSuspended(Parked.poll(executionId)))).toBe(true)
      // The caller climbs the default suspended backoff ladder to its 30 s
      // rung while the run stays parked.
      for (let second = 0; second < 60; second++) {
        yield* TestClock.adjust("1 second")
        yield* settle
      }
      expect(caller.pollUnsafe()).toBeUndefined()

      const token = DurableDeferred.tokenFromExecutionId(gate, { flow: Parked, executionId })
      yield* DurableDeferred.succeed(gate, { token, value: "approved" })
      yield* settle
      const polled = yield* Parked.poll(executionId)
      expect(Option.isSome(polled) && polled.value._tag).toBe("Complete")
      // No clock movement since the completion: the caller returned on the
      // wake, not at the end of its backoff sleep.
      expect(caller.pollUnsafe()).toEqual(Exit.succeed("approved"))
    }).pipe(Effect.provide(ParkedLayer)))

  effect("wakes every caller parked on the same execution from one completion", () =>
    Effect.gen(function*() {
      const executionId = "wake-two-callers"
      // Two callers of one idempotency key await the same execution, so both
      // park on the same pending wake. A wake completes the deferred every
      // current subscriber holds, so one completion has to return both: the
      // second caller must not be left on its backoff ladder.
      const first = yield* Parked.execute({ id: executionId }, { executionId }).pipe(Effect.forkChild)
      yield* settle
      const second = yield* Parked.execute({ id: executionId }, { executionId }).pipe(Effect.forkChild)
      yield* settle
      expect(Option.isSome(yield* pollSuspended(Parked.poll(executionId)))).toBe(true)
      expect(first.pollUnsafe()).toBeUndefined()
      expect(second.pollUnsafe()).toBeUndefined()

      const token = DurableDeferred.tokenFromExecutionId(gate, { flow: Parked, executionId })
      yield* DurableDeferred.succeed(gate, { token, value: "approved" })
      yield* settle
      // No clock movement since the completion: both callers returned on the
      // wake, not at the end of a backoff sleep.
      expect(first.pollUnsafe()).toEqual(Exit.succeed("approved"))
      expect(second.pollUnsafe()).toEqual(Exit.succeed("approved"))
    }).pipe(Effect.provide(ParkedLayer)))

  effect("re-arming a scheduled clock keeps the running timer's deadline", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const clock = DurableClock.make({ name: "rearmed", duration: "10 minutes" })
      const read = engine.deferredResult(clock.deferred).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(Parked, "rearm-run"))
      )
      yield* engine.scheduleClock(Parked, { executionId: "rearm-run", clock })
      yield* TestClock.adjust("6 minutes")
      // `DurableClock.sleep` schedules again on every drive of the body, so
      // a re-driven parked run re-arms the same key: the first deadline
      // must stand, or a run polled more often than its sleep never wakes.
      yield* engine.scheduleClock(Parked, { executionId: "rearm-run", clock })
      yield* TestClock.adjust("4 minutes")
      expect(Option.isSome(yield* read)).toBe(true)
    }).pipe(Effect.provide(FlowEngine.layerMemory)))
})
