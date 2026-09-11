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
export const tutorialTranscript = <Card extends { readonly kind: string }>(cards: ReadonlyArray<Card>): Array<Card> =>
  cards.filter((card) => !REPO_ENTRY_KINDS.has(card.kind))

/** True beneath GuideShell: the app is the tutorial's workspace, not a repository route's. */
export const InTutorial = createContext(false)
