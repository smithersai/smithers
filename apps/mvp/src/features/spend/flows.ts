import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Schema } from "effect"
import { MAX_DESTINATIONS } from "./contract"
import { AlertChannelName, SandboxLimitsRequest } from "./schema"

// Where spend alerts go outside the app, and the sandbox limits, as flows (docs/features/spend-alerts.md#channels,
// docs/features/sandbox-budgets.md#the-limits):
//
//   alert/channel { channel, destinations }   an Admin sets email addresses or a Telegram chat; none turns it off
//     alert/channel/request ─ POST /api/alert-channels
//   sandbox/limits { awake, perPerson, monthlyAlertUsd }   an Admin sets the sandbox limits
//     sandbox/limits/request ─ POST /api/sandbox-limits
//
// The step tries again while ChatApi can't be reached, for an hour; a refusal is final. Setting the same destinations
// twice changes nothing. What the step does is steps.ts, which only an engine's host imports.

/** ChatApi refused the setting (`status`, a 4xx other than 408 or 429, with its `code`): it can't land, so it isn't tried again. */
export class ChannelRefused extends Schema.TaggedError<ChannelRefused>()("@smthrs/mvp/spend/ChannelRefused", {
  status: Schema.Number,
  code: Schema.optional(Schema.String),
}) {}

/** ChatApi couldn't be reached, or failed: tried again. Its client's span has the HTTP status. */
export class ChannelUnsent extends Schema.TaggedError<ChannelUnsent>()("@smthrs/mvp/spend/ChannelUnsent", {}) {}

/** What setting a channel can fail with. */
export const ChannelFailure = Schema.Union([ChannelRefused, ChannelUnsent])
export type ChannelFailure = typeof ChannelFailure.Type

/** 500 ms doubling to 30 s, for an hour: a setting saved offline lands once the device is back. A refusal is final. */
export const CHANNEL_RETRY = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 30_000,
  expirationMs: 60 * 60 * 1000,
  nonRetryable: ["@smthrs/mvp/spend/ChannelRefused"],
})

const payload = {
  channel: AlertChannelName,
  destinations: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_DESTINATIONS)),
}

/** The step: ask ChatApi to set the channel. */
export const ChannelRequestStep = Action.make("alert/channel/request", {
  payload,
  success: Schema.Struct({ saved: Schema.Boolean }),
  error: ChannelFailure,
  retryPolicy: CHANNEL_RETRY,
})

/** `alert/channel`: set where spend alerts go on one channel. */
export const AlertChannelSet = Flow.make("alert/channel", {
  description: "Set where the deployment's spend alerts go on one channel: email addresses, or one Telegram chat id. " +
    "No destinations turns the channel off. Admins only.",
  modelInvocable: false,
  payload,
  success: Schema.Struct({ saved: Schema.Boolean }),
  error: ChannelFailure,
  body: Node.capture({ action: ChannelRequestStep.name }, (request) => ChannelRequestStep.call(request)),
}).annotate(Flow.Placement, Placement.client())

/** The step: ask ChatApi to set the sandbox limits. It fails as setting a channel does, and retries the same way. */
export const LimitsRequestStep = Action.make("sandbox/limits/request", {
  payload: SandboxLimitsRequest.fields,
  success: Schema.Struct({ saved: Schema.Boolean }),
  error: ChannelFailure,
  retryPolicy: CHANNEL_RETRY,
})

/** `sandbox/limits`: set how many sandboxes may be awake, and the monthly sandbox spend that alerts the Admins. */
export const SandboxLimitsSet = Flow.make("sandbox/limits", {
  description: "Set the sandbox limits: how many sandboxes may be awake in the deployment and per person, and the " +
    "monthly sandbox spend in dollars that alerts the Admins (0 turns the alert off). Admins only.",
  modelInvocable: false,
  payload: SandboxLimitsRequest.fields,
  success: Schema.Struct({ saved: Schema.Boolean }),
  error: ChannelFailure,
  body: Node.capture({ action: LimitsRequestStep.name }, (request) => LimitsRequestStep.call(request)),
}).annotate(Flow.Placement, Placement.client())
