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

const forgeRoutingWords: Readonly<Record<Exclude<CiJob.CheckoutForgeRouting, "reached">, string>> = {
  unreached: "Forge unreached",
  host_mismatch: "Forge host mismatch",
  no_branch: "Forge no branch",
  unscoped: "Forge unscoped",
  failed: "Forge error",
}

const forgeSourceWord = (
  source: CiJob.CheckoutForgeStageReceipt["source"],
  upstream: CiJob.CheckoutForgeUpstream | undefined,
): string => (source === "proxy" ? "Proxy" : upstream === "deployment" ? "Mirror" : "GitHub")

const isFailedStage = (stage: CiJob.CheckoutForgeStageReceipt): boolean =>
  stage.outcome !== "ok" || stage.status >= 400

/** Formats a bounded host-side forge receipt succinctly for display, omitting it on historical receipts. */
export const checkoutForgeLabel = (forge: CiJob.CheckoutForgeReceipt | undefined): string | undefined => {
  if (forge === undefined) return undefined
  if (forge.routing !== "reached") return forgeRoutingWords[forge.routing]
  if (forge.uploadPack !== undefined && isFailedStage(forge.uploadPack)) {
    return `${forgeSourceWord(forge.uploadPack.source, forge.upstream)} upload-pack ${forge.uploadPack.status}`
  }
  if (forge.infoRefs !== undefined && isFailedStage(forge.infoRefs)) {
    return `${forgeSourceWord(forge.infoRefs.source, forge.upstream)} info-refs ${forge.infoRefs.status}`
  }
  if (forge.refused !== undefined) return `Proxy refused ${forge.refused.status}`
  if (forge.uploadPack !== undefined) {
    return `${forgeSourceWord(forge.uploadPack.source, forge.upstream)} upload-pack ${forge.uploadPack.status}`
  }
  if (forge.infoRefs !== undefined) {
    return `${forgeSourceWord(forge.infoRefs.source, forge.upstream)} info-refs ${forge.infoRefs.status}`
  }
  return "Forge reached"
}
