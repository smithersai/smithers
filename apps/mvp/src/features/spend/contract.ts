// Spend alerts' contract between the browser and ChatApi (docs/features/spend-alerts.md): the shape route, the table
// and the records the feature makes. Nothing here imports a library, so every side can.

/** `GET`: Electric's `spend_alerts`, only for an Admin; anyone else gets a shape with no rows. */
export const SPEND_ALERTS_SHAPE_ROUTE = "/api/shapes/spend-alerts"

/** The Postgres table: one row per alert. */
export const SPEND_ALERTS_TABLE = "spend_alerts"

/** The columns a device syncs: all of them but `audience`, which the shape filters on. */
export const SPEND_ALERT_COLUMNS = [
  "id",
  "kind",
  "window_start",
  "window_end",
  "calls",
  "tokens",
  "cost_usd",
  "roles",
  "day_tokens",
  "budget",
  "created_at",
] as const

/** `POST`: an Admin sets one channel's destinations, `{ channel, destinations }`; none turns the channel off. */
export const ALERT_CHANNELS_ROUTE = "/api/alert-channels"

/** `GET`: Electric's `alert_channels`, only for an Admin. */
export const ALERT_CHANNELS_SHAPE_ROUTE = "/api/shapes/alert-channels"

/** `GET`: Electric's `alert_deliveries`, only for an Admin. */
export const ALERT_DELIVERIES_SHAPE_ROUTE = "/api/shapes/alert-deliveries"

/** The Postgres table of the deployment's channels: one row per channel that is on. */
export const ALERT_CHANNELS_TABLE = "alert_channels"

/** The Postgres table of receipts: one row per alert and channel. */
export const ALERT_DELIVERIES_TABLE = "alert_deliveries"

/** The channels' columns a device syncs. */
export const ALERT_CHANNEL_COLUMNS = ["channel", "destinations", "updated_at"] as const

/** The receipts' columns a device syncs. */
export const ALERT_DELIVERY_COLUMNS = [
  "alert_id",
  "channel",
  "status",
  "code",
  "reason",
  "http_status",
  "attempts",
  "updated_at",
] as const

/** The most destinations one channel holds: email addresses; Telegram holds one chat. */
export const MAX_DESTINATIONS = 10

/** The largest `POST /api/alert-channels` body, in bytes. */
export const MAX_ALERT_CHANNEL_BODY_BYTES = 4_096

/**
 * `POST`: an Admin sets the sandbox limits, `{ awake, perPerson, monthlyAlertUsd }` (ruling AUTH-5,
 * docs/features/sandbox-budgets.md). They apply to the next machine that wakes, with no deploy.
 */
export const SANDBOX_LIMITS_ROUTE = "/api/sandbox-limits"

/** `GET`: Electric's `sandbox_limits`, only for an Admin. */
export const SANDBOX_LIMITS_SHAPE_ROUTE = "/api/shapes/sandbox-limits"

/** The Postgres table of the limits: one row once an Admin set them. */
export const SANDBOX_LIMITS_TABLE = "sandbox_limits"

/** The limits' columns a device syncs. */
export const SANDBOX_LIMIT_COLUMNS = ["audience", "awake", "awake_per_person", "monthly_alert_usd", "updated_at"] as const

/**
 * The sandbox limits: at most `awake` machines awake in the deployment, `perPerson` of them a person's branch machines,
 * and an alert to the Admins once a month's sandbox spend reaches `monthlyAlertUsd` dollars (0: no alert).
 */
export interface SandboxLimits {
  readonly awake: number
  readonly perPerson: number
  readonly monthlyAlertUsd: number
}

/** The limits until an Admin sets them (Will's numbers, 2026-10-19 22:43; decision 0103). */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = { awake: 20, perPerson: 2, monthlyAlertUsd: 100 }

/** Each limit's bounds, inclusive, as Postgres checks them. */
export const SANDBOX_LIMIT_BOUNDS: { readonly [K in keyof SandboxLimits]: readonly [number, number] } = {
  awake: [1, 1000],
  perPerson: [1, 100],
  monthlyAlertUsd: [0, 1_000_000],
}

/** The largest `POST /api/sandbox-limits` body, in bytes. */
export const MAX_SANDBOX_LIMITS_BODY_BYTES = 1_024

/** Where an alert's message links: the app's own page on the origin the Admin set the channel from. */
export const APP_PATH = "/app"

/**
 * What spend alerts record in the browser, by name, and the attributes they carry (docs/observability.md#spend-alerts):
 * each alert an Admin's tab shows, each one hidden, and each Save of a channel (`destinations` is a count). None
 * carries anything anyone asked, an address or a chat id. src/telemetry.ts merges them into what ChatApi's relay keeps.
 */
export const SPEND_TELEMETRY = {
  records: [
    "spend.alert.shown",
    "spend.alert.hidden",
    "smithers_web_spend_alerts_shown",
    "smithers_web_spend_alerts_hidden",
    "alerts.channel.set",
    "smithers_web_alert_channel_sets",
  ],
  fields: ["alertId", "calls", "tokens", "channel", "destinations", "outcome", "status", "code"],
} as const

/** A Telegram chat id, as an input's `pattern` checks it: the same rule as `Channels.isTelegramChatId`. */
export const TELEGRAM_CHAT_PATTERN = "-?[1-9][0-9]{0,19}|@[A-Za-z][A-Za-z0-9_]{4,31}"

/** The destinations a person typed: split on commas and spaces, blanks dropped. */
export const splitDestinations = (typed: string): ReadonlyArray<string> =>
  typed.split(/[\s,]+/u).filter((value) => value !== "")
