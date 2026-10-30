import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Schema } from "effect"
import { REFUSALS } from "./contract"
import { Answered, FeedAnswerPayload } from "./schema"

// A person's answer to an item a repository's feed shows, as a flow (decision 0126 §6, docs/features/feeds.md):
//
//   feed/answer { owner, name, id, item, choice?, text? }   a Maintainer answers, in person
//     feed/answer/request ─ POST /api/repos/<owner>/<name>/feeds/answers
//
// The step is durable: it tries again while ChatApi can't be reached, for a day, so an answer given offline lands once
// the device is back; the answer's id makes a resend change nothing. A refusal is final. What the step does is
// steps.ts, which only an engine's host imports.

/** ChatApi refused the answer (`status`, a 4xx, with its `code`): it can't land, so it isn't tried again. */
export class FeedAnswerRefused extends Schema.TaggedError<FeedAnswerRefused>()("@smthrs/mvp/feeds/FeedAnswerRefused", {
  status: Schema.Number,
  code: Schema.optional(Schema.Literals(REFUSALS)),
}) {}

/** ChatApi couldn't be reached, or couldn't record the answer now: tried again. */
export class FeedAnswerUnsent extends Schema.TaggedError<FeedAnswerUnsent>()("@smthrs/mvp/feeds/FeedAnswerUnsent", {}) {}

/** What an answer can fail with. */
export const FeedAnswerFailure = Schema.Union([FeedAnswerRefused, FeedAnswerUnsent])
export type FeedAnswerFailure = typeof FeedAnswerFailure.Type

/** 500 ms doubling to a minute, for a day: an answer given offline lands once the device is back. */
export const FEED_ANSWER_RETRY = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 60_000,
  expirationMs: 24 * 60 * 60 * 1000,
  nonRetryable: ["@smthrs/mvp/feeds/FeedAnswerRefused"],
})

const payload = FeedAnswerPayload.fields

/** The step: send the answer to ChatApi. Its words are the person's, so the journal seals them. */
export const AnswerRequestStep = Action.make("feed/answer/request", {
  payload,
  success: Answered,
  error: FeedAnswerFailure,
  tier: "sealed",
  retryPolicy: FEED_ANSWER_RETRY,
})

/** `feed/answer`: answer an item a repository's feed shows. */
export const FeedAnswer = Flow.make("feed/answer", {
  description: "Answer an item a repository's feed shows, such as a decision its factory asks for. Maintainers and " +
    "Admins of the repository only, in person.",
  modelInvocable: false,
  payload,
  success: Answered,
  error: FeedAnswerFailure,
  body: Node.capture({ action: AnswerRequestStep.name }, (request) => AnswerRequestStep.call(request)),
}).annotate(Flow.Placement, Placement.client())
