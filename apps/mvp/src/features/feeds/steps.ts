import { Interpreter } from "@smthrs/flow"
import { Effect, Layer, Metric } from "effect"
import { type AnswerNotTaken, FeedsClient } from "./api"
import { type Refusal, REFUSALS } from "./contract"
import { AnswerRequestStep, FeedAnswer, type FeedAnswerFailure, FeedAnswerRefused, FeedAnswerUnsent } from "./flows"
import type { FeedAnswerPayload } from "./schema"

// Answering an item a repository's feed shows (docs/features/feeds.md): one ChatApi request, through `FeedsClient`. A
// Maintainer's press runs this step on this device's engine.

/** Answers sent, by `outcome`: `sent`, `refused` or `unsent`. */
export const answers = Metric.counter("smithers_web_feed_answers", {
  description: "Answers to a repository's feed a Maintainer sent, by outcome",
  incremental: true,
})

const isRefusal = (code: string | undefined): code is Refusal =>
  code !== undefined && (REFUSALS as ReadonlyArray<string>).includes(code)

/**
 * What ChatApi's answer means to the flow: a 4xx is final, with its code when it is one; anything else (no network, a
 * 5xx) is tried again.
 */
export const failureOf = (refused: AnswerNotTaken): FeedAnswerFailure =>
  refused.status !== undefined && refused.status >= 400 && refused.status < 500
    ? new FeedAnswerRefused({ status: refused.status, ...(isRefusal(refused.code) ? { code: refused.code } : {}) })
    : new FeedAnswerUnsent()

/**
 * `feed/answer/request`: one `POST .../feeds/answers`, as a log line `feed.answer` and a count by outcome, with
 * ChatApi's status and code; never the item, the choice or the text.
 */
export const requestAnswer = (payload: FeedAnswerPayload) =>
  Effect.gen(function* () {
    const client = yield* FeedsClient
    const answer = yield* Effect.result(client.answer(payload))
    const failure = answer._tag === "Failure" ? failureOf(answer.failure) : undefined
    const outcome = failure === undefined
      ? "sent"
      : failure._tag === "@smthrs/mvp/feeds/FeedAnswerRefused"
      ? "refused"
      : "unsent"
    yield* Metric.update(Metric.withAttributes(answers, { outcome }), 1)
    yield* Effect.logWithLevel(failure === undefined ? "Info" : "Warn")("feed.answer").pipe(
      Effect.annotateLogs({
        outcome,
        ...(answer._tag === "Failure" && answer.failure.status !== undefined ? { status: answer.failure.status } : {}),
        ...(answer._tag === "Failure" && answer.failure.code !== undefined ? { code: answer.failure.code } : {}),
        feature: "feeds",
      }),
    )
    if (answer._tag === "Success") return answer.success
    return yield* Effect.fail(failure!)
  })

/** Registers `feed/answer` with its step, asking through the host's `FeedsClient`. */
export const registration = Interpreter.layerWithImplementations(FeedAnswer, AnswerRequestStep.toLayer(requestAnswer))

/** The flow, asking ChatApi on `origin`. Needs the host's `HttpClient`. */
export const registrationAt = (origin: string) => registration.pipe(Layer.provide(FeedsClient.layer({ origin })))
