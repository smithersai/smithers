/** The repository's prompt entry composes existing planning and correction flows. */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Option, Schema } from "effect"
import { CorrectPlan } from "./correction.ts"
import { PrepareWithWiki } from "./planning-wiki.ts"
import { CodingError, PlanningInput, RequestInput, RequestResult } from "./schema.ts"
export { RequestInput } from "./schema.ts"
import { AdmitSource } from "./source-admission.ts"
import { Poc } from "./poc.ts"
import { appendFeedback, FeedbackReceipt, ReceiveFeedback } from "./steering.ts"

const maximumPlanningPasses = 8
/** Private durable cursor. Notification bodies and provenance stay in the
 * existing action receipts; the planner receives their bounded rendered text. */
const Cursor = Schema.Struct({ ...PlanningInput.fields,
  maxRounds: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(8)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(maximumPlanningPasses))
})
const MergeFeedback = Action.make("coding/merge-request-feedback", {
  payload: { cursor: Cursor, receipt: FeedbackReceipt, advance: Schema.Boolean },
  success: Cursor, error: CodingError
})

type CoordinateFlow = Flow.Flow<"coding/CoordinateRequest", typeof Cursor, typeof RequestResult,
  typeof PrepareWithWiki.errorSchema,
  Action.Requirement<(typeof MergeFeedback | typeof ReceiveFeedback | typeof AdmitSource)["name"]>>

/** Each trampoline pass refreshes wiki/source evidence before planning. A
 * message during mutation waits for correction to settle; it never mutates
 * a running plan or preempts a writer. The POC runs once per request. */
const Coordinate: CoordinateFlow = Flow.make("coding/CoordinateRequest", {
  payload: Cursor, success: RequestResult, error: PrepareWithWiki.errorSchema,
  maxRounds: maximumPlanningPasses,
  body: cursor => PrepareWithWiki.child({ prompt: cursor.prompt, feedback: cursor.feedback }).pipe(
    // bindPlanned exposes a reference and permits independent descendants.
    // Explicit sequencing makes each entire feedback subtree wait for the
    // referenced producer, even though the drain payload is only a boundary.
    Node.bindPlanned(plan => Node.succeed(plan).pipe(Node.andThen(ReceiveFeedback.call({ boundary: "before-implementation", revision: cursor.revision }).pipe(
      Node.branch({
        if: receipt => receipt.messages.length > 0,
        then: receipt => MergeFeedback.call({ cursor, receipt, advance: true }).pipe(Node.bindPlanned(next => Coordinate.to(next))),
        else: () => AdmitSource.call({ plan }).pipe(
          Node.bindPlanned(plan => CorrectPlan.child({ plan, maxRounds: cursor.maxRounds }).pipe(
            Node.bindPlanned(outcome => Node.succeed(outcome).pipe(Node.andThen(ReceiveFeedback.call({ boundary: "after-correction", revision: cursor.revision }).pipe(
              Node.branch({
                if: receipt => receipt.messages.length > 0,
                then: receipt => MergeFeedback.call({ cursor, receipt, advance: true }).pipe(Node.bindPlanned(next => Coordinate.to(next))),
                else: () => Flow.done({ plan, outcome })
              })
            ))))
          ))
        )
      })
    ))))
  )
})

export const Request = Flow.make("coding/Request", {
  payload: RequestInput, success: RequestResult, error: PrepareWithWiki.errorSchema,
  body: input => PrepareWithWiki.child({ prompt: input.prompt, feedback: input.feedback ?? "" }).pipe(
    Node.bindPlanned(plan => AdmitSource.call({ plan })),
    Node.bindPlanned(plan => Poc.child({ plan, source: plan.observedHead }).pipe(
      Node.bindPlanned(poc => Node.succeed(poc.feedback).pipe(Node.andThen(AdmitSource.call({ plan })), Node.andThen(Node.succeed(poc.feedback))))
    )),
    Node.map(feedback => input.feedback ? `${input.feedback}\n\n${feedback}` : feedback),
    Node.bindPlanned(feedback => Node.succeed(feedback).pipe(
      Node.andThen(ReceiveFeedback.call({ boundary: "after-poc", revision: 0 })),
      Node.bindPlanned(receipt => MergeFeedback.call({ cursor: { prompt: input.prompt, feedback,
        maxRounds: input.maxRounds ?? 3, revision: 0 }, receipt, advance: false }))
    )),
    Node.bindPlanned(cursor => Coordinate.child(cursor))
  )
})
const RefuseRequest = Action.make("coding/refuse-request", {
  payload: {}, success: RequestResult, error: CodingError
})
export const RunRequest = Flow.make("coding/RunRequest", {
  payload: Executable.Invocation, success: RequestResult, error: Request.errorSchema,
  body: invocation => {
    const decoded = Schema.decodeUnknownOption(RequestInput)(invocation.input)
    return Option.isSome(decoded) ? Request.child(decoded.value) : RefuseRequest.call({})
  }
})
export const requestRegistration = Layer.mergeAll(
  Interpreter.layer(Request), Interpreter.layer(RunRequest), Interpreter.layer(Coordinate),
  MergeFeedback.toLayer(({ cursor, receipt, advance }) => Effect.gen(function*() {
    // ReceiveFeedback completed before this action was materialized, so even
    // a bounded refusal retains the exact message IDs, text and provenance.
    const feedback = yield* appendFeedback(cursor.feedback, receipt)
    const revision = cursor.revision + (advance ? 1 : 0)
    if (revision >= maximumPlanningPasses) return yield* Effect.fail(new CodingError({
      code: "invalid_plan", message: `Request reached ${maximumPlanningPasses} planning passes at ${receipt.boundary}; retained message IDs: ${receipt.messages.map(message => JSON.stringify(message.id)).join(", ")}`
    }))
    return { ...cursor, feedback, revision }
  })),
  RefuseRequest.toLayer(() => Effect.fail(new CodingError({ code: "invalid_plan", message: "A coding request needs a prompt and an optional correction limit of 1..8" })))
)
