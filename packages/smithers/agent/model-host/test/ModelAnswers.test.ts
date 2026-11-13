import { Classifier, Evaluator } from "@smthrs/model"
import { ConfiguredModel } from "@smthrs/rpc"
import { Effect, Schema } from "effect"
import { expect, test } from "vitest"
import { modelAnswersOf } from "./fixtures/durable.ts"

test("classifier answers retain their types, values and distributions on the wire", () => {
  const decodeQuestion = Schema.decodeUnknownSync(Evaluator.Question)
  const questions = Object.fromEntries(
    Object.entries({
      ok: { type: "boolean", instructions: "Did it pass?" },
      which: { type: "choice", instructions: "Which?", criteria: { a: "src/a.ts", b: "src/b.ts" } },
      risk: { type: "score", instructions: "How risky?", criteria: ["low", "mid", "high"] }
    }).map(([id, question]) => [id, decodeQuestion(question)])
  )
  const decoded = Effect.runSync(Classifier.decodeAnswers(questions, {
    ok: { type: "boolean", probability: 0.2 },
    which: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 } },
    risk: { type: "score", score: 1.4, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 } }
  }))
  const answers = modelAnswersOf(questions, decoded)
  expect(answers).toEqual({
    ok: { type: "boolean", value: false, probability: 0.2 },
    which: { type: "choice", value: "b", probabilities: { a: 0.1, b: 0.9 }, confidence: 0.9 },
    risk: {
      type: "score",
      value: 1.4,
      label: "mid",
      probabilities: { low: 0.1, mid: 0.6, high: 0.3 },
      confidence: 0.6
    }
  })
  expect(ConfiguredModel.ModelCallOutputSchema.parse({ kind: "decision", answers })).toEqual({
    kind: "decision",
    answers
  })
})

test("an answer no question names passes through as the classifier gave it", () => {
  const answer = { value: true, probability: 0.4 } as Classifier.Answer
  expect(modelAnswersOf({}, { stray: answer })).toEqual({ stray: answer })
})
