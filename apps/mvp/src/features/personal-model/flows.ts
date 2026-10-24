import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Schema } from "effect"
import { REFUSALS } from "./contract"
import { Removed, TestResult } from "./schema"

// A person's own model, as flows (decision 0096, docs/features/personal-model.md#the-flows):
//
//   model/test {}     one tiny call with the person's saved model: whether it answers, or how it failed
//     model/test/request ─ POST /api/me/model/test
//   model/remove {}   removes the person's model, so the deployment's model answers them again
//     model/remove/request ─ DELETE /api/me/model
//
// Saving is no flow: its key must never enter a model's context, a journal or the device (decision 0017). It is the
// person's own `PUT` (actions.ts). Each step tries again while ChatApi can't be reached; a refusal is final. ChatApi
// answers a remove once its own flow has started; the row leaves through the shape. What the steps do is steps.ts,
// which only an engine's host imports.

/** ChatApi refused (`status`, a 4xx, or `503 off`, with its `code`): trying again changes nothing. */
export class ModelRefused extends Schema.TaggedError<ModelRefused>()("@smthrs/mvp/personal-model/ModelRefused", {
  status: Schema.Number,
  code: Schema.optional(Schema.Literals(REFUSALS)),
}) {}

/** ChatApi couldn't be reached, or couldn't answer: tried again. Its client's span has the HTTP status. */
export class ModelUnsent extends Schema.TaggedError<ModelUnsent>()("@smthrs/mvp/personal-model/ModelUnsent", {}) {}

/** What a remove or a test can fail with. */
export const ModelFailure = Schema.Union([ModelRefused, ModelUnsent])
export type ModelFailure = typeof ModelFailure.Type

/** 500 ms doubling to 30 s, for an hour: a remove pressed offline lands once the device is back. A refusal is final. */
export const REMOVE_RETRY = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 30_000,
  expirationMs: 60 * 60 * 1000,
  nonRetryable: ["@smthrs/mvp/personal-model/ModelRefused"],
})

/** 500 ms doubling to 5 s, for a minute: someone waits for a test's answer, which is only worth having now. */
export const TEST_RETRY = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 5_000,
  expirationMs: 60 * 1000,
  nonRetryable: ["@smthrs/mvp/personal-model/ModelRefused"],
})

/** The step: ask ChatApi to test the person's model. */
export const TestRequestStep = Action.make("model/test/request", {
  payload: {},
  success: TestResult,
  error: ModelFailure,
  retryPolicy: TEST_RETRY,
})

/** The step: ask ChatApi to remove the person's model. */
export const RemoveRequestStep = Action.make("model/remove/request", {
  payload: {},
  success: Removed,
  error: ModelFailure,
  retryPolicy: REMOVE_RETRY,
})

/** `model/test`: one tiny call with the person's own model. */
export const ModelTest = Flow.make("model/test", {
  description: "Test the person's own model with one tiny call: OK, or the provider's host and why it failed. " +
    "Members and above, for the model they saved in Settings.",
  payload: {},
  success: TestResult,
  error: ModelFailure,
  body: Node.capture({ action: TestRequestStep.name }, () => TestRequestStep.call({})),
}).annotate(Flow.Placement, Placement.client())

/** `model/remove`: the person's own model goes, and the deployment's model answers them again. */
export const ModelRemove = Flow.make("model/remove", {
  description: "Remove the person's own model, so the deployment's model answers them again. Members and above.",
  payload: {},
  success: Removed,
  error: ModelFailure,
  body: Node.capture({ action: RemoveRequestStep.name }, () => RemoveRequestStep.call({})),
}).annotate(Flow.Placement, Placement.client())
