/**
 * Classify flow declaration and portable handler: typed questions about any
 * JSON state, answered by Jev through the `Evaluator` service of
 * `@smthrs/model`.
 *
 * The flow is the cell's door to Jev. A cell hands over one `state` (or up to
 * {@link MAX_STATES} of them under `states`) and a map of questions in the
 * three shapes `Classifier` defines: `boolean`, `choice` over named options,
 * and `score` along an ordered rubric. What comes back is data the cell
 * branches on: an answer per question, its probability or distribution, and a
 * confidence from 0 to 1. No text comes back, which is the point: a judgment
 * that used to cost a model turn costs one call inside the cell that needs it.
 *
 * {@link curated} declares the same door for one classifier a host declared
 * with `Classifier.make`: the input is the classifier's own state schema, the
 * description is the classifier's, and the questions never cross the wire
 * from the cell, so the catalog tells the model exactly what each curated
 * flow judges.
 *
 * Every limit is on the input schema, so an oversized call is refused as
 * `invalid_input` before a transport is reached. A transport failure is a
 * `ClassifierError` carrying the evaluator's own code, which the binding
 * publishes as the refusal message; a batch with at least one answered state
 * keeps every failure beside its state instead.
 *
 * @since 1.0.0
 */
import * as Flow from "@smthrs/core/Flow"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import { capability, envelope } from "./internal/Declaration.ts"

/**
 * Registry name for the ad-hoc classify flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "classify"

/**
 * Model-facing description of the classify flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "Ask Jev typed questions about any JSON state: boolean, choice (named options), or score (ordered rubric). Answers are values with probabilities and confidence, never text. Batch with states."

/**
 * The most states one call may carry.
 *
 * @category limits
 * @since 1.0.0
 */
export const MAX_STATES = 64

/**
 * The most bytes one state may take as JSON.
 *
 * @category limits
 * @since 1.0.0
 */
export const MAX_STATE_BYTES = 32 * 1024

/**
 * How many states of one batch are in flight at once.
 *
 * @category limits
 * @since 1.0.0
 */
export const CONCURRENCY = 8

const encoder = new TextEncoder()

const stateBytes = (state: unknown): number => encoder.encode(JSON.stringify(state)).length

const withinStateBytes = Schema.makeFilter<unknown>(
  (state) => stateBytes(state) <= MAX_STATE_BYTES ? undefined : `a state of at most ${MAX_STATE_BYTES} bytes as JSON`
)

const atLeastOneQuestion = Schema.makeFilter<Readonly<Record<string, unknown>>>(
  (questions) => Object.keys(questions).length > 0 ? undefined : "at least one question"
)

/**
 * One state as the cell hands it over: any JSON value of at most
 * {@link MAX_STATE_BYTES} bytes.
 *
 * @category schemas
 * @since 1.0.0
 */
export const State = Schema.Json.annotate({
  description: "The JSON value the questions are about, at most 32 KiB; returns { answers, confidence, latencyMs }"
}).pipe(Schema.check(withinStateBytes))

/**
 * The questions of one call, keyed by the id each answer comes back under.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Questions = Schema.Record(Schema.String, Classifier.Question).annotate({
  description:
    "Questions keyed by id, each answered under answers[id] with confidence[id] from 0 to 1: { type: \"boolean\", instructions, criteria?: { true, false } } answers { value, probability }; { type: \"choice\", instructions, criteria: { option: meaning } } answers { value, probabilities, confidence }; { type: \"score\", instructions, criteria: [rung, ...] } answers { value, label, probabilities, confidence }"
}).pipe(Schema.check(atLeastOneQuestion))

/**
 * The batch of states one call may carry: between 1 and {@link MAX_STATES}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const States = Schema.Array(State).annotate({
  description:
    "Up to 64 states to judge with the same questions; returns { results: [{ ok: true, state, answers, confidence } | { ok: false, state, error: { code, message } }], latencyMs } in the order given"
}).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_STATES))

/**
 * Input schema for the classify flow: one state, or a batch of them, and the
 * questions to ask about each.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Union([
  Schema.Struct({ state: State, questions: Questions }),
  Schema.Struct({ states: States, questions: Questions })
])

/**
 * Decoded input accepted by the `classify` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

const Confidence = Schema.Record(Schema.String, Schema.Number).annotate({
  description: "How sure each answer is, from 0 to 1, keyed like answers"
})

const Answers = Schema.Record(Schema.String, Classifier.Answer).annotate({
  description:
    "One answer per question id: boolean { value, probability }, choice { value, probabilities, confidence }, score { value, label, probabilities, confidence }"
})

/**
 * What one state's judgment looks like: the answers, their confidence, and
 * the time the transport took.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Verdict = Schema.Struct({
  answers: Answers,
  confidence: Confidence,
  latencyMs: Schema.Int.annotate({ description: "Wall-clock milliseconds the evaluation took" })
})

/**
 * Decoded form of {@link Verdict}.
 *
 * @category models
 * @since 1.0.0
 */
export type Verdict = typeof Verdict.Type

/**
 * One entry of a batch result: the state it is about, and either its answers
 * or the failure that kept them from arriving.
 *
 * @category schemas
 * @since 1.0.0
 */
export const BatchResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    state: Schema.Json.annotate({ description: "The state this entry judges, as it was sent" }),
    answers: Answers,
    confidence: Confidence
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    state: Schema.Json.annotate({ description: "The state this entry judges, as it was sent" }),
    error: Schema.Struct({
      code: Evaluator.EvaluatorErrorCode,
      message: Schema.String
    }).annotate({ description: "Why this state got no answer" })
  })
])

/**
 * Decoded form of {@link BatchResult}.
 *
 * @category models
 * @since 1.0.0
 */
export type BatchResult = typeof BatchResult.Type

/**
 * Output schema for the classify flow: a {@link Verdict} for one state, or
 * one {@link BatchResult} per state, in the order the states were given.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Union([
  Verdict,
  Schema.Struct({
    results: Schema.Array(BatchResult).annotate({ description: "One entry per state, in the order given" }),
    latencyMs: Schema.Int.annotate({ description: "Wall-clock milliseconds the whole batch took" })
  })
])

/**
 * Decoded output returned by the `classify` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static effect envelope for the classify flow: a read of a remote judge,
 * which leaves no durable state behind.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "sealed", mode: "expected", reads: [], writes: [] })

/**
 * Narrows the envelope to one input; classify touches nothing on the tree,
 * so the static envelope is the honest answer for every call.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (_input: Input) => effects

/**
 * Capabilities required by the classify flow. The evaluator calls the gateway
 * as a `model:call`, which is what the kernel HTTP client asks the permission
 * layer for.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("model:call", "*")]

/**
 * Declaration-only classify flow.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

const confidences = (answers: Readonly<Record<string, Classifier.Answer>>): Record<string, number> =>
  Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, Classifier.confidence(answer)]))

/**
 * Asks every question about one state and decodes the raw answers.
 *
 * @category handlers
 * @since 1.0.0
 */
export const ask = (
  evaluator: Evaluator.Evaluator,
  state: unknown,
  questions: Classifier.Questions
): Effect.Effect<Verdict, Classifier.ClassifierError> =>
  Effect.gen(function*() {
    const response = yield* evaluator.evaluate({ state, questions }).pipe(
      Effect.mapError(Classifier.fromEvaluatorError)
    )
    const answers = yield* Classifier.decodeAnswers(questions, response.answers)
    return { answers, confidence: confidences(answers), latencyMs: response.latencyMs }
  })

/**
 * Asks every question about each state, at most {@link CONCURRENCY} in
 * flight, and keeps every result beside its state. When no state at all was
 * answered there is nothing to branch on, so the call fails with the first
 * failure instead, which is how a host without a transport refuses every
 * batch as `unreachable`.
 *
 * @category handlers
 * @since 1.0.0
 */
export const askAll = (
  evaluator: Evaluator.Evaluator,
  states: ReadonlyArray<unknown>,
  questions: Classifier.Questions
): Effect.Effect<Output, Classifier.ClassifierError> =>
  Effect.gen(function*() {
    // The batch reports its own wall clock, the way a single verdict reports
    // the transport's. Without it the only time a caller had was the gap
    // between the call's start and settle events, which the harness publishes
    // in one tick, so every batched classify card read about 1 ms however long
    // the judging actually took.
    const [elapsed, settled] = yield* Effect.timed(Effect.forEach(
      states,
      (state) => Effect.result(ask(evaluator, state, questions)),
      { concurrency: CONCURRENCY }
    ))
    const latencyMs = Math.round(Duration.toMillis(elapsed))
    const results = settled.map((outcome, index): BatchResult => {
      const state = states[index] as Schema.Json
      return Result.isSuccess(outcome)
        ? { ok: true, state, answers: outcome.success.answers, confidence: outcome.success.confidence }
        : { ok: false, state, error: { code: outcome.failure.code, message: outcome.failure.message } }
    })
    const first = settled.find(Result.isFailure)
    if (first !== undefined && results.every((result) => !result.ok)) {
      return yield* Effect.fail(first.failure)
    }
    return { results, latencyMs }
  })

/**
 * Runs the classify flow: one evaluation per state through the bound
 * `Evaluator`, decoded against the questions the cell wrote.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("Classify.run")(function*(
  input: Input
): Effect.fn.Return<Output, Classifier.ClassifierError, Evaluator.Evaluator> {
  const evaluator = yield* Evaluator.Evaluator
  return "state" in input
    ? yield* ask(evaluator, input.state, input.questions)
    : yield* askAll(evaluator, input.states, input.questions)
})

/**
 * What {@link curated} reads off a classifier declared with
 * `Classifier.make`, whatever its state and questions: the structural view
 * that lets classifiers of different shapes share one list.
 *
 * @category models
 * @since 1.0.0
 */
export interface AnyClassifier {
  readonly id: string
  readonly description: string
  readonly state: Schema.Codec<unknown, unknown>
  readonly questions: Classifier.Questions
  readonly digest: string
}

/**
 * The flow declared for one curated classifier: its registry name
 * `classify/<id>`, the declaration, the handler, and the classifier's digest
 * for a binding to fold into the call identity.
 *
 * @category models
 * @since 1.0.0
 */
export interface Curated {
  readonly name: string
  readonly digest: string
  readonly flow: Flow.Flow<CuratedInput, typeof Output>
  readonly run: (input: unknown) => Effect.Effect<Output, Classifier.ClassifierError, Evaluator.Evaluator>
}

/**
 * The input schema of a curated flow: the classifier's state, or a batch of
 * them under `states`. Structural over the state, exactly as
 * {@link AnyClassifier} is, so a host that reads `curated.flow.input` gets
 * the union the binding decodes with.
 *
 * @category models
 * @since 1.0.0
 */
export type CuratedInput = Schema.Union<
  readonly [
    Schema.Struct<{ readonly states: Schema.Codec<ReadonlyArray<unknown>, ReadonlyArray<unknown>> }>,
    Schema.Codec<unknown, unknown>
  ]
>

/**
 * What one answer looks like for a question of each shape, as the cell reads
 * it back: the choice options and score rungs are spelled out so the catalog
 * says which `value` can come back.
 */
const answerShape = (question: Classifier.Question): string =>
  question.type === "boolean"
    ? "boolean { value, probability }"
    : question.type === "choice"
    ? `choice ${Object.keys(question.criteria).join("|")} { value, probabilities, confidence }`
    : `score ${question.criteria.join("<")} { value, label, probabilities, confidence }`

const batchContract =
  "Batch { states: [...] } returns { results: [{ ok: true, state, answers, confidence } | { ok: false, state, error: { code, message } }], latencyMs }."

/**
 * The answer contract of one curated classifier, derived from its declared
 * questions so the catalog can never drift from the ids and shapes a cell
 * reads under `answers`.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const answerContract = (questions: Classifier.Questions): string =>
  `Answers: ${
    Object.entries(questions).map(([id, question]) => `${id} ${answerShape(question)}`).join("; ")
  }. ${batchContract}`

/**
 * The description the catalog shows for one curated state: the classifier's
 * own, when it wrote one, followed by the byte limit every state is held to,
 * so an oversized excerpt is trimmed before the call rather than after a
 * refusal.
 */
const stateDescription = (state: Schema.Codec<unknown, unknown>): string => {
  const own = state.ast.annotations?.description
  const limit = `at most ${MAX_STATE_BYTES} bytes as JSON`
  return typeof own === "string" && own.length > 0 ? `${own}, ${limit}` : `One state to judge, ${limit}`
}

const isBatch = (input: unknown): input is { readonly states: ReadonlyArray<unknown> } =>
  typeof input === "object" && input !== null && Array.isArray((input as { readonly states?: unknown }).states)

const declaresStates = (state: Schema.Top): boolean => {
  const ast = SchemaAST.toEncoded(state.ast)
  return ast._tag === "Objects" && ast.propertySignatures.some((field) => field.name === "states")
}

/**
 * Declares the `classify/<id>` flow for one curated classifier.
 *
 * The input is the classifier's state schema, or `{ states }` for a batch of
 * them, each held to {@link MAX_STATE_BYTES}; the description is the
 * classifier's followed by its {@link answerContract}, so a cell can write
 * `answers.<id>.value` from the catalog alone; the output is the same shape
 * as the ad-hoc flow's. The state
 * is encoded through the classifier's schema before it is sent, exactly as
 * `Classifier.evaluate` encodes it. A state schema that itself declares a
 * `states` field would make the two input shapes indistinguishable, so it is
 * a declaration defect and throws a `TypeError` here.
 *
 * @category constructors
 * @since 1.0.0
 */
export const curated = (classifier: AnyClassifier): Curated => {
  if (declaresStates(classifier.state)) {
    throw new TypeError(
      `Classifier ${classifier.id} declares a state field named "states", which the batch input reserves`
    )
  }
  const name = `classify/${classifier.id}`
  const state: Schema.Codec<unknown, unknown> = classifier.state
    .annotate({ description: stateDescription(classifier.state) })
    .pipe(Schema.check(withinStateBytes))
  const input: CuratedInput = Schema.Union([
    Schema.Struct({
      states: Schema.Array(state).annotate({ description: "Up to 64 states to judge, one result each" }).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(MAX_STATES)
      )
    }),
    state
  ])
  const encode = Schema.encodeEffect(classifier.state)
  const encoded = (value: unknown): Effect.Effect<unknown, Classifier.ClassifierError> =>
    encode(value).pipe(
      Effect.mapError((error) => new Classifier.ClassifierError({ code: "invalid_question", message: error.message }))
    )
  const flow = Flow.make({
    name,
    description: `${classifier.description} ${answerContract(classifier.questions)}`,
    input,
    output: Output,
    capabilities,
    effects
  })
  const run = (value: unknown): Effect.Effect<Output, Classifier.ClassifierError, Evaluator.Evaluator> =>
    Effect.gen(function*() {
      const evaluator = yield* Evaluator.Evaluator
      if (isBatch(value)) {
        const states = yield* Effect.forEach(value.states, encoded)
        return yield* askAll(evaluator, states, classifier.questions)
      }
      return yield* ask(evaluator, yield* encoded(value), classifier.questions)
    })
  return { name, digest: classifier.digest, flow, run }
}
