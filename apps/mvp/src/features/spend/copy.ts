import type { AlertDelivery, SpendAlert } from "./schema"

// What a spend alert's notification says (docs/features/spend-alerts.md): its word, then the window's tokens and estimated
// cost, with the role when one role spent, or each role's tokens when several did.

/** The toast's word, in place of its state's. */
export const ALERT_WORD = "Model spend"

const count = (value: number) => Math.round(value).toLocaleString("en-US")

const dollars = (usd: number) => (usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`)

/** `agent · 12,340 tokens · $0.02`, or with several roles `12,340 tokens · $0.02 · agent 12,000 · judge 340`. */
export const alertDetail = (alert: Pick<SpendAlert, "tokens" | "costUsd" | "roles">): string => {
  const total = [`${count(alert.tokens)} tokens`, ...(alert.costUsd === null ? [] : [dollars(alert.costUsd)])]
  const [only] = alert.roles
  if (alert.roles.length === 1 && only !== undefined) return [only.role, ...total].join(" · ")
  return [...total, ...alert.roles.map((role) => `${role.role} ${count(role.tokens)}`)].join(" · ")
}

/** What an alert's message carries: the window, its tokens and cost, and each role's tokens. */
export interface AlertSummary {
  readonly from: number
  readonly until: number
  readonly tokens: number
  readonly costUsd: number | null
  readonly roles: ReadonlyArray<Pick<SpendAlert["roles"][number], "role" | "tokens">>
}

/** How many roles a message names: the ones that spent the most. */
export const MESSAGE_ROLES = 3

/** `15:00–15:15 UTC, 2026-10-20`; a window over midnight names both days. */
const windowText = (from: number, until: number) => {
  const [startDay, startTime] = new Date(from).toISOString().slice(0, 16).split("T")
  const [endDay, endTime] = new Date(until).toISOString().slice(0, 16).split("T")
  return startDay === endDay
    ? `${startTime}–${endTime} UTC, ${startDay}`
    : `${startDay} ${startTime} – ${endDay} ${endTime} UTC`
}

/**
 * The email and Telegram message for an alert (docs/features/spend-alerts.md#channels): the subject is the word, the
 * tokens and the cost; the text is the window, the roles that spent most, and the link to the app.
 */
export const alertMessage = (alert: AlertSummary, appUrl: string) => {
  const top = [...alert.roles].sort((left, right) => right.tokens - left.tokens).slice(0, MESSAGE_ROLES)
  return {
    subject: [ALERT_WORD, `${count(alert.tokens)} tokens`, ...(alert.costUsd === null ? [] : [dollars(alert.costUsd)])]
      .join(" · "),
    text: [
      windowText(alert.from, alert.until),
      top.map((role) => `${role.role} ${count(role.tokens)}`).join(" · "),
      appUrl,
    ].filter((line) => line !== "").join("\n"),
  }
}

/** The settings' heading for spend alerts. */
export const ALERTS_HEADING = "Spend alerts"

/** Each channel's field. */
export const CHANNEL_LABEL = { email: "Email", telegram: "Telegram chat" } as const

/** The save button, and a save that hasn't landed. */
export const SAVE = "Save"
export const SAVING = "Saving"
export const NOT_SAVED = "Not saved"

/** A receipt's words: `Sent`, `Refused · Bad Request: chat not found`, `Retrying · unavailable`. */
export const receiptText = (receipt: Pick<AlertDelivery, "status" | "code" | "reason">): string => {
  const why = receipt.reason ?? receipt.code
  const word = receipt.status === "sent" ? "Sent" : receipt.status === "refused" ? "Refused" : "Retrying"
  return receipt.status === "sent" || why === null ? word : `${word} · ${why}`
}
