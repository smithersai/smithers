import { createContext } from "react"

/*
 * The tutorial and a repository route share one persisted store and one
 * conversation. A repository route (`/owner/name`, RepoLink.openRequestedRepo)
 * opens its transcript with that repository's welcome and home cards, and a
 * later visit to the tutorial would replay them. They belong to the route
 * that opened them: the tutorial's own repository step renders a
 * `repository-choice` card instead, so none of these is ever a lesson's.
 */
export const REPO_ENTRY_KINDS: ReadonlySet<string> = new Set(["repo-home", "repo-onboarding"])

/** The cards the tutorial shows: everything but a repository route's entry cards. */
export const tutorialTranscript = <Card extends { readonly kind: string }>(cards: ReadonlyArray<Card>, chatCardIds: ReadonlySet<string> = new Set()): Array<Card> =>
  cards.filter((card) => !REPO_ENTRY_KINDS.has(card.kind) || ("id" in card && chatCardIds.has(String(card.id))))

/** True beneath GuideShell: the app is the tutorial's workspace, not a repository route's. */
export const InTutorial = createContext(false)

/** Lesson cards stay with their read; chat rows retain their recorded place. */
export function guideTranscriptEntries(
  cards: ReadonlyArray<import("../state/AppState").Card>,
  messages: ReadonlyArray<import("../state/AppState").Message>,
  guide: import("../state/AppState").GuideState,
) {
  const recorded = guide.transcript ?? {}
  const latestLesson = Math.max(-1, ...cards.filter(card => recorded[card.id]?.source !== "chat")
    .map(card => recorded[card.id]?.step ?? guide.step))
  return [
    ...cards.map(card => {
      const at = recorded[card.id]
      const step = at?.step ?? guide.step
      return { kind: "card" as const, card, step: at?.source !== "chat" && step === latestLesson ? guide.step : Math.min(step, guide.step), ordinal: at?.ordinal ?? card.ordinal }
    }),
    ...messages.map(message => ({ kind: "message" as const, message,
      step: Math.min(recorded[message.id]?.step ?? 0, guide.step), ordinal: message.ordinal })),
  ].sort((a, b) => a.step - b.step || a.ordinal - b.ordinal)
}

/**
 * At the handoff, show the repository the user selected, including its entry
 * cards. A card a chat turn produced keeps its place in the guide transcript
 * beside the reply that made it, so the workspace beneath does not repeat it.
 */
export const workspaceTranscript = <Row extends { id?: string; payload: object }>(
  cards: ReadonlyArray<Row>, repo: string | null, chatCardIds: ReadonlySet<string> = new Set(),
): Array<Row> =>
  cards.filter(card => !isTutorialCard(card) && (card.id === undefined || !chatCardIds.has(card.id))
    && (repo === null || !("repo" in card.payload) || typeof card.payload.repo !== "string" || card.payload.repo === repo))

/** Practice frames retain their provenance even when an older payload lost its repo key. */
export function isTutorialCard(card: { id?: string; payload: object }): boolean {
  const payload = card.payload as { repo?: unknown; input?: { liveTutorial?: unknown } }
  return typeof payload.repo === "string" && payload.repo.startsWith("practice:")
    || payload.input?.liveTutorial !== undefined
    || /^(practice-|live-tutorial-|flow-run-practice-)/.test(card.id ?? "")
}

/** The ids the guide recorded as arriving from a chat turn during this playthrough. */
export const chatEntryIds = (
  transcript: Readonly<Record<string, { readonly source: "chat" | "lesson" }>> | undefined,
): ReadonlySet<string> =>
  new Set(Object.entries(transcript ?? {}).filter(([, at]) => at.source === "chat").map(([id]) => id))
