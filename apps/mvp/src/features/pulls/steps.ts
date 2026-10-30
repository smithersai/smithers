import { Interpreter } from "@smthrs/flow"
import { type Duration, Effect, Layer, Metric } from "effect"
import { PullsClient, type PullsRequestFailed } from "./api"
import { REVIEW_REFUSALS, type ReviewRefusal } from "./contract"
import { PullReview, type ReviewFailure, ReviewRefused, type ReviewRequest, ReviewRequestStep, ReviewUnsent } from "./flows"

// Review on request (docs/features/pulls.md#review-on-request): one ChatApi request through `PullsClient`. A
// Maintainer's press, or `/review`, runs this step on this device's engine.

/** Reviews asked for, by `outcome`: `sent`, `refused` or `unsent`. */
export const reviews = Metric.counter("smithers_web_pull_reviews", {
  description: "Reviews a Maintainer asked Smithers for on a pull request, by outcome",
  incremental: true,
})

/** How long the route gets to answer: it answers once its flow has started. */
export const REVIEW_WITHIN: Duration.Input = "15 seconds"

const isRefusal = (code: string | undefined): code is ReviewRefusal =>
  code !== undefined && (REVIEW_REFUSALS as ReadonlyArray<string>).includes(code)

/**
 * What ChatApi's answer means to the flow: a 4xx but `429` is final, with its code when it is one, and so is `503
 * not_configured` (no App: asking again changes nothing); anything else, a rate limit included, is tried again.
 */
export const failureOf = (failed: PullsRequestFailed): ReviewFailure =>
  failed.status !== undefined &&
    (failed.status >= 400 && failed.status < 500 && failed.status !== 429 || failed.code === "not_configured")
    ? new ReviewRefused({ status: failed.status, ...(isRefusal(failed.code) ? { code: failed.code } : {}) })
    : new ReviewUnsent()

/**
 * `pull/review/request`: one `POST /api/repos/<owner>/<name>/pulls/<number>/review`, a log line `pull.review.request`
 * and a count by outcome, with ChatApi's status and code; never the pull request's title or diff.
 */
export const requestReview = (payload: ReviewRequest) =>
  Effect.gen(function* () {
    const answer = yield* Effect.result((yield* PullsClient).review(payload))
    const failure = answer._tag === "Failure" ? failureOf(answer.failure) : undefined
    const outcome = failure === undefined ? "sent" : failure._tag === "@smthrs/mvp/pulls/ReviewRefused" ? "refused" : "unsent"
    yield* Metric.update(Metric.withAttributes(reviews, { outcome }), 1)
    yield* Effect.logWithLevel(failure === undefined ? "Info" : "Warn")("pull.review.request").pipe(
      Effect.annotateLogs({
        outcome,
        ...(answer._tag === "Failure" && answer.failure.status !== undefined ? { status: answer.failure.status } : {}),
        ...(answer._tag === "Failure" && answer.failure.code !== undefined ? { code: answer.failure.code } : {}),
        feature: "pulls",
      }),
    )
    if (answer._tag === "Success") return answer.success
    return yield* Effect.fail(failure!)
  })

/** Registers `pull/review` with its step, asking through the host's `PullsClient`. */
export const registration = Interpreter.layerWithImplementations(PullReview, ReviewRequestStep.toLayer(requestReview))

/** The flow, asking ChatApi on `origin`. Needs the host's `HttpClient`. */
export const registrationAt = (origin: string) =>
  registration.pipe(Layer.provide(PullsClient.layer({ origin, within: REVIEW_WITHIN })))
