import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as DurableEngineState from "../src/DurableEngineState.vibe"

// The memory twin's transaction bookkeeping, which the rest of the suite
// reaches without pinning.

describe("memory durable state transactions", () => {
  it.effect("a nested transaction leaves the permit as it found it", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      yield* state.transaction(state.transaction(Effect.void))
      const opened = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let secondStarted = false
      const first = yield* state.transaction(
        Deferred.succeed(opened, undefined).pipe(Effect.andThen(Deferred.await(release)))
      ).pipe(Effect.forkChild)
      yield* Deferred.await(opened)
      const second = yield* state.transaction(Effect.sync(() => {
        secondStarted = true
      })).pipe(Effect.forkChild)
      for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow
      const startedWhileFirstOpen = secondStarted
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(startedWhileFirstOpen).toBe(false)
      expect(secondStarted).toBe(true)
    }))

  it.effect("a rolled-back transaction gives back the parent edge sequence it took", () =>
    Effect.gen(function*() {
      const fresh = DurableEngineState.makeMemory()
      yield* fresh.recordRunParent("child-2", "parent")
      const expected = yield* fresh.runChildren("parent")

      const state = DurableEngineState.makeMemory()
      yield* Effect.exit(state.transaction(
        state.recordRunParent("child-1", "parent").pipe(Effect.andThen(Effect.fail("rolled back")))
      ))
      yield* state.recordRunParent("child-2", "parent")
      expect(yield* state.runChildren("parent")).toEqual(expected)
    }))
})
