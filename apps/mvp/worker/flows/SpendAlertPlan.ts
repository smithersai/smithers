import { Action, Flow, RetryPolicy, Sleep } from "@smthrs/flow"
import { Pricing } from "@smthrs/model"
import { Channels } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import * as AlertDelivery from "./AlertDelivery.ts"
import { DeliverUnavailable } from "./AlertDelivery.ts"

// Captured callbacks contribute to the persisted plan digest.

const nonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const positive = Schema.Int.check(Schema.isGreaterThan(0))

/** One window: its start and end in epoch milliseconds, and the daily token budget the alert reports against. */
const payload = { from: nonNegative, until: positive, budget: positive }

/** A window, as the flow's payload holds it. */
export interface Window {
  readonly from: number
  readonly until: number
  readonly budget: number
}

/**
 * The execution, and the alert, for one window: one per window length and start, so every call in a window starts
 * the same execution, and a new window length after a deploy never collides with an old one.
 * @throws {never}
 */
export const executionId = (window: Pick<Window, "from" | "until">) =>
  `spend-alert-${window.until - window.from}-${window.from}`

/**
 * What the alert step did: recorded the window's alert, found it recorded already (a step that ran again), or found
 * nothing to carry. `calls`, `tokens` and `costUsd` are the alert's.
 */
const Alerted = Schema.Struct({
  outcome: Schema.Literals(["recorded", "existing", "none"]),
  calls: Schema.Number,
  tokens: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
})
type Alerted = typeof Alerted.Type

/** Postgres failed. The step retries it, and never gives up: an alert must not be lost. */
export class AlertFailed extends Schema.TaggedError<AlertFailed>()("@smthrs/mvp/ops/AlertFailed", {
  reason: Schema.Literal("database"),
}) {}

/** Only Postgres can fail the alert step, so its retries never give up. */
const retryPolicy = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

/**
 * How long until the window ends, in milliseconds, on the host's clock; 0 once it has. Sealed, so a resume keeps it.
 */
export const AlertIn = Action.make("ops/SpendAlertIn", {
  payload,
  success: Schema.Number,
  tier: "sealed",
})

/** Claims the window's calls and records its alert. */
export const Record = Action.make("ops/RecordSpendAlert", {
  payload,
  success: Alerted,
  error: AlertFailed,
  capabilities: ["db:write:model_usage", "db:write:spend_alerts"],
  retryPolicy,
})

/** The window's alert as one channel delivers it: its id, the channel, and what recording it did. */
const deliverPayload = { alertId: Schema.String, channel: Channels.Channel, outcome: Alerted.fields.outcome }

/** One delivery's payload. */
export interface DeliverRequest {
  readonly alertId: string
  readonly channel: Channels.Channel
  readonly outcome: Alerted["outcome"]
}

/**
 * `ops/DeliverSpendAlert`'s implementation version. v2 (2026-10-21) declares the step irreversible and at least once; a
 * run parked on the v1 plan stops with `plan_changed`.
 */
export const DELIVER_VERSION = "ops/deliver-spend-alert/v2"

/**
 * Sends the window's alert on one channel and records its receipt, at least once: a duplicate alert beats a lost one.
 * The send is the step's one write, so it is `irreversible`, and its key (the alert and the channel) lets a durable
 * engine run it again after a host died mid-send. Email carries the alert's id as Resend's `Idempotency-Key`, so a repeat
 * within Resend's 24 hours sends nothing new; Telegram has no key, so a repeat sends the message again.
 */
export const Deliver = Action.make("ops/DeliverSpendAlert", {
  payload: deliverPayload,
  success: AlertDelivery.Delivered,
  error: Schema.Union([Channels.DeliveryFailed, DeliverUnavailable]),
  capabilities: ["db:read:alert_channels", "db:write:alert_deliveries", "net:alert_channels"],
  implementationVersion: DELIVER_VERSION,
  tier: "irreversible",
  idempotencyKey: ({ alertId, channel }) => ({ alert: alertId, channel }),
  retryPolicy: AlertDelivery.retryPolicy,
})

/** What the flow did: the alert it recorded, and each channel's delivery. */
const Outcome = Schema.Struct({ alert: Alerted, email: AlertDelivery.Delivered, telegram: AlertDelivery.Delivered })

/**
 * `ops/SpendAlert`: once a window ends, alerts the Admins about the model spend no alert has carried yet, in the app
 * and on each channel they set.
 */
export const SpendAlert = Flow.make("ops/SpendAlert", {
  description: "Once a window ends, alert the deployment's Admins about its model spend: tokens and cost by role, " +
    "in the app and by email and Telegram where they set them.",
  capabilities: [
    "db:write:model_usage",
    "db:write:spend_alerts",
    "db:read:alert_channels",
    "db:write:alert_deliveries",
    "net:alert_channels",
  ],
  modelInvocable: false,
  payload,
  success: Outcome,
  error: Schema.Union([AlertFailed, Sleep.SleepRequestInvalid, Channels.DeliveryFailed, DeliverUnavailable]),
  body: Node.capture({}, (window: Window) =>
    AlertIn.call(window).pipe(
      Node.bindPlanned(Node.capture({}, (millis) => Sleep.action.call({ millis }))),
      Node.andThen(Record.call(window)),
      // Each channel's step takes the recorded outcome, so it starts once the alert is recorded.
      Node.bindPlanned(Node.capture({ alertId: executionId(window) }, function (alerted) {
        return Node.all({
          alert: Node.succeed(alerted),
          email: Deliver.call({ alertId: this.alertId, channel: "email", outcome: alerted.outcome }),
          telegram: Deliver.call({ alertId: this.alertId, channel: "telegram", outcome: alerted.outcome }),
        })
      })),
    )),
})

/** A role and model's calls in a claim, as Postgres sums them. */
export interface Claimed {
  readonly role: string
  readonly modelId: string
  readonly calls: number
  readonly input: number
  readonly output: number
  readonly charged: number
}

/**
 * The estimated cost of a role and model's calls, `null` for a model no rate card prices. A call's charge beyond what
 * the model reported (its reservation, kept while its usage is unknown) is priced as output, the dearer kind.
 */
export const estimate = (claimed: Pick<Claimed, "modelId" | "input" | "output" | "charged">) => {
  const cost = Pricing.cost(
    { inputTokens: claimed.input, outputTokens: Math.max(claimed.output, claimed.charged - claimed.input) },
    claimed.modelId,
  )
  return cost === undefined ? null : cost.costUsd
}
