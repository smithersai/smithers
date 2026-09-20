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
import type * as Undici from "@effect/platform-node/Undici"
import type * as HarnessError from "@smthrs/harness/HarnessError"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as EgressHttpClient from "@smthrs/platform-node/EgressHttpClient"
import { Clock, Duration, Effect, Layer, Redacted, Schema } from "effect"
import type * as Scope from "effect/Scope"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as Driver from "./Driver.ts"
import * as RebuildableHttpClient from "./internal/rebuildableHttpClient.ts"

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
 * A usage limit that ended a run: which limit, and the seat that hit it.
 *
 * The limit is named by the provider-neutral `ModelError` code the protocol
 * adapter published, never by the sentence beside it. Provider message text
 * is not a contract and changes without notice, which is the whole reason
 * the codes exist (`@smthrs/model/ModelError`, and the same rule restated in
 * `packages/rpc/src/UpstreamProse.ts`), and a run stopped at a limit is the
 * one failure an operator can act on — so guessing it from the provider's
 * English is the one guess that must not be made here.
 *
 * @category models
 * @since 1.0.0
 */
export interface Limit {
  /** Which limit the seat hit, off `ModelError.code`. */
  readonly code: "quota_exceeded" | "rate_limited"
  /** The seat that hit it, as `provider:model`. */
  readonly seat: string
}

/**
 * The limit a refusal reports, or `undefined` when the refusal is not one:
 * a provider that broke, a bad key, a request the model rejected. Only the
 * two usage codes count, and only from the typed field.
 *
 * @category classification
 * @since 1.0.0
 */
export const limitReached = (failure: Driver.ProviderFailure | undefined): Limit | undefined => {
  if (failure === undefined) return undefined
  return failure.code === "quota_exceeded" || failure.code === "rate_limited"
    ? { code: failure.code, seat: failure.seat }
    : undefined
}

/**
 * The reason a run stopped at a limit renders as, on the dot and the card.
 *
 * @category conversions
 * @since 1.0.0
 */
export const limitReason = (limit: Limit): string =>
  limit.code === "quota_exceeded"
    ? `stopped: ${limit.seat} is out of quota`
    : `stopped: ${limit.seat} is rate limited`

/**
 * The code a run its own frame budget ended reports. It is not a
 * `HarnessError` code because the budget raises no error: the loop stops at
 * the top of the frame it has no budget for and hands the run's last words
 * back as the answer, so nothing fails and there is no code to read off a
 * cause. The projection derives it from the facts instead
 * (`Projection.budgetEnded`).
 *
 * @category constants
 * @since 1.0.0
 */
export const frameBudget = "frame_budget"

/**
 * A run the harness ended, rather than the run ending itself: which thing
 * ended it.
 *
 * A usage limit is {@link Limit} and not this, because the seat's provider
 * ended that one and the operator fixes it at the provider. This is the
 * harness's own vocabulary: a cap it enforces, a judgement it could not get,
 * a claim it refused, a budget it spent.
 *
 * The code is typed and never read off a sentence, the rule 091697c6 states
 * for the limit and the same rule here: `HarnessError.code` is the contract,
 * the sentence beside it is prose.
 *
 * @category models
 * @since 1.0.0
 */
export type Ended =
  /** The frame budget ran out before the run said it was done. */
  | { readonly code: typeof frameBudget; readonly maxFrames: number }
  /** The harness raised, and this is the code it raised with. */
  | { readonly code: HarnessError.HarnessErrorCode }
  /** The turn's body exited with a failure the harness put no code on. */
  | { readonly code: "unknown" }

/**
 * The reason each harness code renders as. Total over
 * `HarnessError.HarnessErrorCode`, so a code the harness adds is a type error
 * here rather than a run that ends with no reason a person can read.
 *
 * @category constants
 * @since 1.0.0
 */
export const endedReasons: Readonly<Record<HarnessError.HarnessErrorCode | "unknown", string>> = {
  assembly_failed: "stopped: the run could not be assembled",
  incompatible_journal: "stopped: the journal is from another version",
  render_failed: "stopped: the frame could not be rendered",
  model_failed: "stopped: the model call failed",
  engine_failed: "stopped: the engine failed",
  read_only_cap: "stopped: the run read for too many frames without writing",
  completion_unjudged: "stopped: nothing could judge the completion",
  claim_unproven: "stopped: the run reported work it never recorded",
  suspended: "stopped: the run suspended",
  unknown: "stopped: the turn failed"
}

/**
 * The reason a run the harness ended renders as, on the dot and the card.
 *
 * Every one of them starts `stopped:`, the way {@link limitReason} does,
 * because that is the word an operator who walked away reads first: the run
 * is not slow, it is over.
 *
 * @category conversions
 * @since 1.0.0
 */
export const endedReason = (ended: Ended): string =>
  ended.code === frameBudget
    ? `stopped: the frame budget of ${ended.maxFrames} is exhausted`
    : endedReasons[ended.code]

/**
 * The reason a turn that answered with nothing to judge it renders as.
 *
 * A turn that resolves in one frame ends before any evaluation answers, so
 * the rule has facts and no answers. Rule 6's second clause is a fact and
 * needs none: the harness handed a completion back, and the turn is over. The
 * color it earned is green and the word for it is this, which does not
 * pretend Jev said `done`.
 *
 * @category constants
 * @since 1.0.0
 */
export const answeredReason = "answered"

/**
 * What the color rule reads: the state Jev sees, plus three harness facts
 * that never leave the server.
 *
 * @category models
 * @since 1.0.0
 */
export interface Facts extends State {
  /** Whether a discipline demand was issued since the last evaluation. */
  readonly demandThisFrame: boolean
  /** The usage limit that ended the run, when the provider's code said one did. */
  readonly stoppedBy: Limit | undefined
  /** What ended the run, when the harness ended it rather than the run. */
  readonly endedBy: Ended | undefined
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
 * How many deadlines in a row Jev may miss before the dot goes gray.
 *
 * A missed deadline is a measurement that did not arrive, not health that is
 * unavailable, so one of them keeps the color the run already had
 * (`Projection.health`). The deadline itself is not the thing that is wrong:
 * Jev answers in about 300 ms end to end (`docs/jev-harness/research.html`),
 * {@link deadlineMs} is five times that, and {@link evaluatorRetry} already
 * gives a blip a second chance inside it. Widening it would move the flicker
 * later and delay every gray that is real. What was wrong is calling one
 * missing measurement "unavailable": on 2026-09-18 that flickered the dot
 * gray mid-run in four of sixteen turns and changed nothing about any of
 * them.
 *
 * Three in a row is a different fact, and it goes gray: a transport that
 * misses three deadlines running is not answering, and a dot that keeps a
 * color nobody has confirmed for three frames is the stale dot this whole
 * rule exists to prevent. Three bounds the staleness to three frames while
 * costing an isolated blip nothing.
 *
 * @category constants
 * @since 1.0.0
 */
export const deadlineMisses = 3

/**
 * The gray reason a run whose health kept missing its deadline renders.
 *
 * @param count how many deadlines were missed in a row
 * @category conversions
 * @since 1.0.0
 */
export const missedDeadlines = (count: number): string =>
  `health unavailable: Jev missed its ${deadlineMs} ms deadline ${count} times running`

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
 * Whether the answers say the run arrived: `done`, at or above the
 * confidence floor. The floor is the same one the whole rule runs on, so an
 * unsure `done` is not an answer the color may be built on.
 *
 * @category predicates
 * @since 1.0.0
 */
export const arrived = (answers: Answers): boolean =>
  answers.progress.label === "done" && answers.progress.confidence >= confidenceFloor

/**
 * The color rule, design section 3.3, first match wins, in three blocks.
 *
 * **The facts, first.** A parked run, a run a usage limit ended, a run the
 * harness itself ended, and a frame the harness issued a demand for are
 * decided whether or not Jev answered: waiting for approval needs no
 * judgment, and neither does a completion the harness handed back.
 *
 * A run the harness ended is red and never gray. Gray is one sentence,
 * "health is unavailable", and an operator who walked away reads it as Jev
 * being down while the run carries on. A run that is over is the opposite of
 * that: nothing is carrying on, and the reason names what ended it
 * ({@link endedReason}) so the next thing to do is on the dot.
 *
 * **Then whether there is an answer at all.** None, or none at or above
 * {@link confidenceFloor}, is gray: health is unavailable and the run is not
 * judged on nothing.
 *
 * **Then the answers, and this order is deliberate.** Needing a person beats
 * everything, because that is the one color an operator has to act on.
 * Arrival beats repetition: a confident `done` ({@link arrived}), or a turn
 * whose last transition was `complete`, is green even when `stuck` is over
 * its threshold, because a run that re-read a file on its way to a correct
 * answer is not stuck. Testing `stuck` first made the rule contradict its
 * own answers: the live drive ended a finished bug fix yellow "repeating
 * itself (69%)" over `progress: done (89%)`, and that was the dot the
 * session kept. Only then repetition, and then a run that has explored four
 * frames without an edit.
 *
 * @category combinators
 * @since 1.0.0
 */
export const decide = (facts: Facts, answers: Answers | undefined): Decision => {
  if (facts.parked !== "none") return { color: "red", reason: parkedReason[facts.parked] }
  if (facts.stoppedBy !== undefined) return { color: "red", reason: limitReason(facts.stoppedBy) }
  if (facts.endedBy !== undefined) return { color: "red", reason: endedReason(facts.endedBy) }
  if (answers === undefined) return { color: "gray", reason: "health unavailable" }
  const confident = Object.values(answers).some((answer) => Classifier.confidence(answer) >= confidenceFloor)
  if (!confident) return { color: "gray", reason: "health uncertain" }
  if (answers.needsHuman.probability >= 0.7) {
    return { color: "red", reason: `needs you (${percent(answers.needsHuman.probability)})` }
  }
  if (facts.demandThisFrame) {
    return { color: "yellow", reason: `${facts.demands[facts.demands.length - 1] ?? "discipline"} demanded` }
  }
  if (arrived(answers) || facts.lastTransition === "complete") {
    return { color: "green", reason: answers.progress.label }
  }
  if (answers.stuck.probability >= 0.6) {
    return { color: "yellow", reason: `repeating itself (${percent(answers.stuck.probability)})` }
  }
  if (answers.progress.value <= 1 && facts.framesSinceEdit >= 4) {
    return { color: "yellow", reason: `${answers.progress.label} · ${facts.framesSinceEdit} frames, no edit yet` }
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
 * The title without its dots. The hosted app echoes a dotted title back with
 * an emoji presentation selector (U+FE0F) after the dot, so the selector and
 * the space that follows it go with the dot.
 *
 * Every leading dot goes, not just the first: a person renaming a session
 * pastes the echoed title back over a dot the app already wrote, so the
 * words can arrive under two or three of them. Dropping one left the rest in
 * the stored words, where `dotted` rendered a title with two dots in it and
 * `colorOf` read a color out of the person's words that the server never
 * decided.
 *
 * @category conversions
 * @since 1.0.0
 */
export const strip = (title: string): string => {
  let rest = title
  for (let color = colorOf(rest); color !== undefined; color = colorOf(rest)) {
    rest = rest.slice(dots[color].length).replace(/^\uFE0F?\s*/, "")
  }
  return rest
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
 * session already carries. A dot at the front of the wanted title is
 * dropped first, with the U+FE0F the hosted app writes after it: the app
 * echoes the dotted title back on a rename, and stored verbatim the echo
 * carried the app's dot in front of the words, so the next color change
 * put a second dot in front of that. The stored title carries the server's
 * dot alone, or none when the session has no color yet. A rename that is
 * empty, or a dot alone, keeps the current title: a session is never left
 * without a name.
 *
 * @category conversions
 * @since 1.0.0
 */
export const retitle = (current: string, wanted: string): string => {
  const words = strip(wanted.trim()).trim()
  if (words === "") return current
  const color = colorOf(current)
  return color === undefined ? words : dotted(words, color)
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
  /**
   * The transport's own code when the evaluation failed, so a caller decides
   * on the code and not on the sentence. `undefined` when it answered.
   */
  readonly code: Evaluator.EvaluatorErrorCode | undefined
  /** Whether the gateway answered this call, judgement or refusal: what makes it a Jev call to count. */
  readonly answered: boolean
}

/**
 * Whether the gateway answered a call, which is what makes it a call to
 * count and not an intention.
 *
 * Only two codes mean nothing came back: `unreachable` is a request the
 * transport could not get an answer to, and `timeout` is one that did not
 * answer in time. Every other code is the gateway's own answer served over
 * HTTP (`refused` carries the status; `empty`, `invalid_answer` and
 * `invalid_question` are all a 200 the answer could not be read out of), so
 * the gateway took the call and the run's footer says so. See
 * `Evaluator.EvaluatorErrorCode`.
 *
 * Structural over the failure, because the two that reach here carry the same
 * code: `Evaluator.EvaluatorError` from the transport, and
 * `Classifier.ClassifierError` from an answer the questions did not accept.
 *
 * @param error what the transport failed with, or nothing when it answered
 * @category predicates
 * @since 1.0.0
 */
export const gatewayAnswered = (
  error: { readonly code: Evaluator.EvaluatorErrorCode } | undefined
): boolean => error === undefined || (error.code !== "unreachable" && error.code !== "timeout")

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
      const decision = decide(facts, undefined)
      return {
        decision: decision.color === "gray"
          ? { color: "gray", reason: unavailable(outcome.failure.message) }
          : decision,
        answers: undefined,
        latencyMs,
        usage: undefined,
        error: `${outcome.failure.code}: ${outcome.failure.message}`,
        code: outcome.failure.code,
        answered: gatewayAnswered(outcome.failure)
      }
    }
    return {
      decision: decide(facts, outcome.success.answers),
      answers: outcome.success.answers,
      latencyMs: outcome.success.response.latencyMs,
      usage: outcome.success.response.usage,
      error: undefined,
      code: undefined,
      answered: true
    }
  })

/**
 * The reason a gray decision carries when the transport failed: the
 * failure's own words behind `health unavailable`, so the card names why
 * and the way out (`set AI_GATEWAY_API_KEY ...` from {@link noGatewayKey}
 * when there is no key, the deadline when Jev was slow) instead of the
 * bare `health unavailable` that said nothing a person could act on.
 *
 * @param message what the transport said
 * @category conversions
 * @since 1.0.0
 */
export const unavailable = (message: string): string =>
  message.startsWith("health unavailable") ? message : `health unavailable: ${message}`

/**
 * The process environment, named as the host default so a caller that
 * omits an environment says so rather than falling into it.
 *
 * @category constants
 * @since 1.0.0
 */
export const ambientEnvironment = (): Readonly<Record<string, string | undefined>> => process.env

/**
 * Whether an environment can give this host a working evaluator:
 * `AI_GATEWAY_API_KEY` set to something. The mirror of
 * {@link evaluatorLayer}, so a caller can ask before it builds, which is
 * what the startup preflight in `EngineDriver.evaluatorRefusal` does. An
 * exported but empty key is no key, the same rule the seat resolver uses.
 *
 * @param environment where the key is read from
 * @category predicates
 * @since 1.0.0
 */
export const evaluatorConfigured = (
  environment: Readonly<Record<string, string | undefined>>
): boolean => (environment["AI_GATEWAY_API_KEY"] ?? "") !== ""

/**
 * How this host retries the evaluator it binds: the requests one evaluation
 * may make, the wait between them, the deadline over each, and the ceiling
 * over all of them together.
 *
 * @category models
 * @since 1.0.0
 */
export interface RetryPolicy {
  /** Requests one evaluation may make, the first one counted. */
  readonly attempts: number
  /** The wait between two requests, in milliseconds. */
  readonly backoffMs: number
  /** The deadline over one request, in milliseconds. */
  readonly deadlineMs: number
  /** The most milliseconds one evaluation may spend, over every request and wait. */
  readonly budgetMs: number
}

/**
 * The retry every gateway evaluation on this host runs under: three
 * requests, 250 ms apart, 2500 ms over each, 8000 ms over all of them.
 *
 * The numbers come from what Jev actually does and what the failure
 * actually is. Jev answers in about 300 ms end to end, of which 163 to 235
 * ms is provider time (`docs/jev-harness/research.html`), so the realistic
 * failure is a blip and not slowness: one 429 from the gateway's rate
 * limiter, one 5xx from a restarting edge, one connection that never
 * opened. A blip fails in milliseconds, so three requests 250 ms apart cost
 * about 750 ms of waiting in the case they exist for, and a fixed wait is
 * enough because the thing being waited out is a restart or a token bucket,
 * neither of which cares about the difference between 250 and 500 ms.
 *
 * `deadlineMs` is 2500, not the 1500 of {@link Evaluator.defaultTimeoutMs}:
 * see {@link evaluatorLayer}. `budgetMs` is 8000, which is exactly three
 * full deadlines plus the two waits between them, so the ceiling never
 * truncates a request that the attempt count allows, and 8 s is the longest
 * a person waits for the brake before the turn fails with the reason. It is
 * a ceiling and not a target: a run that fails fast, which is the case this
 * policy exists for, spends under a second.
 *
 * @category constants
 * @since 1.0.0
 */
export const evaluatorRetry: RetryPolicy = {
  attempts: 3,
  backoffMs: 250,
  deadlineMs: 2500,
  budgetMs: 8000
}

/**
 * Whether a failed evaluation is worth asking again.
 *
 * Three codes are: `unreachable` is a request that never got an answer,
 * `timeout` is one that did not get it in time, and `refused` carrying 429
 * or a 5xx is the gateway saying "not now" rather than "not ever". Nothing
 * else is. `invalid_question` is a question the gateway will reject in the
 * same words every time, `invalid_answer` and `empty` are the wire protocol
 * having changed under us, and `refused` carrying 401 or 403 is a key that
 * a second request will not mend. Asking again for any of those spends a
 * person's seconds to reach the same failure, so the reason reaches them
 * immediately instead.
 *
 * @param error what the transport failed with
 * @category predicates
 * @since 1.0.0
 */
export const retryable = (error: Evaluator.EvaluatorError): boolean => {
  if (error.code === "unreachable" || error.code === "timeout") return true
  if (error.code !== "refused") return false
  return error.status === 429 || (error.status !== undefined && error.status >= 500)
}

/**
 * The same evaluator, asked again when the failure was a blip.
 *
 * The harness's completion brake never falls back: `CompletionClaim.read`
 * fails the whole turn as `completion_unjudged` on any transport failure,
 * by design, so one 429 on the judgement of a task a person waited through
 * used to end that task. `Evaluator.layerVercelGateway` makes one request
 * with one deadline and no retries on purpose, and says the caller decides
 * the retry policy. This host is that caller, so the policy lives here.
 *
 * It decorates the service rather than the layer, and it retries only: the
 * per-request deadline stays where the transport already owns it
 * ({@link RetryPolicy.deadlineMs} is passed to the gateway as its
 * `timeoutMs`), so one number has one owner and a `timeout` reaching this
 * decorator is the transport's own.
 *
 * The last failure is the one that surfaces, so the sentence a person reads
 * names what actually happened on the last request rather than a retry
 * wrapper's paraphrase of it.
 *
 * @param evaluator the transport to ask
 * @param policy the requests, wait, deadline and ceiling; {@link evaluatorRetry} by default
 * @category combinators
 * @since 1.0.0
 */
export const retrying = (
  evaluator: Evaluator.Evaluator,
  policy: RetryPolicy = evaluatorRetry
): Evaluator.Evaluator => {
  const ask = (
    request: Evaluator.Request,
    attempt: number,
    startedAt: number
  ): Effect.Effect<Evaluator.Response, Evaluator.EvaluatorError> =>
    evaluator.evaluate(request).pipe(
      Effect.catch((error) =>
        attempt >= policy.attempts || !retryable(error)
          ? Effect.fail(error)
          : Effect.flatMap(Clock.currentTimeMillis, (now) =>
            // Never start a request the budget cannot also pay the deadline
            // for: the ceiling is a promise about when the answer arrives,
            // and a request cut off mid-flight keeps no promise at all.
            now - startedAt + policy.backoffMs + policy.deadlineMs > policy.budgetMs
              ? Effect.fail(error)
              : Effect.andThen(Effect.sleep(Duration.millis(policy.backoffMs)), ask(request, attempt + 1, startedAt)))
      )
    )
  return Evaluator.Evaluator.of({
    evaluate: (request) => Effect.flatMap(Clock.currentTimeMillis, (started) => ask(request, 1, started))
  })
}

/**
 * The evaluator a host runs with: Jev through the Vercel gateway, under
 * {@link evaluatorRetry}, when `AI_GATEWAY_API_KEY` is set in the
 * environment, else one that answers `unreachable`.
 *
 * The unconfigured arm is still here because a host may hold an evaluator
 * that cannot answer one question, and health renders that gray rather than
 * failing a turn. It is not the arm `smithers opencode` boots on: the
 * harness fails any run whose completion nothing judged, so the verb refuses
 * to start on it. See `EngineDriver.evaluatorRefusal`. That arm is not
 * retried, and must not be: its `unreachable` is a key nobody exported, so
 * three requests and two waits would cost every frame 750 ms to reach the
 * same sentence.
 *
 * The configured arm is the one the whole run shares, so the retry covers
 * both paths that ask it, deliberately:
 *
 * - The completion brake, which has no deadline of its own and inherits the
 *   transport's. That was {@link Evaluator.defaultTimeoutMs}, 1500 ms, a
 *   number chosen for a health dot on a frame and applied by inheritance to
 *   the judgement a whole task ends on. This host passes 2500 ms instead
 *   ({@link RetryPolicy.deadlineMs}), about ten times Jev's measured
 *   answer, which buys the one judgement that matters the room a slow
 *   answer needs without waiting on a transport that is plainly gone.
 * - The health dot, which cannot become slower to fail: {@link evaluate}
 *   puts its own {@link deadlineMs} of 1500 ms over the whole service call,
 *   so a retry runs inside that deadline and a gray dot still arrives
 *   within 1.5 s exactly as before. What changes is only that a blip inside
 *   the deadline now has a second chance to answer, which turns a gray dot
 *   into a real color instead of losing the frame.
 *
 * The gateway client replaces its scoped pool after a transport failure.
 * The next retry or completion acquires a fresh pool before closing the old
 * one, so a destroyed session cannot poison the rest of the server's life.
 *
 * Each pool is acquired through the egress proxy `environment` names. A bare
 * Undici pool ignores `HTTP_PROXY`/`HTTPS_PROXY` and dials the origin
 * directly, which a default-deny host drops: every completion would come
 * back unjudged and the retry above would spend its three requests on it.
 *
 * @param environment where the key and the egress proxy are read from
 * @param dispatcher acquires each pool; tests may supply a scripted dispatcher
 * @category layers
 * @since 1.0.0
 */
export const evaluatorLayer = (
  environment: Readonly<Record<string, string | undefined>>,
  dispatcher: Effect.Effect<Undici.Dispatcher, never, Scope.Scope> = EgressHttpClient.dispatcher(environment)
): Layer.Layer<Evaluator.Evaluator> => {
  const key = environment["AI_GATEWAY_API_KEY"]
  if (key === undefined || key === "") {
    return Layer.succeed(Evaluator.Evaluator)(
      Evaluator.Evaluator.of({
        evaluate: () => Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: noGatewayKey }))
      })
    )
  }
  const gateway = Evaluator.layerVercelGateway({
    apiKey: Redacted.make(key),
    timeoutMs: evaluatorRetry.deadlineMs
  }).pipe(Layer.provide(Layer.effect(
    HttpClient.HttpClient,
    RebuildableHttpClient.make(NodeHttpClient.makeUndici.pipe(
      Effect.provideServiceEffect(NodeHttpClient.Dispatcher, dispatcher)
    ))
  )))
  return retryingLayer(gateway)
}

/**
 * The same evaluator a layer builds, wrapped in {@link retrying}.
 *
 * @param layer the transport to decorate
 * @param policy the requests, wait, deadline and ceiling; {@link evaluatorRetry} by default
 * @category layers
 * @since 1.0.0
 */
export const retryingLayer = (
  layer: Layer.Layer<Evaluator.Evaluator>,
  policy: RetryPolicy = evaluatorRetry
): Layer.Layer<Evaluator.Evaluator> =>
  Layer.effect(
    Evaluator.Evaluator,
    Effect.map(Evaluator.Evaluator, (bound) => retrying(bound, policy))
  ).pipe(Layer.provide(layer))

/**
 * Why every evaluation is refused without a gateway key: what the health
 * card and a refused classify call say, and what to do about it.
 *
 * @category constants
 * @since 1.0.0
 */
export const noGatewayKey = "health unavailable: set AI_GATEWAY_API_KEY to turn on health and classify"

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
