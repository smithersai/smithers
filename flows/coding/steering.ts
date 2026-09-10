/** Request messages belong to the coordinator; model settings keep their lane. */
import type * as ControlRuntime from "@smthrs/control/ControlRuntime"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect, Option, Schema } from "effect"
import * as Notification from "../../packages/smithers/notifications/src/Notification.ts"
import * as NotificationQueue from "../../packages/smithers/notifications/src/NotificationQueue.ts"
import { defaultCapacity } from "../../packages/smithers/notifications/src/NotificationState.ts"
import * as SteerPayload from "../../packages/smithers/notifications/src/SteerPayload.ts"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { CodingError, PlanningInput } from "./schema.ts"

const flowId = "coding/request"
const lineage = (rootId: string) => JSON.stringify([flowId, rootId])
const unavailable = (notificationId: string) => new NotificationQueue.NotificationError({
  code: "notification_unavailable", notificationId,
  message: "Request message requires its active approved coding control run"
})

/** Called once by the private host over its existing control queue. Returning
 * the original admit Effect preserves the enclosing control transaction.
 * All Message payloads use this policy; provenance strings are not identity roles.
 */
export const routeMessages = (queue: NotificationQueue.Service, control: ControlRuntime.Service): NotificationQueue.Service => ({
  ...queue,
  admit: (runId, notification) => Effect.gen(function*() {
    if (notification.targetLineageId !== runId || SteerPayload.decode(notification.payload)?.kind !== "Message") {
      return yield* queue.admit(runId, notification)
    }
    const run = yield* control.getRun(runId).pipe(Effect.mapError(() => unavailable(notification.id)))
    if (run.flowId !== flowId) return yield* queue.admit(runId, notification)
    if (run.planId === undefined || run.status === "cancelled" || run.status === "failed" || run.status === "completed") {
      return yield* Effect.fail(unavailable(notification.id))
    }
    const plan = yield* control.getPlan(run.planId).pipe(Effect.mapError(() => unavailable(notification.id)))
    if (plan.decision !== "approved" || plan.card.flowId !== flowId || run.planDigest !== plan.card.digest ||
        plan.card.executionDigest === undefined || !plan.card.envelope.flows.includes("coding/RunRequest")) {
      return yield* Effect.fail(unavailable(notification.id))
    }
    const receipt = yield* queue.admit(runId, { ...notification, targetLineageId: lineage(runId) })
    // Control.steer currently ignores rejected-full. In this configured route
    // an accepted request message must actually have a retained notification.
    if (receipt.decision === "rejected-full") return yield* Effect.fail(new NotificationQueue.NotificationError({
      code: "notification_unavailable", notificationId: notification.id,
      message: "Request feedback queue is full; retry after the coordinator receives pending messages"
    }))
    return receipt
  })
})

const Boundary = Schema.Literals(["after-poc", "before-implementation", "after-correction"])
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const FeedbackReceipt = Schema.Struct({
  boundary: Schema.NonEmptyString,
  messages: Schema.Array(Notification.Notification).check(Schema.isMaxLength(defaultCapacity))
})
export type FeedbackReceipt = typeof FeedbackReceipt.Type

export const ReceiveFeedback = Action.make("coding/receive-request-feedback", {
  payload: { boundary: Boundary, revision: Revision }, success: FeedbackReceipt,
  error: CodingError, nondeterministic: true
})

/** Runtime identity is installed only after native ownership is proved again.
 * Reading it optionally avoids inventing a construction-time owner just to
 * register the action. Missing identity refuses before accessing the queue.
 */
export const receiveFeedback = (input: typeof ReceiveFeedback.payloadSchema.Type) => Effect.gen(function*() {
  const owner = yield* Effect.serviceOption(ModuleOwner)
  if (Option.isNone(owner) || owner.value.flowId !== flowId) return yield* Effect.fail(new CodingError({
    code: "unavailable", message: "Request feedback requires its proved coding coordinator owner"
  }))
  const instance = yield* FlowRuntime.FlowInstance
  const queue = yield* NotificationQueue.NotificationQueue
  const boundary = JSON.stringify([instance.executionId, input.boundary, input.revision])
  const receipt = yield* queue.drain({
    runId: owner.value.rootId, targetLineageId: lineage(owner.value.rootId), boundary, wouldIdle: true
  }).pipe(Effect.mapError(() => new CodingError({ code: "unavailable", message: `Request feedback at ${boundary} could not be read` })))
  return { boundary, messages: receipt.notifications }
})
export const feedbackLayer = ReceiveFeedback.toLayer(receiveFeedback)

/** Apply only after ReceiveFeedback's native action result is recorded. A
 * refusal leaves the exact notifications, attribution and drain receipt in
 * the existing journals; it never truncates accepted instructions silently.
 */
export const appendFeedback = (feedback: string, receipt: FeedbackReceipt): Effect.Effect<string, CodingError> => {
  const rendered: string[] = []
  for (const message of receipt.messages) {
    const payload = SteerPayload.decode(message.payload)
    if (payload?.kind !== "Message") return Effect.fail(new CodingError({
      code: "invalid_plan", message: `Request feedback ${JSON.stringify(message.id)} has no readable Message payload`
    }))
    rendered.push(`[request message ${JSON.stringify({ id: message.id, ...message.provenance })}]\n${payload.body}`)
  }
  const combined = [feedback, ...rendered].filter(value => value.length > 0).join("\n\n")
  return Schema.decodeUnknownEffect(PlanningInput.fields.feedback)(combined).pipe(Effect.mapError(() => new CodingError({
    code: "invalid_plan",
    message: `Request feedback exceeds the planning limit at ${receipt.boundary}; retained message IDs: ${receipt.messages.map(message => JSON.stringify(message.id)).join(", ")}`
  })))
}
