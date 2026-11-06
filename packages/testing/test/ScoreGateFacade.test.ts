import * as Runtime from "@smthrs/scorers/ScoreGate"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { describe, expect, it } from "vitest"
import * as ScoreGate from "../src/ScoreGate.ts"
import * as TestingError from "../src/TestingError.vibe"

describe("ScoreGate compatibility facade", () => {
  it("shares the runtime functions, error constructor, and schemas by identity", () => {
    expect(ScoreGate.combine).toBe(Runtime.combine)
    expect(ScoreGate.grade).toBe(Runtime.grade)
    expect(ScoreGate.expectScores).toBe(Runtime.expectScores)
    expect(ScoreGate.validateSamples).toBe(Runtime.validateSamples)
    expect(TestingError.ScoreGateError).toBe(Runtime.ScoreGateError)
    expect(TestingError.ScoreGateCode).toBe(Runtime.ScoreGateCode)
    expect(TestingError.InvalidScoreSample).toBe(Runtime.InvalidScoreSample)
  })

  it("raises the same typed error through suite execution", async () => {
    const error = await Effect.runPromise(Effect.flip(ScoreGate.suite({
      cases: [{ name: "first", input: null }],
      run: () => Effect.succeed([]),
      gates: { mean: 2 }
    })))
    expect(error).toBeInstanceOf(TestingError.ScoreGateError)
    expect(error).toBeInstanceOf(Runtime.ScoreGateError)
    expect(error._tag).toBe("ScoreGateError")
    expect(error.code).toBe("invalid_threshold")
    expect(error.threshold).toBe(2)
    expect(error.actual).toBeUndefined()
    expect(error.samples).toBeUndefined()
  })

  it("preserves the ungated suite's empty-evidence policy and reason ordering", async () => {
    const missing = await Effect.runPromise(ScoreGate.suite({
      cases: [{ name: "first", input: null }],
      run: () =>
        Effect.succeed([
          { case: "first", scorer: "quality", stepKey: "one", kind: "inconclusive", reason: "offline" },
          { case: "first", scorer: "quality", stepKey: "two", kind: "inconclusive", reason: "offline" },
          { case: "first", scorer: "safety", stepKey: "three", kind: "inconclusive", reason: "missing rubric" }
        ])
    }))
    expect(missing.verdict).toEqual({
      _tag: "Inconclusive",
      reasons: ["offline", "missing rubric", "The suite produced no score observations"]
    })
    const empty = await Effect.runPromise(ScoreGate.suite({
      cases: [{ name: "first", input: null }],
      run: () => Effect.succeed([])
    }))
    expect(empty.verdict).toEqual({ _tag: "Inconclusive", reasons: ["The suite produced no score observations"] })
  })

  it("retains a runner's self-interruption as an environment fault", async () => {
    const report = await Effect.runPromise(ScoreGate.suite({
      cases: [{ name: "self-interrupted", input: null }],
      run: () => Effect.interrupt
    }))
    expect(report.samples).toEqual([])
    expect(report.cases).toMatchObject([{
      name: "self-interrupted",
      verdict: { _tag: "Inconclusive" },
      samples: []
    }])
    expect(report.verdict._tag).toBe("Inconclusive")
    expect(ScoreGate.ciGrade(report).exitCode).toBe(5)
  })

  it("preserves external interruption instead of grading cancellation as a result", async () => {
    let released = false
    const exit = await Effect.runPromise(Effect.gen(function*() {
      const ready = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(ScoreGate.suite({
        cases: [{ name: "cancelled", input: null }],
        run: () =>
          Effect.andThen(Deferred.succeed(ready, undefined), Effect.never).pipe(
            Effect.ensuring(Effect.sync(() => {
              released = true
            }))
          )
      }))
      yield* Deferred.await(ready)
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.await(fiber)
    }))
    expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(released).toBe(true)
  })
})
