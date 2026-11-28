import type { CiJob } from "@smthrs/sandbox"

/** Exit codes assigned by the hosted pinned checkout, also readable by older CI receipt clients. */
export const pinnedCheckoutExit = { init: 73, remote: 74, fetch: 75, worktree: 76 } as const

export type PinnedCheckoutStage = keyof typeof pinnedCheckoutExit

const stages = new Map<number, PinnedCheckoutStage>(
  (Object.keys(pinnedCheckoutExit) as PinnedCheckoutStage[]).map((stage) => [pinnedCheckoutExit[stage], stage]),
)

/** Generic process exit codes are meaningful here only for this host's checkout failure. */
export const pinnedCheckoutStage = (failure: string, exitCode: number | null | undefined) =>
  failure === "clone" && exitCode != null ? stages.get(exitCode) : undefined

const transportCauseWords: Readonly<Record<CiJob.CheckoutTransportCause, string>> = {
  http_status: "HTTP error",
  dns: "DNS error",
  missing_object: "Missing object",
  pack_storage: "Pack or storage",
  interrupted: "Interrupted",
  unknown: "Unknown cause",
}

/** Formats a bounded machine-side transport cause for display, omitting it for historical receipts. */
export const checkoutTransportLabel = (
  cause: CiJob.CheckoutTransportCause | undefined,
  httpStatus: CiJob.CheckoutHttpStatus | undefined,
): string | undefined => {
  if (cause === undefined) return undefined
  if (cause === "http_status" && httpStatus !== undefined) return `HTTP ${httpStatus}`
  return transportCauseWords[cause]
}
