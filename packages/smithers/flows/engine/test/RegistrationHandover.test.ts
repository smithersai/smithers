/**
 * A memory engine's round whose registration closes while another
 * registration of the same flow tag is still open. The round is stopped, so
 * the closed handler never runs after its scope is gone, and the execution is
 * driven again on the latest still-open registration. Its callers follow that
 * drive instead of seeing an interruption.
 */
import { describe, expect } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { effect, pollUntil } from "./Harness.ts"

const makeFlow = (name: string) =>
  Flow.make(`RegistrationHandover/${name}`, {
    payload: {},
    success: Schema.String,
    body: () => Node.succeed("declaration")
  })

/** A handler that records its drive, signals `started`, and answers `name` once `release` opens. */
const blocking = (
  name: string,
  drives: Array<string>,
  started: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>
) =>
() =>
  Effect.gen(function*() {
    drives.push(name)
    yield* Deferred.succeed(started, undefined)
    yield* Deferred.await(release)
    return name
  })

const isInterruptedOnly = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)

describe("a registration closing under a running round", () => {
  effect("hands the round to the outer registration, and the caller completes", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const Shared = makeFlow("outer-open")
      const drives: Array<string> = []
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* engine.register(Shared, blocking("outer", drives, started, release))
      const inner = yield* Scope.make()
      yield* engine.register(Shared, blocking("inner", drives, started, release)).pipe(Scope.provide(inner))
      const caller = yield* Shared.execute({}, { executionId: "outer-open" }).pipe(Effect.exit, Effect.forkChild)
      const joiner = yield* Shared.execute({}, { executionId: "outer-open" }).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(started)
      expect(drives).toEqual(["inner"])
      yield* Scope.close(inner, Exit.void)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(caller)).toEqual(Exit.succeed("outer"))
      expect(yield* Fiber.join(joiner)).toEqual(Exit.succeed("outer"))
      expect(drives).toEqual(["inner", "outer"])
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory)))

  effect(
    "never starts the closed handler for a round forked before its registration closed",
    () =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const Shared = makeFlow("unstarted")
        const drives: Array<string> = []
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* Deferred.succeed(release, undefined)
        yield* engine.register(Shared, blocking("outer", drives, started, release))
        const inner = yield* Scope.make()
        yield* engine.register(Shared, blocking("inner", drives, started, release)).pipe(Scope.provide(inner))
        yield* Shared.execute({}, { executionId: "unstarted", discard: true })
        yield* Scope.close(inner, Exit.void)
        const result = yield* pollUntil(Shared.poll("unstarted"), (result) => result._tag === "Complete", {
          turns: 200
        })
        expect(Option.isSome(result) && result.value._tag === "Complete" && result.value.exit).toEqual(
          Exit.succeed("outer")
        )
        expect(drives).toEqual(["outer"])
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
  )

  effect(
    "parks the execution with no registration left, then completes once the flow registers again",
    () =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const Shared = makeFlow("parked")
        const drives: Array<string> = []
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const only = yield* Scope.make()
        yield* engine.register(Shared, blocking("closed", drives, started, release)).pipe(Scope.provide(only))
        const caller = yield* Shared.execute({}, { executionId: "parked" }).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(started)
        yield* Scope.close(only, Exit.void)
        const parked = yield* pollUntil(Shared.poll("parked"), (result) => result._tag === "Suspended", { turns: 200 })
        expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
        expect(caller.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        yield* engine.register(Shared, blocking("again", drives, started, release))
        // The caller's elapsed poll re-drives the parked run on the new registration.
        yield* TestClock.adjust("1 minute")
        expect(yield* Fiber.join(caller)).toEqual(Exit.succeed("again"))
        expect(drives).toEqual(["closed", "again"])
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
  )

  effect(
    "still cancels a round whose cancellation is settling when its registration closes",
    () =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const Shared = makeFlow("cancelled")
        const drives: Array<string> = []
        const started = yield* Deferred.make<void>()
        const cleaning = yield* Deferred.make<void>()
        const cleaned = yield* Deferred.make<void>()
        yield* engine.register(Shared, () => Effect.sync(() => "outer"))
        const inner = yield* Scope.make()
        yield* engine.register(Shared, () =>
          Effect.gen(function*() {
            drives.push("inner")
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(
            Effect.onInterrupt(() => Effect.andThen(Deferred.succeed(cleaning, undefined), Deferred.await(cleaned)))
          )).pipe(Scope.provide(inner))
        const caller = yield* Shared.execute({}, { executionId: "cancelled" }).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(started)
        yield* engine.interrupt(Shared, "cancelled")
        yield* Deferred.await(cleaning)
        const closing = yield* Effect.forkChild(Scope.close(inner, Exit.void), { startImmediately: true })
        // The close waits on the body its handler is still cleaning up.
        expect(closing.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(cleaned, undefined)
        yield* Fiber.join(closing)
        expect(isInterruptedOnly(yield* Fiber.join(caller))).toBe(true)
        const polled = yield* Shared.poll("cancelled")
        expect(Option.isSome(polled) && polled.value._tag === "Complete" && isInterruptedOnly(polled.value.exit))
          .toBe(true)
        expect(drives).toEqual(["inner"])
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
  )

  effect("cancels a handed-over round when cancellation follows the hand-over", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const Shared = makeFlow("cancelled-after")
      const drives: Array<string> = []
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* engine.register(Shared, blocking("outer", drives, started, release))
      const inner = yield* Scope.make()
      yield* engine.register(Shared, blocking("inner", drives, started, release)).pipe(Scope.provide(inner))
      const caller = yield* Shared.execute({}, { executionId: "cancelled-after" }).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(started)
      yield* Scope.close(inner, Exit.void)
      yield* pollUntil(Shared.poll("cancelled-after"), () => false, { turns: 50 })
      expect(drives).toEqual(["inner", "outer"])
      yield* engine.interrupt(Shared, "cancelled-after")
      expect(isInterruptedOnly(yield* Fiber.join(caller))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory)))

  effect(
    "does not tell a waiting parent its child completed when the child is handed over",
    () =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const Child = makeFlow("child")
        const Parent = makeFlow("parent")
        const drives: Array<string> = []
        const seen: Array<Exit.Exit<string, unknown>> = []
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* engine.register(Parent, () =>
          Effect.gen(function*() {
            drives.push("parent")
            const exit = yield* Effect.exit(Effect.orDie(Child.execute({}, { executionId: "child" })))
            seen.push(exit)
            return yield* exit
          }))
        yield* engine.register(Child, blocking("outer", drives, started, release))
        const inner = yield* Scope.make()
        yield* engine.register(Child, blocking("inner", drives, started, release)).pipe(Scope.provide(inner))
        const caller = yield* Parent.execute({}, { executionId: "parent" }).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(started)
        yield* Scope.close(inner, Exit.void)
        yield* pollUntil(Child.poll("child"), () => false, { turns: 50 })
        expect(seen).toEqual([])
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(caller)).toEqual(Exit.succeed("outer"))
        expect(seen).toEqual([Exit.succeed("outer")])
        expect(drives.filter((drive) => drive !== "parent")).toEqual(["inner", "outer"])
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
  )
})
