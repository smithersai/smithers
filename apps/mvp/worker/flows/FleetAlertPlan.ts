import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Channels } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import * as Fleet from "../runners/Fleet.vibe"
import * as AlertDelivery from "./AlertDelivery.ts"

// Captured callbacks contribute to the persisted plan digest.
const nonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Postgres failed a step. It retries, and never gives up. */
export class FleetAlertUnavailable extends Schema.TaggedError<FleetAlertUnavailable>()(
  "@smthrs/mvp/ops/FleetAlertUnavailable",
  { reason: Schema.Literal("database") },
) {}

export const retryPolicy = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

/** What the bell did: whom it reached, `none` when the incident's subject is gone. */
export const Belled = Schema.Struct({ outcome: Schema.Literals(["written", "none"]), recipients: nonNegative })
export type Belled = typeof Belled.Type

/** Records the incident and puts it in each recipient's bell, once. */
export const Bell = Action.make("ops/BellFleetAlert", {
  payload: Fleet.Alert.fields,
  success: Belled,
  error: FleetAlertUnavailable,
  capabilities: ["db:read:agent_runs", "db:read:todos", "db:read:runners", "db:write:fleet_alerts", "db:write:notifications"],
  retryPolicy,
})

/** Sends the incident on one channel and records its receipt, at least once, as every alert's delivery does. */
export const Deliver = Action.make("ops/DeliverFleetAlert", {
  payload: { alertId: Fleet.Alert.fields.alertId, channel: Channels.Channel },
  success: AlertDelivery.Delivered,
  error: Schema.Union([Channels.DeliveryFailed, AlertDelivery.DeliverUnavailable]),
  capabilities: ["db:read:fleet_alerts", "db:read:alert_channels", "db:write:alert_deliveries", "net:alert_channels"],
  tier: "irreversible",
  idempotencyKey: ({ alertId, channel }) => ({ alert: alertId, channel }),
  retryPolicy: AlertDelivery.retryPolicy,
})

const Outcome = Schema.Struct({ email: AlertDelivery.Delivered, telegram: AlertDelivery.Delivered })

/** `ops/FleetAlert`: one incident, to its people's bells and the deployment's channels. */
export const FleetAlert = Flow.make("ops/FleetAlert", {
  description: "Tell the people an agent run or runner incident is for: a run that failed, stalled, waited too long " +
    "for a runner or cost too much, or a runner that went offline. In their notifications, and by email and Telegram " +
    "where an Admin set them.",
  capabilities: [
    "db:read:agent_runs",
    "db:read:todos",
    "db:read:runners",
    "db:write:fleet_alerts",
    "db:write:notifications",
    "db:read:alert_channels",
    "db:write:alert_deliveries",
    "net:alert_channels",
  ],
  modelInvocable: false,
  payload: Fleet.Alert.fields,
  success: Outcome,
  error: Schema.Union([FleetAlertUnavailable, Channels.DeliveryFailed, AlertDelivery.DeliverUnavailable]),
  body: Node.capture({}, (alert: Fleet.Alert) =>
    Bell.call(alert).pipe(
      Node.andThen(Node.all({
        email: Deliver.call({ alertId: alert.alertId, channel: "email" }),
        telegram: Deliver.call({ alertId: alert.alertId, channel: "telegram" }),
      })),
    )),
})
