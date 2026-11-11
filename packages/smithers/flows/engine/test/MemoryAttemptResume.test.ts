/**
 * Issue #4695: the in-memory engine resumes an action's attempt counter at
 * the highest attempt it has a settlement for, so a re-drive replays the
 * recorded attempts without sleeping their backoff ladder again.
 */
import { describe, expect } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { effect, pollUntil } from "./Harness.ts"

describe("a memory re-drive after recovered retries", () => {
  effect("replays the recorded attempts without sleeping their backoff again", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      let executions = 0
      const flaky = Action.make({
        name: "MemoryAttemptResume/flaky",
        success: Schema.Number,
        error: Schema.String,
        retryPolicy: RetryPolicy.make({ initialMs: 1000, factor: 1, maxMs: 1000, maxAttempts: 5 }),
        execute: Effect.suspend(() => {
          executions++
          return executions < 3 ? Effect.fail("transient") : Effect.succeed(executions)
        })
      })
      const Gate = DurableDeferred.make("memory-attempt-resume/gate", { success: Schema.Number })
      const Waits = Flow.make("memory-attempt-resume/waits", {
        payload: {},
        success: Schema.String,
        error: Schema.String,
        body: () => Node.succeed("inert")
      })
      yield* engine.register(Waits, () =>
        Effect.gen(function*() {
          const value = yield* flaky
          const gate = yield* DurableDeferred.await(Gate)
          return `ok@${value}/gate=${gate}`
        }))
      yield* engine.execute(Waits, { executionId: "resume", payload: {}, discard: true })
      const parked = (result: Flow.Result<unknown, unknown>) => result._tag === "Suspended"
      for (let rung = 0; rung < 2; rung++) {
        for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow
        yield* TestClock.adjust(1000)
      }
      const park = yield* pollUntil(Waits.poll("resume"), parked, { turns: 200 })
      expect(Option.isSome(park) && park.value._tag).toBe("Suspended")
      expect(executions).toBe(3)

      // The wake re-drives the body. The clock does not move, so the run can
      // only finish if the two recorded failures replay without a backoff sleep.
      const token = DurableDeferred.tokenFromExecutionId(Gate, { flow: Waits, executionId: "resume" })
      yield* DurableDeferred.succeed(Gate, { token, value: 7 })
      const done = yield* pollUntil(Waits.poll("resume"), (result) => result._tag === "Complete", { turns: 200 })
      expect(Option.isSome(done) && done.value._tag === "Complete" ? done.value.exit : undefined)
        .toEqual(Exit.succeed("ok@3/gate=7"))
      expect(executions).toBe(3)
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory)))
})
