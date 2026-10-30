import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Schema } from "effect"
import { IssueNumber } from "../issues/flows"
import { RepoName } from "../repo/flows"
import { REVIEW_REFUSALS, SHA } from "./contract"

// Review on request (decision 0126, docs/features/pulls.md#review-on-request):
//
//   pull/review { repo, number, headSha? }    a Maintainer asks Smithers to review a pull request's head
//     pull/review/request ─ POST /api/repos/<owner>/<name>/pulls/<number>/review
//
// The step tries again while ChatApi can't be reached, for ten minutes; a refusal is final. ChatApi answers once its
// `pull/Review` has started; the review shows as the head's `checks/review` run on the Checks tab, and its findings as
// one comment review. What the step does is steps.ts, which only an engine's host imports.

/** ChatApi refused the request (`status`, a 4xx, with its `code`): asking again changes nothing. */
export class ReviewRefused extends Schema.TaggedError<ReviewRefused>()("@smthrs/mvp/pulls/ReviewRefused", {
  status: Schema.Number,
  code: Schema.optional(Schema.Literals(REVIEW_REFUSALS)),
}) {}

/** ChatApi couldn't be reached, or couldn't start the review: tried again. */
export class ReviewUnsent extends Schema.TaggedError<ReviewUnsent>()("@smthrs/mvp/pulls/ReviewUnsent", {}) {}

/** What asking for a review can fail with. */
export const ReviewFailure = Schema.Union([ReviewRefused, ReviewUnsent])
export type ReviewFailure = typeof ReviewFailure.Type

/** 500 ms doubling to 30 s, for ten minutes: a press made offline lands once the device is back. A refusal is final. */
export const REVIEW_RETRY = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 30_000,
  expirationMs: 10 * 60 * 1000,
  nonRetryable: ["@smthrs/mvp/pulls/ReviewRefused"],
})

/** What `pull/review` takes: the repository, the pull request, and the head the page showed, if it was a page. */
export const reviewPayload = {
  repo: RepoName,
  number: IssueNumber,
  headSha: Schema.optional(Schema.String.check(Schema.isPattern(SHA))),
}
export const ReviewRequest = Schema.Struct(reviewPayload)
export type ReviewRequest = typeof ReviewRequest.Type

/** What ChatApi answers once it took the request: the head reviewed, and whether this press started its review. */
export const ReviewTaken = Schema.Struct({ sha: Schema.String, started: Schema.Boolean })
export type ReviewTaken = typeof ReviewTaken.Type

/** The step: ask ChatApi to review the pull request's head. */
export const ReviewRequestStep = Action.make("pull/review/request", {
  payload: reviewPayload,
  success: ReviewTaken,
  error: ReviewFailure,
  retryPolicy: REVIEW_RETRY,
})

/** `pull/review`: ask Smithers to review a pull request. */
export const PullReview = Flow.make("pull/review", {
  description: "Ask Smithers to review a pull request: the judge reads its head's diff and posts its findings as one " +
    "comment review, never an approval. Maintainers and Admins only, in person.",
  modelInvocable: false,
  payload: reviewPayload,
  success: ReviewTaken,
  error: ReviewFailure,
  body: Node.capture({ action: ReviewRequestStep.name }, (request) => ReviewRequestStep.call(request)),
}).annotate(Flow.Placement, Placement.client())
