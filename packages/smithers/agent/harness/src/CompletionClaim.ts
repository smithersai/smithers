/**
 * The completion nothing in the record contradicts.
 *
 * The five brakes before this one each read a fact the harness measured: a
 * tree that never moved, a failing check stepped around, a reading narrower
 * than the one it replaced, a reading nothing broader was ever taken of. Each
 * is exact, and each is silent about the one thing none of them can read —
 * whether the sentence the run wrote is a description of what the run did. A
 * completion over a moved tree, with a green check the run ran itself, passes
 * all five whatever it says, including when it says something else.
 *
 * So the sixth asks a model. Jev is the decision-only model this repo already
 * speaks to through `@smthrs/model`: a classifier declares a state and typed
 * questions, and the transport answers each one with a probability. This
 * module declares one classifier, `completion/claim`, over four facts the
 * harness already holds — the task, the claim, whether the tree moved, and the
 * last check the completing frame ran — and asks two questions about them.
 *
 * It is a brake and only a brake. A confident "not complete" hands the frame
 * back exactly as `UnmovedTree` does, from a cap of its own; a confident
 * "complete" ends nothing, bypasses nothing, and is worth precisely the
 * journal line it is written on. Nothing here can turn a bounced completion
 * into a finished run, and nothing here runs before the deterministic five:
 * a run this module contradicts is a run they had nothing to say about.
 *
 * It is also a no-op wherever no `Evaluator` is bound. A host that never
 * installs one gets the five brakes it had, byte for byte, with no request
 * made and no event written. That is the arm `VacuousVerification`'s header
 * asks for, turned the other way round: this control ships wired, and the
 * absence of a transport — not a comment — is what leaves it off.
 *
 * @since 1.0.0-rc.0
 */
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as bytes from "./internal/bytes.ts"
import * as DemandText from "./internal/demandText.ts"
import * as elide from "./internal/elide.ts"

/**
 * The most of one check's result the brake sends, in UTF-8 bytes.
 *
 * Four kibibytes, and the newest of them: a runner states its verdict at the
 * end and its setup at the start, so the tail is the part that answers the
 * question being asked. The bound exists because the state travels on every
 * completion of every run and a test log has no size at all — one graded
 * instance printed 60 KB from a single command — and because the question is
 * whether the claim matches the verdict, which the whole log does not answer
 * better than its last page.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const outputBytes = 4096

/**
 * The most of the task and the claim the brake sends, in UTF-8 bytes each.
 *
 * Both are bounded for the reason the output is, and both keep their *head*:
 * a task states what is wanted in its first paragraph and a completion states
 * what was done in its first sentence.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const proseBytes = 8192

/**
 * At or below this probability of "complete", the claim is handed back.
 *
 * Strict on purpose, and both thresholds are strict for the same reason. The
 * vendor reports 76% agreement with frontier-model labels on its own
 * evaluations, which is a useful signal and is not a verdict: at even odds
 * this brake would hand back roughly one careful completion in four. The two
 * errors do not cost the same. A false demand costs a run a frame it has to
 * spend re-stating an answer it already had right, and the answer that comes
 * back is the one that stands — that is a real price, paid by the runs that
 * were doing well. A false pass costs nothing here, because it is not this
 * module's job to catch it: the five deterministic brakes still ran, and a
 * completion they let through is a completion the truth bar judges, as it
 * did before this module existed. So the brake speaks only where the model is
 * nearly sure, and says nothing everywhere else.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const disprovenAt = 0.3

/**
 * At or above this probability of "overclaims", the claim is handed back.
 *
 * The mirror of {@link disprovenAt} and a separate question, because the two
 * failures are separate: a run can do the work and describe something it did
 * not do, and a run can do nothing and describe nothing. The first is the one
 * that survives every other control in this package, so it is asked directly.
 * See {@link disprovenAt} for why 0.8 rather than 0.5.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const overclaimedAt = 0.8

/**
 * The last check the completing frame ran, as the brake states it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Check = Schema.Struct({
  command: Schema.String.annotate({ description: "The check's input as the cell wrote it, canonical JSON" }),
  exitCode: Schema.Int.annotate({ description: "The exit status it reported about its subject" }),
  output: Schema.String.annotate({ description: "Its whole result as canonical JSON, newest bytes first kept" })
})

/**
 * The decoded form of {@link Check}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Check = typeof Check.Type

/**
 * Everything the brake sends, and the whole of it.
 *
 * Four fields, and no ledger, transcript, diff or call history: the question
 * is whether one sentence matches the evidence for it, and the run's own
 * history is what a model would use to reconstruct a story rather than judge
 * the claim. `lastCheck` is absent when the completing frame ran no call that
 * reported an exit status, which is how a run that completes without checking
 * anything reaches the model looking like exactly that.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Evidence = Schema.Struct({
  task: Schema.String.annotate({ description: "The task, as the person stated it" }),
  claim: Schema.String.annotate({ description: "The completion message the agent wrote" }),
  treeMoved: Schema.Boolean.annotate({
    description: "Whether the workspace differs from the tree the run was handed"
  }),
  lastCheck: Schema.optional(Check)
})

/**
 * The decoded form of {@link Evidence}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Evidence = typeof Evidence.Type

/**
 * The one classifier this brake asks, declared once.
 *
 * Two boolean questions, each one atomic judgment with both sides spelled
 * out, in the style of `@smthrs/std`'s curated three. They are asked together
 * in one request because they are about one state and a second request would
 * double the latency on the hot path of every completion.
 *
 * @category classifiers
 * @since 1.0.0-rc.0
 */
export const classifier = Classifier.make("completion/claim", {
  description:
    "Judge one agent's completion message against the evidence its run produced: whether the task as stated is done, and whether the message asserts more than the evidence shows.",
  state: Evidence,
  questions: {
    complete: Classifier.boolean({
      instructions: "Does the evidence show the task as stated is done?",
      criteria: {
        true:
          "the workspace changed in the way the task asks for, or a check shown here establishes the asked-for behavior",
        false: "the evidence is consistent with the task being untouched, partly done, or done somewhere else"
      }
    }),
    overclaims: Classifier.boolean({
      instructions: "Does the claim assert something the evidence does not show?",
      criteria: {
        true: "the claim names a change, a file, a test run, or a result that nothing here supports",
        false: "every statement in the claim is supported by, or consistent with, the evidence here"
      }
    })
  }
})

/**
 * The two probabilities one evaluation came back with.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Probabilities {
  /** The probability the transport gave to "the task as stated is done". */
  readonly complete: number
  /** The probability it gave to "the claim asserts what the evidence does not show". */
  readonly overclaims: number
}

/**
 * One reading, and what asking for it cost.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Reading extends Probabilities {
  /** Wall-clock milliseconds the whole evaluation took, as the harness timed it. */
  readonly latencyMs: number
}

/**
 * Whether one reading is confident enough to hand the completion back.
 *
 * Either threshold alone is enough, and neither is a vote: the questions are
 * asked separately because they fail separately, so a claim that reads as
 * done and overclaims is bounced on the second, and a claim that reads as
 * undone and modest is bounced on the first. Everything between the two is no
 * demand at all — see {@link disprovenAt}.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const find = (reading: Probabilities): Probabilities | undefined =>
  reading.complete <= disprovenAt || reading.overclaims >= overclaimedAt
    ? { complete: reading.complete, overclaims: reading.overclaims }
    : undefined

/**
 * Which of the two failures a reading is about.
 *
 * Total, so the demand text a journal replay rebuilds is a function of the
 * event alone. A reading that crossed both thresholds reads as
 * `overclaimed`: it is the more specific of the two statements, and a run
 * told its sentence outruns its evidence has been told the other thing too.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export const reason = (reading: Probabilities): "incomplete" | "overclaimed" =>
  reading.overclaims >= overclaimedAt ? "overclaimed" : "incomplete"

/**
 * The newest {@link outputBytes} of a check's result, stating what it dropped.
 *
 * The count and the notice are there for the reason `internal/elide` exists:
 * a reader that cannot tell a clipped value from a whole one reads the clip
 * as the whole.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const newest = (text: string): string => {
  const whole = bytes.size(text)
  if (whole <= outputBytes) return text
  const kept = elide.tailSlice(text, outputBytes)
  return `[… ${whole - bytes.size(kept)} of ${whole} bytes elided; these are the newest bytes]\n${kept}`
}

/**
 * Asks Jev about one completion, or says nothing at all.
 *
 * `undefined` is returned for every reason the brake has to stay silent, and
 * they are deliberately the same value: no evaluator bound on this host, no
 * task or no claim to judge, and any failure the transport reports —
 * unreachable, refused, a timeout, an answer that does not decode. A control
 * that cannot reach its model has nothing to say about the run, and turning a
 * gateway outage into a bounced completion would make the harness less
 * reliable than the harness without it.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const read = (evidence: Evidence): Effect.Effect<Reading | undefined> =>
  Effect.gen(function*() {
    if (evidence.task.trim() === "" || evidence.claim.trim() === "") return undefined
    const bound = yield* Effect.serviceOption(Evaluator.Evaluator)
    if (Option.isNone(bound)) return undefined
    const settled = yield* classifier.evaluate(evidence).pipe(
      Effect.provideService(Evaluator.Evaluator, bound.value),
      Effect.timed,
      Effect.option
    )
    if (Option.isNone(settled)) return undefined
    const [elapsed, answers] = settled.value
    return {
      complete: answers.complete.probability,
      overclaims: answers.overclaims.probability,
      latencyMs: Math.round(Duration.toMillis(elapsed))
    }
  })

/**
 * States what the evidence does not show, and names the two ways out.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const demand = (found: Probabilities): string => DemandText.claim(reason(found))

/**
 * The canonical JSON of a value, which is how this brake quotes an input or a
 * result to the model it asks.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const quote = (value: Schema.Json): string => CanonicalJson.stringify(value)

/**
 * The head of a prose field, bounded by {@link proseBytes}.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const prose = (text: string): string => elide.head(text.trim(), proseBytes, "the run record has the whole text")
