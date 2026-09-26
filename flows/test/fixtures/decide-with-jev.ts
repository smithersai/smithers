import { Action } from "@smthrs/flow"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Option, Schema } from "effect"

const Items = Schema.Struct({ task: Schema.String, items: Schema.Array(Schema.String) })
const key = (index: number) => `item${index}`

/** One classifier over every item: one question per item, asked in one request. */
const perItem = <Q extends Classifier.Questions[string]>(items: ReadonlyArray<string>, question: (item: string) => Q) =>
  Classifier.make("example/per-item", {
    description: "Judge each item against the task.",
    state: Items,
    questions: Object.fromEntries(items.map((item, index) => [key(index), question(item)])) as Record<string, Q>
  })

export const Keep = Action.make("example/keep", {
  payload: Items,
  success: Schema.Array(Schema.String),
  error: Classifier.ClassifierError,
  nondeterministic: true
})

export const Rank = Action.make("example/rank", {
  payload: Items,
  success: Schema.Array(Schema.String),
  error: Classifier.ClassifierError,
  nondeterministic: true
})

/** Boolean: keep an item only when Jev says yes at 0.8 or better. */
export const keep = (state: typeof Items.Type) =>
  Effect.gen(function*() {
    const needed = perItem(state.items, (item) => Classifier.boolean({ instructions: `Does the task need ${item}?` }))
    const answers = yield* needed.evaluate(state)
    return state.items.filter((_, index) =>
      Option.getOrElse(Classifier.confident(answers[key(index)]!, 0.8), () => false)
    )
  })

/** Choice or score: read the provider's own confidence, at 0.7 or better. */
export const rank = (state: typeof Items.Type) =>
  Effect.gen(function*() {
    const relevance = perItem(
      state.items,
      (item) => Classifier.score({ instructions: `How relevant is ${item}?`, criteria: ["none", "some", "high"] })
    )
    const response = yield* (yield* Evaluator.Evaluator)
      .evaluate({ state, questions: relevance.questions })
      .pipe(Effect.mapError(Classifier.fromEvaluatorError))
    const answers = yield* Classifier.decodeAnswers(relevance.questions, response.answers)
    const sure = state.items.flatMap((item, index) =>
      (response.confidence?.[key(index)] ?? 0) >= 0.7 ? [{ item, score: answers[key(index)]!.value }] : []
    )
    return sure.sort((a, b) => b.score - a.score).map((ranked) => ranked.item)
  })

export const JudgeLive = Layer.mergeAll(Keep.toLayer(keep), Rank.toLayer(rank))
