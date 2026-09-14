import { GUIDE_PRACTICE_END } from "../../onboarding/lessons"
import { conversationTabIdOf, inConversation } from "../AppState"
import type { AppStore } from "../AppStore"
import { activeRepositoryId } from "../RepoContext"
import { isPracticeRepo, PRACTICE_REPO, practiceIssue } from "./PracticeRepository"

/** The lesson's repository is independent of the URL that hosts the guide. */
export const isPracticeContext = (store: AppStore): boolean => {
  const guide = store.session().guide
  return isPracticeRepo(store.session().activeRepoKey) || isPracticeRepo(activeRepositoryId(store)) ||
    (guide !== undefined && !guide.finished && guide.step <= GUIDE_PRACTICE_END)
}

export const PRACTICE_CONTEXT_INSTRUCTION = `The repository on screen is ${PRACTICE_REPO}, the bundled practice repository. Answer from the practice card data in this turn; no sign-in or network is needed to read it. For further reads, pass ${PRACTICE_REPO} as the repository argument (for example issues.view 3 ${PRACTICE_REPO}). The activeRepository routing field identifies the page hosting this tutorial, not the subject of practice questions.`

/** Fresh card facts, without presentation assets or another conversation's cards. */
export const practiceContextMessage = (store: AppStore): string | undefined => {
  if (!isPracticeContext(store)) return undefined
  const session = store.session()
  const cards = [...store.collections.cards.values()].filter(card =>
    inConversation(card, conversationTabIdOf(session)) && "repo" in card.payload && typeof card.payload.repo === "string" && isPracticeRepo(card.payload.repo))
  const savedIssue = store.collections.practiceIssues.get(`${session.guide?.playthrough ?? 0}:3`)
  const issue = cards.find(card => card.kind === "issue" && card.payload.number === 3)
  const issuePayload = issue?.kind === "issue" ? issue.payload
    : savedIssue?.card.kind === "issue" ? savedIssue.card.payload : practiceIssue(3)
  const facts = {
    revision: session.revision,
    visibleCards: cards.map(card => ({ kind: card.kind, title: card.title, payload: card.payload })),
    // The list invites questions about #3 before its detail card is opened.
    issue3: issuePayload,
  }
  return `${PRACTICE_CONTEXT_INSTRUCTION}\nPractice card data:\n${JSON.stringify(facts, (key, value) =>
    /avatar/i.test(key) || (typeof value === "string" && value.startsWith("data:")) ? undefined : value)}`
}
