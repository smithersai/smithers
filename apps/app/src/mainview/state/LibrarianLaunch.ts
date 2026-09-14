import type { GuideState } from "./AppState"

/** A persisted preparation from another page load is retryable, never an endless spinner. */
export const LIBRARIAN_LAUNCH_OWNER = crypto.randomUUID()
export const LIBRARIAN_COMMANDS = { wiki: "wiki.create", history: "history.bootstrap" } as const
export const LIBRARIAN_UNCONFIRMED = "The page reloaded before Smithers could confirm the run. Check Runs before retrying."
export const librarianFailureMessage = (kind: "wiki" | "history", reason?: string) => {
  const label = kind === "wiki" ? "Wiki" : "Mythical history"
  if (reason === LIBRARIAN_UNCONFIRMED) return `${label} may have started. Check Runs before retrying, or choose Do this later.`
  return `${label} couldn't start. Retry ${label}, or choose Do this later to keep going.`
}

/** Saved failures from before per-action receipts remain readable and retryable. */
export function legacyLibrarianFailure(guide: GuideState): { kind: "wiki" | "history"; error: string } | undefined {
  if (guide.step !== 12) return
  for (const [kind, label] of [["wiki", "Create Wiki"], ["history", "Create Mythical history"]] as const) {
    const prefix = `${label} didn't start: `
    if (guide.notice?.startsWith(prefix)) return { kind, error: guide.notice.slice(prefix.length) }
  }
}

/** Select the latest intent for this guide's repository and playthrough. */
export function librarianLaunchFor(guide: GuideState, kind: "wiki" | "history") {
  return [...(guide.librarianLaunches ?? [])].reverse().find(entry => {
    if (entry.kind !== kind || (guide.repo && entry.repo !== guide.repo)) return false
    try { return JSON.parse(entry.scope)[5] === (guide.playthrough ?? 0) } catch { return false }
  })
}
