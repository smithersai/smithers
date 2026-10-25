import { Interpreter } from "@smthrs/flow"
import { Effect, Layer, Metric } from "effect"
import { AlertsClient, type ChannelNotTaken } from "./api"
import {
  AlertChannelSet,
  type ChannelFailure,
  ChannelRefused,
  ChannelRequestStep,
  ChannelUnsent,
  LimitsRequestStep,
  SandboxLimitsSet,
} from "./flows"
import type { SandboxLimitsRequest, SetChannelRequest } from "./schema"

// Setting where spend alerts go (docs/features/spend-alerts.md#channels): one ChatApi request, through `AlertsClient`.
// An Admin's Save runs this step on this device's engine.

/** Settings sent, by `channel` and `outcome`: `sent`, `refused` or `unsent`. */
export const sets = Metric.counter("smithers_web_alert_channel_sets", {
  description: "Alert channel settings an Admin sent, by channel and outcome",
  incremental: true,
})

/** What ChatApi's refusal means to the flow: a 4xx other than timeout or rate limiting is final; transient failures retry. */
export const failureOf = (refused: ChannelNotTaken): ChannelFailure =>
  refused.status !== undefined && refused.status >= 400 && refused.status < 500 &&
    refused.status !== 408 && refused.status !== 429
    ? new ChannelRefused({ status: refused.status, ...(refused.code === undefined ? {} : { code: refused.code }) })
    : new ChannelUnsent()

/**
 * `alert/channel/request`: one `POST /api/alert-channels`. A log line `alerts.channel.set` and a count by channel and
 * outcome, with how many destinations; never one of them.
 */
export const requestChannel = (request: SetChannelRequest) =>
  Effect.gen(function* () {
    const answer = yield* Effect.result((yield* AlertsClient).set(request))
    const failure = answer._tag === "Failure" ? failureOf(answer.failure) : undefined
    const outcome = failure === undefined ? "sent" : failure._tag === "@smthrs/mvp/spend/ChannelRefused" ? "refused" : "unsent"
    yield* Metric.update(Metric.withAttributes(sets, { channel: request.channel, outcome }), 1)
    yield* Effect.logWithLevel(failure === undefined ? "Info" : "Warn")("alerts.channel.set").pipe(
      Effect.annotateLogs({
        channel: request.channel,
        destinations: request.destinations.length,
        outcome,
        ...(answer._tag === "Failure" && answer.failure.status !== undefined ? { status: answer.failure.status } : {}),
        ...(answer._tag === "Failure" && answer.failure.code !== undefined ? { code: answer.failure.code } : {}),
      }),
    )
    if (failure !== undefined) return yield* Effect.fail(failure)
    return { saved: true }
  })

/** Limit settings sent, by `outcome`: `sent`, `refused` or `unsent`. */
export const limitSets = Metric.counter("smithers_web_sandbox_limit_sets", {
  description: "Sandbox limit settings an Admin sent, by outcome",
  incremental: true,
})

/**
 * `sandbox/limits/request`: one `POST /api/sandbox-limits`. A log line `sandbox.limits.set` with the limits and the
 * outcome, and a count by outcome.
 */
export const requestLimits = (request: SandboxLimitsRequest) =>
  Effect.gen(function* () {
    const answer = yield* Effect.result((yield* AlertsClient).setLimits(request))
    const failure = answer._tag === "Failure" ? failureOf(answer.failure) : undefined
    const outcome = failure === undefined ? "sent" : failure._tag === "@smthrs/mvp/spend/ChannelRefused" ? "refused" : "unsent"
    yield* Metric.update(Metric.withAttributes(limitSets, { outcome }), 1)
    yield* Effect.logWithLevel(failure === undefined ? "Info" : "Warn")("sandbox.limits.set").pipe(
      Effect.annotateLogs({
        ...request,
        outcome,
        ...(answer._tag === "Failure" && answer.failure.status !== undefined ? { status: answer.failure.status } : {}),
      }),
    )
    if (failure !== undefined) return yield* Effect.fail(failure)
    return { saved: true }
  })

/** Registers `alert/channel` and `sandbox/limits` with their steps, asking through the host's `AlertsClient`. */
export const registration = Layer.mergeAll(
  Interpreter.layerWithImplementations(AlertChannelSet, ChannelRequestStep.toLayer(requestChannel)),
  Interpreter.layerWithImplementations(SandboxLimitsSet, LimitsRequestStep.toLayer(requestLimits)),
)

/** The flow, asking ChatApi on `origin`. Needs the host's `HttpClient`. */
export const registrationAt = (origin: string) => registration.pipe(Layer.provide(AlertsClient.layer({ origin })))
