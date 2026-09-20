import { describe, expect, test } from "bun:test"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { decodeModelAnswers } from "@smthrs/rpc/ConfiguredModel"
import type { ModelQuestion } from "@smthrs/rpc/ConfiguredModel"
import { Effect, Exit, Schema } from "effect"
import { modelAnswersOf } from "./ModelProbe"

/*
 * Two decoders, one meaning. The local host decodes a composed decision
 * answer with the real `Classifier.decodeAnswers`; the Worker cannot import
 * the classifier, so it decodes with `decodeModelAnswers` from the contract.
 * This holds the contract's decoder to the classifier's on every shape and
 * every refusal, so a raw answer never reads as two different typed answers
 * depending on which host asked.
 */
const questions: Record<string, ModelQuestion> = {
  ok: { type: "boolean", instructions: "Did it pass?" },
  which: { type: "choice", instructions: "Which?", criteria: { a: "src/a.ts", b: "src/b.ts" } },
  risk: { type: "score", instructions: "How risky?", criteria: ["low", "mid", "high"] },
  digits: { type: "score", instructions: "Numeric labels", criteria: ["1", "0"] }
}
const decodeQuestion = Schema.decodeUnknownSync(Evaluator.Question)
const typed = Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, decodeQuestion(question)]))

const classifier = (raw: unknown) => {
  const exit = Effect.runSyncExit(Classifier.decodeAnswers(typed, raw as Evaluator.RawAnswers))
  return Exit.isSuccess(exit) ? { ok: true as const, answers: modelAnswersOf(typed, exit.value) } : { ok: false as const }
}

const cases: ReadonlyArray<readonly [string, unknown]> = [
  ["every kind, distributions given", {
    ok: { type: "boolean", probability: 0.2 },
    which: { type: "choice", choice: "b", probabilities: { b: 0.9, a: 0.1 } },
    risk: { type: "score", score: 1.4, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 } },
    digits: { type: "score", score: 1, probabilities: { "1": 0.7, "0": 0.3 } }
  }],
  ["every kind, no distributions", {
    ok: { type: "boolean", probability: 0.5 },
    which: { type: "choice", choice: "a" },
    risk: { type: "score", score: 2 },
    digits: { type: "score", score: 0 }
  }],
  ["score distribution keyed by label", {
    ok: { type: "boolean", probability: 1 },
    which: { type: "choice", choice: "a", probabilities: { a: 1 } },
    risk: { type: "score", score: 0, probabilities: { low: 1, mid: 0, high: 0 } },
    digits: { type: "score", score: 1 }
  }],
  ["a partial choice distribution", {
    ok: { type: "boolean", probability: 0.7 },
    which: { type: "choice", choice: "a", probabilities: { a: 0.6 } },
    risk: { type: "score", score: 0 },
    digits: { type: "score", score: 0 }
  }],
  ["a missing answer", { ok: { type: "boolean", probability: 0.7 }, which: { type: "choice", choice: "a" }, risk: { type: "score", score: 0 } }],
  ["an answer of the wrong type", { ok: { type: "choice", choice: "a" }, which: { type: "choice", choice: "a" }, risk: { type: "score", score: 0 }, digits: { type: "score", score: 0 } }],
  ["a probability outside the unit interval", { ok: { type: "boolean", probability: 1.2 }, which: { type: "choice", choice: "a" }, risk: { type: "score", score: 0 }, digits: { type: "score", score: 0 } }],
  ["an option that was not offered", { ok: { type: "boolean", probability: 0.2 }, which: { type: "choice", choice: "c" }, risk: { type: "score", score: 0 }, digits: { type: "score", score: 0 } }],
  ["a score outside the rungs", { ok: { type: "boolean", probability: 0.2 }, which: { type: "choice", choice: "a" }, risk: { type: "score", score: 3 }, digits: { type: "score", score: 0 } }],
  ["a distribution entry outside the unit interval", { ok: { type: "boolean", probability: 0.2 }, which: { type: "choice", choice: "a", probabilities: { a: 2 } }, risk: { type: "score", score: 0 }, digits: { type: "score", score: 0 } }],
  ["a score distribution mixing indexes and labels", { ok: { type: "boolean", probability: 0.2 }, which: { type: "choice", choice: "a" }, risk: { type: "score", score: 0, probabilities: { "0": 1, high: 0 } }, digits: { type: "score", score: 0 } }],
  ["not a map at all", "nonsense"]
]

describe("the contract's answer decoder agrees with the classifier", () => {
  for (const [name, raw] of cases) {
    test(name, () => {
      expect(decodeModelAnswers(questions, raw)).toEqual(classifier(raw))
    })
  }
  test("the fixtures cover both outcomes", () => {
    const outcomes = new Set(cases.map(([, raw]) => classifier(raw).ok))
    expect([...outcomes].sort()).toEqual([false, true])
  })
})
