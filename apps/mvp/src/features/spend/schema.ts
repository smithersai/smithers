import { Schema } from "effect"
import { SANDBOX_LIMIT_BOUNDS } from "./contract"

// Spend alerts' rows (docs/features/spend-alerts.md): the `spend_alerts` row Electric delivers, and this device's mark
// of what an Admin has seen. A row stored on the device is read by the next version of the app too: change its shape
// only with its collection's `schemaVersion`.

/** One role's spend in an alert: its calls, the tokens they were charged and their estimated cost, `null` unpriced. */
export const RoleSpend = Schema.Struct({
  role: Schema.String,
  calls: Schema.Number,
  tokens: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
})
export type RoleSpend = typeof RoleSpend.Type

/**
 * One row of Postgres `spend_alerts` as Electric delivers it: columns in camelCase, `bigint`s as numbers, `roles`
 * parsed. One alert carries the model spend of one window: calls, tokens charged, estimated cost (`null` when a model
 * isn't priced) by role, and today's tokens against the daily budget.
 */
export const SpendAlert = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("model"),
  windowStart: Schema.String,
  windowEnd: Schema.String,
  calls: Schema.Number,
  tokens: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
  roles: Schema.Array(RoleSpend),
  dayTokens: Schema.Number,
  budget: Schema.Number,
  createdAt: Schema.String,
})
export type SpendAlert = typeof SpendAlert.Type

/**
 * What this device has seen, one row per alert kind: Hide on an alert marks it and every earlier one seen (`through`,
 * the hidden alert's `createdAt`), so only later alerts show.
 */
export const Seen = Schema.Struct({ kind: Schema.String, through: Schema.String })
export type Seen = typeof Seen.Type

/** A channel spend alerts go out on: email or Telegram (`@smthrs/notifications` `Channels.Channel`). */
export const AlertChannelName = Schema.Literals(["email", "telegram"])
export type AlertChannelName = typeof AlertChannelName.Type

/**
 * One row of Postgres `alert_channels` as Electric delivers it: a channel an Admin turned on, its destinations (email
 * addresses, or one Telegram chat id) and when it changed.
 */
export const AlertChannel = Schema.Struct({
  channel: AlertChannelName,
  destinations: Schema.Array(Schema.String),
  updatedAt: Schema.String,
})
export type AlertChannel = typeof AlertChannel.Type

/**
 * One row of Postgres `alert_deliveries`: an alert's receipt on one channel. `sent`; `refused` for good, with its
 * `code`, the provider's short `reason` and the `httpStatus`; or `failed`, retried by the server until it is sent or a
 * day passes.
 */
export const AlertDelivery = Schema.Struct({
  alertId: Schema.String,
  channel: AlertChannelName,
  status: Schema.Literals(["sent", "refused", "failed"]),
  code: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  httpStatus: Schema.NullOr(Schema.Number),
  attempts: Schema.Number,
  updatedAt: Schema.String,
})
export type AlertDelivery = typeof AlertDelivery.Type

/** This tab's last save of a channel: still `saving`, or `failed` and to be saved again. A save that lands is removed. */
export const ChannelSave = Schema.Struct({
  channel: AlertChannelName,
  state: Schema.Literals(["saving", "failed"]),
})
export type ChannelSave = typeof ChannelSave.Type

/** `POST /api/alert-channels`'s body. */
export const SetChannelRequest = Schema.Struct({
  channel: AlertChannelName,
  destinations: Schema.Array(Schema.String),
})
export type SetChannelRequest = typeof SetChannelRequest.Type

const bounded = ([minimum, maximum]: readonly [number, number]) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

/** The sandbox limits an Admin sets (`POST /api/sandbox-limits`'s body), each a whole number within its bounds. */
export const SandboxLimitsRequest = Schema.Struct({
  awake: bounded(SANDBOX_LIMIT_BOUNDS.awake),
  perPerson: bounded(SANDBOX_LIMIT_BOUNDS.perPerson),
  monthlyAlertUsd: bounded(SANDBOX_LIMIT_BOUNDS.monthlyAlertUsd),
})
export type SandboxLimitsRequest = typeof SandboxLimitsRequest.Type

/** One row of Postgres `sandbox_limits` as Electric delivers it: the limits an Admin set, and when. */
export const SandboxLimitsRow = Schema.Struct({
  audience: Schema.Literal("admin"),
  awake: Schema.Number,
  awakePerPerson: Schema.Number,
  monthlyAlertUsd: Schema.Number,
  updatedAt: Schema.String,
})
export type SandboxLimitsRow = typeof SandboxLimitsRow.Type

/** This tab's last save of the sandbox limits: still `saving`, or `failed` and to be saved again. */
export const LimitsSave = Schema.Struct({
  id: Schema.Literal("sandbox"),
  state: Schema.Literals(["saving", "failed"]),
})
export type LimitsSave = typeof LimitsSave.Type
