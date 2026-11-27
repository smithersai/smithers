/** Exit codes assigned by the hosted pinned checkout, also readable by older CI receipt clients. */
export const pinnedCheckoutExit = { init: 73, remote: 74, fetch: 75, worktree: 76 } as const

export type PinnedCheckoutStage = keyof typeof pinnedCheckoutExit

const stages = new Map<number, PinnedCheckoutStage>(
  (Object.keys(pinnedCheckoutExit) as PinnedCheckoutStage[]).map((stage) => [pinnedCheckoutExit[stage], stage]),
)

/** Generic process exit codes are meaningful here only for this host's checkout failure. */
export const pinnedCheckoutStage = (failure: string, exitCode: number | null | undefined) =>
  failure === "clone" && exitCode != null ? stages.get(exitCode) : undefined
