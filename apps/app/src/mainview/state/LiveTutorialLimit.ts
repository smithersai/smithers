import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalLead } from "@smthrs/rpc/RefusalCopy"
import { z } from "zod"
import type { Card } from "./AppState"

/** A refused launch is not an accepted run to reconnect to. Stored with its request. */
export const LiveTutorialLimitSchema = z.object({
  kind: z.literal("rate-limit"),
  code: z.string().optional(),
  retryAt: z.number().finite().optional(),
})
export type LiveTutorialLimit = z.infer<typeof LiveTutorialLimitSchema>

export function activeLiveTutorialLimit(card: Card | undefined, now = Date.now()): LiveTutorialLimit | undefined {
  if (card?.kind !== "run-trace") return
  const parsed = LiveTutorialLimitSchema.safeParse(card.payload.input?.liveTutorialLimit)
  if (!parsed.success || (parsed.data.retryAt !== undefined && parsed.data.retryAt <= now)) return
  return parsed.data
}

export function liveTutorialLimitMessage(limit: LiveTutorialLimit): string {
  const retry = limit.retryAt === undefined ? "Try practice again later" :
    `Return to practice after ${new Date(limit.retryAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`
  const lead = refusalLead(refusalOf({ body: { code: limit.code ?? "turn_rate_limited" }, status: 429, message: "" }))
  return `${lead} This practice run did not start because agent runs are temporarily limited. ${retry}, or continue without practice.`
}
