import type { Card,Session } from "./AppState"
import { runFailure } from "./RunFailure"

/** A persisted preparation from another page load is retryable, never an endless spinner. */
export const LIBRARIAN_LAUNCH_OWNER = crypto.randomUUID()
export const LIBRARIAN_COMMANDS = { wiki: "wiki.create", history: "history.bootstrap" } as const
export const LIBRARIAN_UNCONFIRMED = "The page reloaded before Smithers could confirm the run. Check Runs before retrying."
export const librarianFailureMessage = (kind: "wiki" | "history", reason?: string) => {
  const label = kind === "wiki" ? "Wiki" : "Mythical history"
  if (reason === LIBRARIAN_UNCONFIRMED) return `${label} may have started. Check Runs before retrying, or choose Do this later.`
  return `Create ${label} didn't start: ${runFailure(reason).message}`
}

export type LibrarianRunCard = Extract<Card, { kind: "run-trace" }>
export const librarianRunKey = (card: LibrarianRunCard): string => JSON.stringify([card.payload.repo, card.payload.workspaceId, card.payload.runId])
export const librarianRunMetadata = (card: LibrarianRunCard): { kind: "wiki" | "history"; scope: string; inspected: boolean } | undefined => {
  const value = card.payload.input?._librarian
  if (!value || typeof value !== "object") return
  const row = value as { kind?: unknown; scope?: unknown; inspected?: unknown }
  if ((row.kind === "wiki" || row.kind === "history") && typeof row.scope === "string" && typeof row.inspected === "boolean") {
    return { kind: row.kind, scope: row.scope, inspected: row.inspected }
  }
}

/** Transcript copies share one run. The latest gateway revision owns its outcome. */
export const librarianRunCards = (cards: readonly Card[]): LibrarianRunCard[] => {
  const runs = new Map<string, LibrarianRunCard>()
  for (const card of cards) {
    if (card.kind !== "run-trace") continue
    const receipt = librarianRunMetadata(card)
    if (!receipt || card.payload.workflow !== `librarian/${receipt.kind}`) continue
    const key = librarianRunKey(card)
    const previous = runs.get(key)
    if (!previous || card.payload.lastSeq > previous.payload.lastSeq ||
      (card.payload.lastSeq === previous.payload.lastSeq && card.ordinal > previous.ordinal)) runs.set(key, card)
  }
  return [...runs.values()].sort((a, b) => b.createdAt - a.createdAt || b.ordinal - a.ordinal)
}

export const librarianReceiptFor = (cards: readonly Card[], entry: NonNullable<Session["librarianLaunches"]>[number]): LibrarianRunCard | undefined =>
  librarianRunCards(cards).find(card => card.payload.repo === entry.repo
    && librarianRunMetadata(card)?.scope === entry.scope && librarianRunMetadata(card)?.kind === entry.kind
    && (entry.runId === undefined ? card.createdAt >= entry.startedAt : card.payload.runId === entry.runId))
