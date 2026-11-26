import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Channels } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Duration, Schema } from "effect"
import { ALERT_PERCENT } from "../../infra/Connections.ts"
import type * as Flows from "../Flows.ts"
import * as HyperdrivePool from "../HyperdrivePool.ts"
import * as AlertDelivery from "./AlertDelivery.ts"

// Captured callbacks contribute to the persisted plan digest. Keep their TypeScript transform so existing runs resume.

const nonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const positive = Schema.Int.check(Schema.isGreaterThan(0))

/** One window: its start and end in epoch milliseconds. */
const payload = { from: nonNegative, until: positive }

/** A window, as the flow's payload holds it. */
export type Window = Flows.Window

/** How long one window lasts: one sample, and at most one alert, per window. */
export const WINDOW = Duration.minutes(5)

/**
 * The execution, and the alert, for one window: one per window length and start.
 * @throws {never}
 */
export const executionId = (window: Window) => `database-load-${window.until - window.from}-${window.from}`

/**
 * v2's execution, and alert, for one window: never v1's, whose intent a v2 start would conflict with.
 * @throws {never}
 */
export const executionIdV2 = (window: Window) => `database-load-v2-${window.until - window.from}-${window.from}`

/** Client connections in use and `max_connections`, and whether in use reached the alert's share of it. */
export const Sampled = Schema.Struct({ used: nonNegative, max: positive, over: Schema.Boolean })
export type Sampled = typeof Sampled.Type

/** Postgres failed the sample. The step retries it, and never gives up. */
export class SampleFailed extends Schema.TaggedError<SampleFailed>()("@smthrs/mvp/ops/SampleFailed", {
  reason: Schema.Literal("database"),
}) {}

/** Only Postgres can fail the sample, so its retries never give up. */
const retryPolicy = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

/** Reads the window's connections. */
export const Sample = Action.make("ops/SampleConnections", {
  payload,
  success: Sampled,
  error: SampleFailed,
  capabilities: ["db:read:pg_stat_activity"],
  retryPolicy,
})

/**
 * v2's sample: the connections, and Hyperdrive's pools when the deployment can read them (decision 0150). A new step,
 * never a changed `ops/SampleConnections`: a changed declaration changes the plan's digest, and a v1 run in flight
 * would stop with `plan_changed`.
 */
export const SampleV2 = Action.make("ops/SampleDatabaseLoad", {
  payload,
  success: Sampled,
  error: SampleFailed,
  capabilities: ["db:read:pg_stat_activity", "net:cloudflare_analytics"],
  retryPolicy,
})

/** The alert as one channel delivers it: its id, the channel, and the connections it reports. */
const deliverPayload = { alertId: Schema.String, channel: Channels.Channel, used: nonNegative, max: positive }

/** One delivery's payload. */
export interface DeliverRequest {
  readonly alertId: string
  readonly channel: Channels.Channel
  readonly used: number
  readonly max: number
}

/**
 * Sends the window's alert on one channel and records its receipt, at least once, as `ops/DeliverSpendAlert` does: the
 * send is the step's one write, so it is `irreversible`, keyed by the alert and the channel.
 */
export const Deliver = Action.make("ops/DeliverDatabaseAlert", {
  payload: deliverPayload,
  success: AlertDelivery.Delivered,
  error: Schema.Union([Channels.DeliveryFailed, AlertDelivery.DeliverUnavailable]),
  capabilities: ["db:read:alert_channels", "db:write:alert_deliveries", "net:alert_channels"],
  tier: "irreversible",
  idempotencyKey: ({ alertId, channel }) => ({ alert: alertId, channel }),
  retryPolicy: AlertDelivery.retryPolicy,
})

/** What the flow did: the sample, and each channel's delivery, `none` under the share. */
export const Outcome = Schema.Struct({ sample: Sampled, email: AlertDelivery.Delivered, telegram: AlertDelivery.Delivered })

const NONE = { outcome: "none" } as const

/** v1's body: the connection sample, then, over the share, one alert per channel keyed by v1's execution id. */
export const bodyV1 = Node.capture({}, (window: Window) =>
  Sample.call(window).pipe(
    Node.branch({
      if: Node.capture({}, (sampled: Sampled) => sampled.over),
      then: Node.capture({ alertId: executionId(window) }, function (sampled) {
        const { used, max } = sampled
        return Node.all({
          sample: Node.succeed(sampled),
          email: Deliver.call({ alertId: this.alertId, channel: "email", used, max }),
          telegram: Deliver.call({ alertId: this.alertId, channel: "telegram", used, max }),
        })
      }),
      else: Node.capture({}, (sampled) =>
        Node.all({ sample: Node.succeed(sampled), email: Node.succeed(NONE), telegram: Node.succeed(NONE) })),
    }),
  ))

/** v2's body: v1's over `SampleV2`, keyed by v2's execution id. */
const bodyV2 = Node.capture({}, (window: Window) =>
  SampleV2.call(window).pipe(
    Node.branch({
      if: Node.capture({}, (sampled: Sampled) => sampled.over),
      then: Node.capture({ alertId: executionIdV2(window) }, function (sampled) {
        const { used, max } = sampled
        return Node.all({
          sample: Node.succeed(sampled),
          email: Deliver.call({ alertId: this.alertId, channel: "email", used, max }),
          telegram: Deliver.call({ alertId: this.alertId, channel: "telegram", used, max }),
        })
      }),
      else: Node.capture({}, (sampled) =>
        Node.all({ sample: Node.succeed(sampled), email: Node.succeed(NONE), telegram: Node.succeed(NONE) })),
    }),
  ))

/** Either version's failure. */
export const Failure = Schema.Union([SampleFailed, Channels.DeliveryFailed, AlertDelivery.DeliverUnavailable])

/**
 * `ops/DatabaseLoad`: samples the app's Postgres connections and alerts the Admins once they reach the share. v1, kept
 * as it was so a run in flight when v2 deploys resumes (`DatabaseLoadV2`); nothing starts a new one.
 */
export const DatabaseLoad = Flow.make("ops/DatabaseLoad", {
  description: "Sample the app's Postgres connections in use against max_connections, and alert the deployment's " +
    `Admins by email and Telegram where they set them once ${ALERT_PERCENT}% are in use.`,
  capabilities: [
    "db:read:pg_stat_activity",
    "db:read:alert_channels",
    "db:write:alert_deliveries",
    "net:alert_channels",
  ],
  modelInvocable: false,
  payload,
  success: Outcome,
  error: Failure,
  body: bodyV1,
})

/**
 * `ops/DatabaseLoad/v2`: v1, plus Hyperdrive's pools (decision 0150): the sample is over once the connections reach
 * the share or a config's pool stayed saturated. Each window's sampler starts this one.
 */
export const DatabaseLoadV2 = Flow.make("ops/DatabaseLoad/v2", {
  description: "Sample the app's Postgres connections in use against max_connections, and Hyperdrive's pools, and " +
    `alert the deployment's Admins by email and Telegram where they set them once ${ALERT_PERCENT}% are in use or ` +
    `more than ${HyperdrivePool.WAITING_THRESHOLD} clients waited for a pool connection ` +
    `${HyperdrivePool.SUSTAINED_MINUTES} minutes in a row.`,
  capabilities: [
    "db:read:pg_stat_activity",
    "net:cloudflare_analytics",
    "db:read:alert_channels",
    "db:write:alert_deliveries",
    "net:alert_channels",
  ],
  modelInvocable: false,
  payload,
  success: Outcome,
  error: Failure,
  body: bodyV2,
})
