import { type FlowEngineLike, ModelStep } from "@smthrs/agent"
import { Interpreter, RetryPolicy } from "@smthrs/flow"
import { Classifier, Evaluator, type Model, ModelError, ModelProxy } from "@smthrs/model"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { MODEL_ROUTE, quotaRefused } from "../model/contract"
import { type JevFlow, JUDGE_ROLE, SURE_LABEL, SURE_YES_NO, UNSURE, type VerdictCode } from "./contract"
import {
  Classify,
  ClassifyItems,
  type ClassifyPayload,
  Evaluate,
  type EvaluatePayload,
  EvaluateText,
  JudgeFailed,
  type Verdict,
  type Verdicts,
} from "./flows"
import { recordJudgment, withJudgeSpan } from "./metrics"

// What Jev's steps run on (docs/features/jev.md#how-a-judgment-runs): the server's model endpoint, role `judge`, as a
// seat. Each step declares one classifier over its items (`Classifier.make` from `@smthrs/model`), one question per
// item, and asks it through `Evaluator.layerFromSeat`, whose model is `ModelStep.model` from `@smthrs/agent`: so the
// judgment is one sealed model step of the run, keyed by what the endpoint is sent, and a resumed run reads it back.
// The endpoint holds the key, picks the role's model and meters the call; the device never calls a provider.

/** Keep durable model retries, excluding exhausted quota and credit. */
export const MODEL_RETRY = RetryPolicy.make({
  ...ModelStep.defaultRetryPolicy,
  retryable: [
    ...ModelError.ModelErrorCode.literals.filter((code) => !quotaRefused(code)).map((code) => ({ tag: "flows/model/ModelError", code })),
    { tag: "/harness/HarnessError" },
    { tag: "@smthrs/capability/GrantStoreError" },
  ],
})

/** The judge's seat: the model endpoint's `judge` role, read with `ModelProxy`'s client and keyed with its `prepare`. */
export class JudgeSeat extends Context.Service<
  JudgeSeat,
  {
    readonly model: Model.Model
    readonly route: FlowEngineLike.RouteResolver
    /** Host-selected retry timings; omitted uses the durable model step's production policy. */
    readonly retryPolicy?: RetryPolicy.RetryPolicy
  }
>()("@smthrs/mvp/jev/JudgeSeat") {
  /** The `judge` role of the model endpoint on `origin`, through the host's `HttpClient`. */
  static readonly layer = (origin: string) =>
    Layer.effect(
      JudgeSeat,
      Effect.gen(function* () {
        const url = `${origin}${MODEL_ROUTE}/${JUDGE_ROLE}`
        return { model: yield* ModelProxy.makeClient({ url }), route: { prepare: ModelProxy.prepare({ url }) }, retryPolicy: MODEL_RETRY }
      }),
    )
}

/** One verdict and the code the records count it by. */
type Read = readonly [Verdict, VerdictCode]

/** A yes or no that stands at {@link SURE_YES_NO}, else `unsure`. */
const yesNo = (answer: Classifier.BooleanAnswer): Read => {
  const confidence = Classifier.confidence(answer)
  const sure = Classifier.confident(answer, SURE_YES_NO)
  const code: VerdictCode = Option.isNone(sure) ? UNSURE : sure.value ? "yes" : "no"
  return [{ verdict: code, confidence }, code]
}

/** A label that stands at {@link SURE_LABEL}, else `unsure`. */
const labeled = (answer: Classifier.ChoiceAnswer): Read => {
  const confidence = Classifier.confidence(answer)
  const sure = Classifier.confident(answer, SURE_LABEL)
  return Option.isNone(sure) ? [{ verdict: UNSURE, confidence }, UNSURE] : [{ verdict: sure.value, confidence }, "label"]
}

/** The ids the questions are keyed by, `<prefix>1` onwards: the judge reads each question as `<id>: <question>`. */
const idsOf = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`)

/**
 * One judgment: asks `questions` about `state` in one request, through the `judge` seat as one sealed model step named
 * `<flow>/model`, and reads each answer with `read`, in the order of `ids`. A failure is `JudgeFailed` with the judge's
 * code. Counted, logged and traced as `jev.judge` with counts and codes only.
 */
const judge = <A>(
  flow: JevFlow,
  state: typeof Schema.Json.Type,
  ids: ReadonlyArray<string>,
  questions: Readonly<Record<string, Classifier.BooleanQuestion | Classifier.ChoiceQuestion>>,
  read: (answer: A) => Read,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const seat = yield* JudgeSeat
    const model = yield* ModelStep.model({ name: `${flow}/model`, ...seat })
    const classifier = Classifier.make(flow, { description: "One question per item, about the items.", state: Schema.Json, questions })
    const answered = yield* classifier.evaluate(state).pipe(
      Effect.provide(Evaluator.layerFromSeat({ modelId: JUDGE_ROLE, model })),
      Effect.result,
    )
    const durationMs = (yield* Clock.currentTimeMillis) - started
    if (answered._tag === "Failure") {
      const { code } = answered.failure
      yield* recordJudgment({ flow, items: ids.length, outcome: code, codes: [], durationMs })
      return yield* new JudgeFailed({ code })
    }
    const reads = ids.map((id) => read(answered.success[id] as A))
    yield* recordJudgment({ flow, items: ids.length, outcome: "judged", codes: reads.map(([, code]) => code), durationMs })
    return { verdicts: reads.map(([verdict]) => verdict) } satisfies Verdicts
  }).pipe(withJudgeSpan(flow, ids.length))

/** `app/jev/classify/judge`: the question about each item, yes or no, or one of the labels when there are labels. */
export const classify = ({ question, items, labels }: ClassifyPayload) => {
  const ids = idsOf("item", items.length)
  const state = { question, items: Object.fromEntries(ids.map((id, index) => [id, items[index]!])) }
  const instructions = (id: string) => `${id}: ${question}`
  return labels === undefined
    ? judge(
      "app/jev/classify",
      state,
      ids,
      Object.fromEntries(ids.map((id) => [id, Classifier.boolean({ instructions: instructions(id) })])),
      yesNo,
    )
    : judge(
      "app/jev/classify",
      { ...state, labels },
      ids,
      Object.fromEntries(ids.map((id) => [
        id,
        Classifier.choice({
          instructions: instructions(id),
          criteria: Object.fromEntries(labels.map((label) => [label, label])),
        }),
      ])),
      labeled,
    )
}

/** `app/jev/evaluate/judge`: whether the text meets each criterion. */
export const evaluate = ({ text, criteria }: EvaluatePayload) => {
  const ids = idsOf("criterion", criteria.length)
  return judge(
    "app/jev/evaluate",
    { text },
    ids,
    Object.fromEntries(ids.map((id, index) => [
      id,
      Classifier.boolean({ instructions: `${id}: Does the text meet this criterion? ${criteria[index]!}` }),
    ])),
    yesNo,
  )
}

/** Registers `app/jev/classify` and `app/jev/evaluate` with their steps, judging through the host's `JudgeSeat`. */
export const registration = Layer.merge(
  Interpreter.layerWithImplementations(Classify, ClassifyItems.toLayer(classify)),
  Interpreter.layerWithImplementations(Evaluate, EvaluateText.toLayer(evaluate)),
)
