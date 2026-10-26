import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Duration, Effect, Schema } from "effect"
import { AnswerApi, AnswersUnavailable } from "./answers"
import { ANSWER_SETTLE_WITHIN } from "./contract"

// `chat/Close` (docs/features/agent.md#settling): settles an answer whose run can no longer finish, as failed,
// `unfinished`. The asking tab starts it, under its own execution id (`<answerId>/close`), when `chat/Answer` ended
// refused because the app changed under it (the run was parked under one build and resumed under the next:
// `plan_changed`, or `payload_changed` when its recorded payload no longer decodes), so the answer reads `Couldn't answer` with Retry at once instead of streaming until `chat/Expire`. It imports
// no agent, so the tab dispatches it by the declaration itself.

/** How long a settle keeps trying to land while the answer routes are unreachable: `chat/Settle`'s and `chat/Close`'s. */
export const SETTLE_RETRY = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 8_000,
  expirationMs: Duration.toMillis(Duration.fromInputUnsafe(ANSWER_SETTLE_WITHIN)),
  nonRetryable: ["@smthrs/mvp/agent/AnswerSettled"],
})

/** Whether the close settled the answer, or found it settled already and left it as it is. */
export const Closed = Schema.Struct({ closed: Schema.Boolean })

/** The step: writes the answer failed, `unfinished`. */
export const CloseWrite = Action.make("chat/CloseWrite", {
  payload: { answerId: Schema.String },
  success: Closed,
  error: AnswersUnavailable,
  tier: "sealed",
  retryPolicy: SETTLE_RETRY,
})

/** `chat/Close { answerId }`: settles, as failed, an answer whose run can no longer finish. */
export const Close = Flow.make("chat/Close", {
  description: "Settle, as failed, an answer whose run can no longer finish.",
  modelInvocable: false,
  payload: { answerId: Schema.String },
  success: Closed,
  error: AnswersUnavailable,
  body: Node.capture({ action: CloseWrite.name }, (payload) => CloseWrite.call(payload)),
}).annotate(Flow.Placement, Placement.client())

/** What `chat/CloseWrite` does: one settle through the answer routes; an answer settled already stays as it is. */
export const closeAnswer = ({ answerId }: { readonly answerId: string }) =>
  Effect.gen(function* () {
    return yield* (yield* AnswerApi).write(answerId, { status: "failed", failure: "unfinished" }).pipe(
      Effect.as({ closed: true }),
      // expected: an answer settled already stays settled
      Effect.catchTag("@smthrs/mvp/agent/AnswerSettled", () => Effect.succeed({ closed: false })),
    )
  })

/** Registers `chat/Close` with its step, writing through the host's `AnswerApi`. */
export const registration = Interpreter.layerWithImplementations(Close, CloseWrite.toLayer(closeAnswer))
