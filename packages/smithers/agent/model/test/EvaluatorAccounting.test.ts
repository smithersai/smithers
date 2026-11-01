import { Deferred, Effect, Fiber, Result, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { describe, expect, it } from "vitest"
import * as Evaluator from "../src/Evaluator.ts"
import * as EvaluatorBackup from "../src/EvaluatorBackup.ts"
import * as Model from "../src/Model.ts"
import { ModelError } from "../src/ModelError.vibe"

const request: Evaluator.Request = {
  state: {},
  questions: { yes: { type: "boolean", instructions: "Ready?" } }
}
const usage = { inputTokens: 12, outputTokens: 3, costUsd: 0.25 }
const paid = { ...usage, modelId: "fixture/judge" }
const failure = (result: Result.Result<Evaluator.Response, Evaluator.EvaluatorError>) => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) throw new Error("Expected failed reading")
  return result.failure
}

describe("evaluator usage isolation", () => {
  it("does not lose streamed usage on a backup transport failure or pay for another reading", async () => {
    let backupCalls = 0
    const judge = EvaluatorBackup.fromModel(
      Model.make({
        stream: () =>
          Stream.concat(
            Stream.make({ type: "usage", ...usage } as const),
            Stream.fail(new ModelError({ code: "transport", message: "fault injection" }))
          )
      }),
      "fixture/judge"
    )
    const fallback = EvaluatorBackup.withFallback(judge, {
      evaluate: () =>
        Effect.sync(() => {
          backupCalls++
          return { answers: {}, latencyMs: 0 }
        })
    })
    const result = await Effect.runPromise(fallback.evaluate(request).pipe(Effect.result))
    expect(failure(result)).toMatchObject({ code: "unreachable", usage: paid })
    expect(backupCalls).toBe(0)
  })

  it("keeps the usage already streamed before a buffered backup times out", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const emitted = yield* Deferred.make<void>()
        const judge = EvaluatorBackup.fromModel(
          Model.make({
            stream: () =>
              Stream.concat(
                Stream.make({ type: "usage", ...usage } as const),
                Stream.fromEffect(Deferred.succeed(emitted, undefined).pipe(Effect.andThen(Effect.never)))
              )
          }),
          "fixture/judge"
        )
        const fiber = yield* judge.evaluate(request).pipe(Effect.result, Effect.forkChild)
        yield* Deferred.await(emitted)
        yield* TestClock.adjust(120_000)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(failure(result)).toMatchObject({ code: "timeout", usage: paid })
  })

  it("starts usage afresh when the same evaluation Effect is run again", async () => {
    const results = await Effect.runPromise(Effect.gen(function*() {
      let calls = 0
      const model = Model.make({
        stream: () =>
          Stream.unwrap(Effect.sync(() =>
            ++calls === 1
              ? Stream.concat(
                Stream.make({ type: "usage", ...usage } as const),
                Stream.fail(new ModelError({ code: "transport", message: "paid" }))
              )
              : Stream.fail(new ModelError({ code: "transport", message: "unpaid" }))
          ))
      })
      return yield* Effect.gen(function*() {
        const evaluator = yield* Evaluator.Evaluator
        const reading = evaluator.evaluate(request).pipe(Effect.result)
        return [yield* reading, yield* reading]
      }).pipe(Effect.provide(Evaluator.layerFromSeat({ modelId: "fixture/judge", model })))
    }))
    expect(failure(results[0]!)).toMatchObject({ usage: paid })
    expect(failure(results[1]!).usage).toBeUndefined()
  })

  it("isolates concurrent executions of one evaluation Effect", async () => {
    const results = await Effect.runPromise(Effect.gen(function*() {
      const emitted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let calls = 0
      const model = Model.make({
        stream: () =>
          Stream.unwrap(Effect.sync(() =>
            ++calls === 1
              ? Stream.concat(
                Stream.make({ type: "usage", ...usage } as const),
                Stream.fromEffect(
                  Deferred.succeed(emitted, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(Effect.fail(new ModelError({ code: "transport", message: "paid" })))
                  )
                )
              )
              : Stream.fail(new ModelError({ code: "transport", message: "unpaid" }))
          ))
      })
      return yield* Effect.gen(function*() {
        const evaluator = yield* Evaluator.Evaluator
        const reading = evaluator.evaluate(request).pipe(Effect.result)
        const first = yield* reading.pipe(Effect.forkChild)
        yield* Deferred.await(emitted)
        const second = yield* reading
        yield* Deferred.succeed(release, undefined)
        return [yield* Fiber.join(first), second]
      }).pipe(Effect.provide(Evaluator.layerFromSeat({ modelId: "fixture/judge", model })))
    }))
    expect(failure(results[0]!)).toMatchObject({ usage: paid })
    expect(failure(results[1]!).usage).toBeUndefined()
  })
})
