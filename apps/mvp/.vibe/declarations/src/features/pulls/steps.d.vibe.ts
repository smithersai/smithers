import { type Duration, Effect, Layer, Metric } from "effect";
import { PullsClient, type PullsRequestFailed } from "./api.vibe";
import { type ReviewFailure, ReviewRefused, type ReviewRequest, ReviewUnsent } from "../../../../../src/features/pulls/flows.ts";
/** Reviews asked for, by `outcome`: `sent`, `refused` or `unsent`. */
export declare const reviews: Metric.Counter<number>;
/** How long the route gets to answer: it answers once its flow has started. */
export declare const REVIEW_WITHIN: Duration.Input;
/**
 * What ChatApi's answer means to the flow: a 4xx but `429` is final, with its code when it is one, and so is `503
 * not_configured` (no App: asking again changes nothing); anything else, a rate limit included, is tried again.
 */
export declare const failureOf: (failed: PullsRequestFailed) => ReviewFailure;
/**
 * `pull/review/request`: one `POST /api/repos/<owner>/<name>/pulls/<number>/review`, a log line `pull.review.request`
 * and a count by outcome, with ChatApi's status and code; never the pull request's title or diff.
 */
export declare const requestReview: (payload: ReviewRequest) => Effect.Effect<{
    readonly sha: string;
    readonly started: boolean;
}, ReviewRefused | ReviewUnsent, PullsClient>;
/** Registers `pull/review` with its step, asking through the host's `PullsClient`. */
export declare const registration: Layer.Layer<import("@smthrs/flow/Action").Requirement<"pull/review/request">, never, import("@smthrs/flow/FlowRuntime").FlowRuntime | PullsClient>;
/** The flow, asking ChatApi on `origin`. Needs the host's `HttpClient`. */
export declare const registrationAt: (origin: string) => Layer.Layer<import("@smthrs/flow/Action").Requirement<"pull/review/request">, never, import("@smthrs/flow/FlowRuntime").FlowRuntime | import("effect/http/HttpClient").HttpClient>;
