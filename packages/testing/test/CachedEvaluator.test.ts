import { describe, expect, it } from "@effect/vitest"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Option, Ref } from "effect"
import * as CachedEvaluator from "../src/CachedEvaluator.vibe"
import type * as CachedModel from "../src/CachedModel.vibe"
import * as FixtureStore from "../src/FixtureStore.ts"

const questions = {
  complete: { type: "boolean", instructions: "Is the change complete?", criteria: { true: "yes", false: "no" } },
  route: {
    type: "choice",
    instructions: "Where does the TODO go?",
    criteria: { implement: "Write code.", none: "Do nothing." }
  }
} as unknown as Readonly<Record<string, Evaluator.Question>>

const request: Evaluator.Request = { state: { todo: "Add a greeting" }, questions }

const answered: Evaluator.Response = {
  answers: {
    complete: { type: "boolean", probability: 0.97 },
    route: { type: "choice", choice: "implement", probabilities: { implement: 0.9, none: 0.1 } }
  },
  confidence: { route: 0.9 },
  usage: { inputTokens: 120, outputTokens: 4, modelId: "typesafe-ai/jev" },
  latencyMs: 812
}

/** A live evaluator that counts its calls and answers `outcome`. */
const counting = (outcome: Effect.Effect<Evaluator.Response, Evaluator.EvaluatorError>) =>
  Effect.gen(function*() {
    const calls = yield* Ref.make(0)
    const live: Evaluator.Evaluator = { evaluate: () => Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(outcome)) }
    return { live, count: () => Ref.get(calls) }
  })

describe("CachedEvaluator", () => {
  it.effect("records a miss as one call in the model fixture and replays it without the live evaluator", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const live = yield* counting(Effect.succeed(answered))
      const recorded = yield* CachedEvaluator.make({ live: live.live, fixture }).evaluate(request)
      expect(recorded.answers).toEqual(answered.answers)
      const calls = Option.getOrThrow(yield* fixture.load()).calls
      expect(calls).toHaveLength(1)
      expect(calls[0]!.model).toBe(Evaluator.defaultModel)
      expect(calls[0]!.request.messages[0]!.role).toBe("user")
      const again = yield* CachedEvaluator.make({ live: live.live, fixture }).evaluate(request)
      expect(yield* live.count()).toBe(1)
      const replayed = yield* CachedEvaluator.make({ fixture }).evaluate(request)
      // Timing is the recording's own; a replay reports what was answered.
      for (const response of [again, replayed]) {
        expect(response).toEqual({
          answers: answered.answers,
          confidence: answered.confidence,
          usage: answered.usage,
          latencyMs: 0
        })
      }
    }))

  it.effect("keys on the evaluation model, the state and the questions", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const live = yield* counting(Effect.succeed({ answers: answered.answers, latencyMs: 1 }))
      yield* CachedEvaluator.make({ live: live.live, fixture }).evaluate(request)
      yield* CachedEvaluator.make({ live: live.live, fixture, modelId: "other/judge" }).evaluate(request)
      yield* CachedEvaluator.make({ live: live.live, fixture }).evaluate({ ...request, state: { todo: "Other" } })
      expect(yield* live.count()).toBe(3)
      const bare = yield* CachedEvaluator.make({ fixture }).evaluate(request)
      expect(bare).toEqual({ answers: answered.answers, latencyMs: 0 })
    }))

  it.effect("keys a judgment on its normalized state, and asks the live evaluator the original", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const states: Array<unknown> = []
      const live: Evaluator.Evaluator = {
        evaluate: (asked) => Effect.sync(() => states.push(asked.state)).pipe(Effect.as({ ...answered, latencyMs: 1 }))
      }
      const normalize: CachedModel.Options["normalize"] = (recorded) => ({
        ...recorded,
        messages: recorded.messages.map((message) =>
          message.role === "user"
            ? {
              ...message,
              content: message.content.map((part) => ({ ...part, text: part.text.replace(/run-\d+/g, "run") }))
            }
            : message
        )
      })
      yield* CachedEvaluator.make({ live, fixture, normalize }).evaluate({ state: { dir: "/tmp/run-1" }, questions })
      const replayed = yield* CachedEvaluator.make({ fixture, normalize }).evaluate({
        state: { dir: "/tmp/run-2" },
        questions
      })
      expect(replayed.answers).toEqual(answered.answers)
      expect(states).toEqual([{ dir: "/tmp/run-1" }])
    }))

  it.effect("records a failure and replays it as the same evaluator error", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const refusal = new Evaluator.EvaluatorError({
        code: "refused",
        status: 429,
        resetAtEpochMillis: 1_800_000_000_000,
        message: "The gateway answered 429"
      })
      const live = yield* counting(Effect.fail(refusal))
      const first = yield* CachedEvaluator.make({ live: live.live, fixture }).evaluate(request).pipe(Effect.flip)
      const replayed = yield* CachedEvaluator.make({ fixture }).evaluate(request).pipe(Effect.flip)
      for (const error of [first, replayed]) {
        expect(error).toBeInstanceOf(Evaluator.EvaluatorError)
        expect({ code: error.code, status: error.status, reset: error.resetAtEpochMillis, message: error.message })
          .toEqual({ code: "refused", status: 429, reset: 1_800_000_000_000, message: "The gateway answered 429" })
      }
      const bare = yield* counting(Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "late" })))
      const other = yield* FixtureStore.makeMemory()
      yield* CachedEvaluator.make({ live: bare.live, fixture: other }).evaluate(request).pipe(Effect.flip)
      const late = yield* CachedEvaluator.make({ fixture: other }).evaluate(request).pipe(Effect.flip)
      expect({ code: late.code, status: late.status, reset: late.resetAtEpochMillis })
        .toEqual({ code: "timeout", status: undefined, reset: undefined })
      // A hand-edited recorded code no evaluator raises reads as unreachable.
      const [call] = Option.getOrThrow(yield* other.load()).calls
      const forged = yield* FixtureStore.makeMemory({
        calls: [{ ...call!, failure: { ...call!.failure!, providerCode: "bogus" } }]
      })
      expect((yield* CachedEvaluator.make({ fixture: forged }).evaluate(request).pipe(Effect.flip)).code).toBe(
        "unreachable"
      )
    }))

  it.effect("dies on a miss when it has no live evaluator", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const exit = yield* CachedEvaluator.make({ fixture }).evaluate(request).pipe(Effect.exit)
      expect(String(exit)).toContain("UnscriptedModelError")
    }))

  it.effect("dies on a recording that is not an evaluation", () =>
    Effect.gen(function*() {
      const live = yield* counting(Effect.succeed(answered))
      const fixture = yield* FixtureStore.makeMemory()
      yield* CachedEvaluator.make({ live: live.live, fixture }).evaluate(request)
      const [call] = Option.getOrThrow(yield* fixture.load()).calls
      for (
        const events of [
          [{ type: "text-delta" as const, id: "t", text: "not json" }],
          [{ type: "text-delta" as const, id: "t", text: "{\"answers\":7}" }],
          []
        ]
      ) {
        const forged = yield* FixtureStore.makeMemory({ calls: [{ ...call!, events }] })
        const exit = yield* CachedEvaluator.make({ fixture: forged }).evaluate(request).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }
    }))

  it.effect("refuses a state that is not JSON before recording anything", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureStore.makeMemory()
      const live = yield* counting(Effect.succeed(answered))
      const error = yield* CachedEvaluator.make({ live: live.live, fixture })
        .evaluate({ state: { at: new Date(0) }, questions })
        .pipe(Effect.flip)
      expect(error.code).toBe("invalid_question")
      expect(yield* live.count()).toBe(0)
      expect(Option.isNone(yield* fixture.load())).toBe(true)
    }))

  it.effect("provides the cached evaluator as the Evaluator seam", () =>
    Effect.gen(function*() {
      const live = yield* counting(Effect.succeed(answered))
      const fixture = yield* FixtureStore.makeMemory()
      const response = yield* Effect.flatMap(Evaluator.Evaluator, (evaluator) => evaluator.evaluate(request))
        .pipe(Effect.provide(CachedEvaluator.layer({ live: live.live, fixture })))
      expect(response.answers).toEqual(answered.answers)
    }))
})
