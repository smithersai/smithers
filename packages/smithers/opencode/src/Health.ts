/**
 * The health color of a run: one Jev evaluation per frame, from the server,
 * never from the cell, folded into a dot on the session title.
 *
 * The evaluation reads the facts the projection already holds (the task,
 * the frame, frames since the last edit, the demands issued, the last calls
 * and prints, whether the run is parked) and asks three questions: where
 * the run is, whether it is repeating itself, and whether it needs a person.
 * The color is a pure function of the answers and the facts (`decide`), so
 * the rule has a table test and no transport. The transport is the
 * `Evaluator` of `@smthrs/model`: Jev through the Vercel gateway when
 * `AI_GATEWAY_API_KEY` is set, else one that answers `unreachable`, which
 * the rule renders gray. An evaluation has a deadline and never fails: a
 * transport failure is a gray decision, and the run never waits on it.
 *
 * @since 1.0.0
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Clock, Effect, Layer, Redacted, Schema } from "effect"

/**
 * The state sent to Jev, from design section 3.1.
 *
 * @category schemas
 * @since 1.0.0
 */
export const State = Schema.Struct({
  task: Schema.String,
  frame: Schema.Int,
  maxFrames: Schema.Int,
  framesSinceEdit: Schema.Int,
  demands: Schema.Array(Schema.String),
  lastCalls: Schema.Array(Schema.Struct({ flow: Schema.String, ok: Schema.Boolean, summary: Schema.String })),
  lastPrints: Schema.String,
  parked: Schema.Literals(["none", "permission", "question", "quota"]),
  lastTransition: Schema.Literals(["continue", "complete", "park"])
})

/**
 * The decoded form of {@link State}.
 *
 * @category models
 * @since 1.0.0
 */
export type State = typeof State.Type

/**
 * What the color rule reads: the state Jev sees, plus two harness facts
 * that never leave the server.
 *
 * @category models
 * @since 1.0.0
 */
export interface Facts extends State {
  /** Whether a discipline demand was issued since the last evaluation. */
  readonly demandThisFrame: boolean
  /** The reason a discipline cap ended the run, when one did. */
  readonly capEnded: string | undefined
}

/**
 * The state Jev is sent, off the facts.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toState = (facts: Facts): State => ({
  task: facts.task,
  frame: facts.frame,
  maxFrames: facts.maxFrames,
  framesSinceEdit: facts.framesSinceEdit,
  demands: facts.demands,
  lastCalls: facts.lastCalls,
  lastPrints: facts.lastPrints,
  parked: facts.parked,
  lastTransition: facts.lastTransition
})

/**
 * The curated health classifier, `harness/health`. Declared here and never
 * bound to the cell: the server asks it, the model never does.
 *
 * @category constants
 * @since 1.0.0
 */
export const classifier = Classifier.make("harness/health", {
  description: "Where a Smithers run is, whether it is stuck, and whether it needs a person.",
  state: State,
  questions: {
    progress: Classifier.score({
      instructions: "Where is this run?",
      criteria: ["stuck", "exploring", "progressing", "verifying", "done"]
    }),
    stuck: Classifier.boolean({
      instructions: "Is the run repeating itself or reading without acting?"
    }),
    needsHuman: Classifier.boolean({
      instructions: "Does the run need a person to answer, approve, or decide before it can continue?"
    })
  }
})

/**
 * The typed answers to the three questions.
 *
 * @category models
 * @since 1.0.0
 */
export type Answers = Classifier.AnswersOf<typeof classifier.questions>

/**
 * The four colors.
 *
 * @category models
 * @since 1.0.0
 */
export type Color = "green" | "yellow" | "red" | "gray"

/**
 * The dot each color renders as, prefixed to the session title.
 *
 * @category constants
 * @since 1.0.0
 */
export const dots: Readonly<Record<Color, string>> = { green: "🟢", yellow: "🟡", red: "🔴", gray: "⚪" }

/**
 * A color and the one-line reason for it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Decision {
  readonly color: Color
  readonly reason: string
}

/**
 * The confidence floor under which every answer is disregarded.
 *
 * @category constants
 * @since 1.0.0
 */
export const confidenceFloor = 0.5

/**
 * The deadline over one evaluation, in milliseconds.
 *
 * @category constants
 * @since 1.0.0
 */
export const deadlineMs = 1500

/**
 * Jev's price on the Vercel gateway: dollars per million input tokens,
 * output free, as the research doc records it.
 *
 * @category constants
 * @since 1.0.0
 */
export const jevInputPricePerMillion = 0.042

/**
 * The dollars one evaluation cost, from the usage the gateway reported.
 *
 * @category conversions
 * @since 1.0.0
 */
export const jevCost = (usage: Evaluator.Usage | undefined): number =>
  usage === undefined ? 0 : (usage.inputTokens / 1_000_000) * jevInputPricePerMillion

const percent = (probability: number): string => `${Math.round(probability * 100)}%`

const parkedReason: Readonly<Record<Exclude<State["parked"], "none">, string>> = {
  permission: "waiting for approval",
  question: "waiting for an answer",
  quota: "waiting for quota"
}

/**
 * The color rule, design section 3.3, first match wins. No answers, or no
 * answer at or above the confidence floor, is gray: health is unavailable,
 * and the run is not judged on nothing.
 *
 * @category combinators
 * @since 1.0.0
 */
export const decide = (facts: Facts, answers: Answers | undefined): Decision => {
  if (answers === undefined) return { color: "gray", reason: "health unavailable" }
  const confident = Object.values(answers).some((answer) => Classifier.confidence(answer) >= confidenceFloor)
  if (!confident) return { color: "gray", reason: "health uncertain" }
  if (facts.parked !== "none") return { color: "red", reason: parkedReason[facts.parked] }
  if (facts.capEnded !== undefined) return { color: "red", reason: `stopped: ${facts.capEnded}` }
  if (answers.needsHuman.probability >= 0.7) {
    return { color: "red", reason: `needs you (${percent(answers.needsHuman.probability)})` }
  }
  if (answers.stuck.probability >= 0.6) {
    return { color: "yellow", reason: `repeating itself (${percent(answers.stuck.probability)})` }
  }
  if (answers.progress.value <= 1 && facts.framesSinceEdit >= 4) {
    return { color: "yellow", reason: `${answers.progress.label} · ${facts.framesSinceEdit} frames, no edit yet` }
  }
  if (facts.demandThisFrame) {
    return { color: "yellow", reason: `${facts.demands[facts.demands.length - 1] ?? "discipline"} demanded` }
  }
  return { color: "green", reason: answers.progress.label }
}

/**
 * The color a title carries, read off its leading dot.
 *
 * @category getters
 * @since 1.0.0
 */
export const colorOf = (title: string): Color | undefined => {
  for (const color of Object.keys(dots) as ReadonlyArray<Color>) {
    if (title.startsWith(dots[color])) return color
  }
  return undefined
}

/**
 * The title without its dot.
 *
 * @category conversions
 * @since 1.0.0
 */
export const strip = (title: string): string => {
  const color = colorOf(title)
  return color === undefined ? title : title.slice(dots[color].length).trimStart()
}

/**
 * The title with the color's dot in front of it.
 *
 * @category conversions
 * @since 1.0.0
 */
export const dotted = (title: string, color: Color): string => `${dots[color]} ${strip(title)}`

/**
 * The title a rename produces: the person's words, behind the dot the
 * session already carries unless the person typed one.
 *
 * @category conversions
 * @since 1.0.0
 */
export const retitle = (current: string, wanted: string): string => {
  const color = colorOf(current)
  return color === undefined || colorOf(wanted) !== undefined ? wanted : dotted(wanted, color)
}

/**
 * The record kept per decision, `flows.opencode.health.v1`, so agreement
 * can be scored after the day.
 *
 * @category models
 * @since 1.0.0
 */
export interface Entry {
  readonly type: typeof recordType
  readonly sessionID: string
  readonly messageID: string
  readonly frame: number
  readonly at: number
  readonly color: Color
  readonly reason: string
  readonly answers?: Answers | undefined
  readonly latencyMs: number
  readonly usage?: Evaluator.Usage | undefined
  readonly error?: string | undefined
  readonly state: State
}

/**
 * The record type.
 *
 * @category constants
 * @since 1.0.0
 */
export const recordType = "flows.opencode.health.v1"

/**
 * What one evaluation produced: the decision, the answers when the
 * transport gave any, the time it took, the usage it reported, and the
 * failure when there was one.
 *
 * @category models
 * @since 1.0.0
 */
export interface Evaluation {
  readonly decision: Decision
  readonly answers: Answers | undefined
  readonly latencyMs: number
  readonly usage: Evaluator.Usage | undefined
  readonly error: string | undefined
}

/**
 * One evaluation, within the deadline. Never fails: a transport failure, a
 * malformed answer, or the deadline is a gray decision carrying the error.
 *
 * @param facts what to judge
 * @param deadline the most milliseconds to wait; {@link deadlineMs} by default
 * @category constructors
 * @since 1.0.0
 */
export const evaluate = (
  facts: Facts,
  deadline: number = deadlineMs
): Effect.Effect<Evaluation, never, Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const evaluator = yield* Evaluator.Evaluator
    const started = yield* Clock.currentTimeMillis
    const asked = Effect.gen(function*() {
      const response = yield* evaluator.evaluate({ state: toState(facts), questions: classifier.questions })
      const answers = yield* Classifier.decodeAnswers(classifier.questions, response.answers)
      return { response, answers }
    }).pipe(
      Effect.timeoutOrElse({
        duration: deadline,
        orElse: () =>
          Effect.fail(
            new Evaluator.EvaluatorError({ code: "timeout", message: `Health did not answer within ${deadline} ms` })
          )
      }),
      Effect.result
    )
    const outcome = yield* asked
    const latencyMs = (yield* Clock.currentTimeMillis) - started
    if (outcome._tag === "Failure") {
      return {
        decision: decide(facts, undefined),
        answers: undefined,
        latencyMs,
        usage: undefined,
        error: `${outcome.failure.code}: ${outcome.failure.message}`
      }
    }
    return {
      decision: decide(facts, outcome.success.answers),
      answers: outcome.success.answers,
      latencyMs: outcome.success.response.latencyMs,
      usage: outcome.success.response.usage,
      error: undefined
    }
  })

/**
 * The process environment, named as the host default so a caller that
 * omits an environment says so rather than falling into it.
 *
 * @category constants
 * @since 1.0.0
 */
export const ambientEnvironment = (): Readonly<Record<string, string | undefined>> => process.env

/**
 * The evaluator a host runs with: Jev through the Vercel gateway when
 * `AI_GATEWAY_API_KEY` is set in the environment, else one that answers
 * `unreachable`, so classify calls refuse and health goes gray without a
 * key.
 *
 * @param environment where the key is read from
 * @category layers
 * @since 1.0.0
 */
export const evaluatorLayer = (
  environment: Readonly<Record<string, string | undefined>>
): Layer.Layer<Evaluator.Evaluator> => {
  const key = environment["AI_GATEWAY_API_KEY"]
  return key === undefined || key === ""
    ? Evaluator.layerUnavailable()
    : Evaluator.layerVercelGateway({ apiKey: Redacted.make(key) }).pipe(Layer.provide(NodeHttpClient.layerUndici))
}

/**
 * The one line an answer set renders as on a health card.
 *
 * @category conversions
 * @since 1.0.0
 */
export const renderAnswers = (answers: Answers | undefined): string =>
  answers === undefined
    ? "no answers"
    : [
      `progress: ${answers.progress.label} (${percent(answers.progress.confidence)})`,
      `stuck: ${answers.stuck.value ? "yes" : "no"} (${percent(answers.stuck.probability)})`,
      `needs a person: ${answers.needsHuman.value ? "yes" : "no"} (${percent(answers.needsHuman.probability)})`
    ].join("\n")
