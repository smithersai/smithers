/** Jev screens every inbound event before a frontier model reads a word of it.
 * The screen is `@smthrs/harness/Intake`; this module journals its decision
 * and fails the job when it refuses. */
import { FlowRuntime } from "@smthrs/flow"
import * as Intake from "@smthrs/harness/Intake"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Option, type Schema } from "effect"
import * as Journal from "../../../packages/smithers/flows/journal/src/Journal.ts"
import * as JournalEvent from "../../../packages/smithers/flows/journal/src/JournalEvent.ts"
import { CodingError } from "../coding/schema.ts"
import type { Event, IntakeScreening } from "./schema.ts"

/** The step whose decision the journal event records. It runs inside the
 * recorded, nondeterministic `repository/capture-job` action, so its answers
 * are captured once with the evidence and a replay reuses them rather than
 * asking Jev again. */
export const intakeScreenStep = "repository/intake-screen"
/** The journal event one screened event writes. */
export const intakeScreenedEvent = "flows.repository.intake-screened.v1"
export const {
  ignoreConfidence,
  injectionProbability,
  maximumStateBytes,
  maximumStates,
  withheldPlaceholder
} = Intake

/** The texts of an event's payload, as {@link Intake.texts} reads them. */
export const intakeTexts = (payload: unknown) => Intake.texts("", payload)

/** The evaluator a host without one screens with: every text unanswered. */
const unconfigured = Layer.succeed(Evaluator.Evaluator)(
  Evaluator.Evaluator.of({
    evaluate: () =>
      Effect.fail(
        new Evaluator.EvaluatorError({ code: "unreachable", message: "No evaluator is installed on this host" })
      )
  })
)

/** The one record a screened event writes, on the journal's lossy channel and
 * only when the composition has a journal at all. */
const record = (runId: string, payload: Record<string, unknown>): Effect.Effect<void> =>
  Effect.gen(function*() {
    const journal = yield* Effect.serviceOption(Journal.Journal)
    if (Option.isNone(journal)) return
    yield* journal.value.emitLossy(
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(runId),
        sourceId: JournalEvent.SourceId.make("/repository/intake"),
        eventType: intakeScreenedEvent,
        payload
      })
    ).pipe(Effect.ignore)
  })

export interface ScreenedEvent {
  /** The event payload every later step reads, with any withheld text replaced. */
  readonly payload: Schema.Json
  readonly screening: typeof IntakeScreening.Type
}

/**
 * Screens one inbound event's text with {@link Intake.screen} and journals
 * the decision.
 *
 * A text nobody screened is a text no model may read, so a refusal fails the
 * job with a typed {@link CodingError}: `invalid_request` for an event over
 * the screen's bounds, `unavailable` for an evaluator that is unconfigured,
 * refused, malformed or out of time. An event with no author text asks
 * nothing and journals nothing.
 */
export const screenEvent = (
  input: { readonly repo: string; readonly event: typeof Event.Type; readonly payload: unknown }
): Effect.Effect<ScreenedEvent, CodingError> =>
  Effect.gen(function*() {
    const evaluator = yield* Effect.serviceOption(Evaluator.Evaluator)
    const result = yield* Intake.screen(input.repo, input.payload).pipe(
      Effect.provide(Option.isSome(evaluator) ? Layer.succeed(Evaluator.Evaluator)(evaluator.value) : unconfigured),
      Effect.result
    )
    const { screening, coverage } = result._tag === "Success" ? result.success : result.failure
    // A push, a schedule or a manual dispatch carries no author text: no
    // decision was made, so none is journaled.
    if (coverage.totalTexts === 0) return { payload: input.payload as Schema.Json, screening }
    const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
    yield* record(Option.isSome(instance) ? instance.value.executionId : input.event.deliveryKey, {
      step: intakeScreenStep,
      repo: input.repo,
      classifier: Intake.classifier.id,
      questions: Intake.classifier.digest,
      event: {
        source: input.event.source,
        type: input.event.type,
        action: input.event.action,
        deliveryKey: input.event.deliveryKey
      },
      thresholds: { ignoreConfidence, injectionProbability },
      coverage,
      action: screening.action,
      answers: screening.answers,
      ...(screening.reason === undefined ? {} : { reason: screening.reason })
    })
    if (result._tag === "Failure") {
      return yield* Effect.fail(
        new CodingError({
          code: result.failure.incomplete ? "invalid_request" : "unavailable",
          message: `Jev could not screen this event: ${screening.reason}`
        })
      )
    }
    return { payload: result.success.payload, screening }
  })
