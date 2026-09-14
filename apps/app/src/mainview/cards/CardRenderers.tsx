import { repositoryUpdateCardFamily } from "./RepositoryUpdateCard"
/*
 * The card renderer map: every card kind, from the family that owns it.
 *
 * Each family file under ./ exports its slice (CardFamily.ts). This file
 * spreads the slices into one record keyed by kind; the mapped type makes a
 * kind without an entry a compile error, and CardRenderers.test.ts proves the
 * slices are disjoint and cover exactly the wire's card kinds. A new card kind
 * is one import plus one spread line here.
 */
import type { Card } from "../state/AppState"
import { accountCardFamily } from "./AccountCard"
import { adminCardFamily } from "./AdminCards"
import { affectedCardFamily } from "./AffectedCard"
import { agentCardFamily } from "./AgentCards"
import { anonymousCeilingCardFamily } from "./AnonymousCeilingCard"
import { approvalCardFamily } from "./ApprovalCard"
import { billingCardFamily } from "./BillingCards"
import { branchesCardFamily } from "./BranchesCard"
import type { CardActions, CardFamily, CardFamilyEntry } from "./CardFamily"
import { changeCardFamily } from "./ChangeCards"
import { commitPickCardFamily } from "./CommitPickCard"
import { commitCardFamily } from "./CommitCards"
import { ciMatrixCardFamily } from "./CiMatrixCard"
import { conversationCardFamily } from "./ConversationCards"
import { envCardFamily } from "./EnvCard"
import { factoryCardFamily } from "./FactoryCard"
import { fileCardFamily } from "./FileCards"
import { flowFormCardFamily } from "./FlowFormCards"
import { graphCardFamily } from "./GraphCardLazy"
import { historyCardFamily } from "./HistoryCard"
import { homeCardFamily } from "./HomeCards"
import { issueCardFamily } from "./IssueCards"
import { landingCardFamily } from "./LandingCards"
import { notificationsCardFamily } from "./NotificationsCard"
import { onboardingCardFamily } from "./OnboardingCards"
import { LibrarianLibraryCard } from "../plugins/tutorial2-librarian-card"
import { RepositoryChoiceCard } from "./RepositoryChoiceCard"
import { repoImportCardFamily } from "./RepoImportCard"
import { runHistoryCardFamily } from "./RunHistoryCard"
import { runsCardFamily } from "./RunsCards"
import { runTimelineCardFamily } from "./RunTimelineCard"
import { searchResultsCardFamily } from "./SearchResultsCard"
import { secretsCardFamily } from "./SecretsCard"
import { serviceLogCardFamily } from "./ServiceLogCard"
import { syncCardFamily } from "./SyncCards"
import { targetCardFamily } from "./TargetCards"
import { themePickerCardFamily } from "./ThemePickerCard"
import { triggersCardFamily } from "./TriggersCard"
import { turnCardFamily } from "./TurnCards"
import { wikiCardFamily } from "./WikiCards"
import { workflowCardFamily } from "./WorkflowCards"
import { workspaceCardFamily } from "./WorkspaceCard"

/* The tutorial's two embedded surfaces: the ranked repository chooser and the Library shelf. */
const repositoryChoiceCardFamily: CardFamily<"repository-choice"> = {
  "repository-choice": {
    render: (card, actions) => <RepositoryChoiceCard payload={card.payload} onRunCommand={actions.onRunCommand} />,
    pill: card => card.payload.created === null ? "" : "done"
  }
}

const pluginLibraryCardFamily: CardFamily<"plugin-library"> = {
  "plugin-library": {
    render: card => <LibrarianLibraryCard tutorial={card.payload.tutorial} />,
    pill: () => "done"
  }
}

/** The families in registration order; the test reads this list to prove the slices are disjoint. */
export const CARD_FAMILIES: ReadonlyArray<CardFamily<never>> = [
  turnCardFamily,
  approvalCardFamily,
  billingCardFamily,
  adminCardFamily,
  conversationCardFamily,
  workflowCardFamily,
  triggersCardFamily,
  factoryCardFamily,
  runsCardFamily,
  onboardingCardFamily,
  homeCardFamily,
  issueCardFamily,
  landingCardFamily,
  changeCardFamily,
  notificationsCardFamily,
  repositoryUpdateCardFamily,
  envCardFamily,
  secretsCardFamily,
  accountCardFamily,
  historyCardFamily,
  repoImportCardFamily,
  syncCardFamily,
  branchesCardFamily,
  fileCardFamily,
  themePickerCardFamily,
  targetCardFamily,
  graphCardFamily,
  runTimelineCardFamily,
  runHistoryCardFamily,
  affectedCardFamily,
  ciMatrixCardFamily,
  agentCardFamily,
  flowFormCardFamily,
  workspaceCardFamily,
  serviceLogCardFamily,
  anonymousCeilingCardFamily,
  searchResultsCardFamily,
  repositoryChoiceCardFamily,
  pluginLibraryCardFamily,
  wikiCardFamily,
  commitPickCardFamily,
  commitCardFamily
]

/** One entry per card kind. Written as a literal so a missing kind fails to compile. */
export const CARD_RENDERERS: CardFamily<Card["kind"]> = {
  ...turnCardFamily,
  ...approvalCardFamily,
  ...billingCardFamily,
  ...adminCardFamily,
  ...conversationCardFamily,
  ...workflowCardFamily,
  ...triggersCardFamily,
  ...factoryCardFamily,
  ...runsCardFamily,
  ...onboardingCardFamily,
  ...homeCardFamily,
  ...issueCardFamily,
  ...landingCardFamily,
  ...changeCardFamily,
  ...commitPickCardFamily,
  ...commitCardFamily,
  ...notificationsCardFamily,
  ...repositoryUpdateCardFamily,
  ...envCardFamily,
  ...secretsCardFamily,
  ...accountCardFamily,
  ...historyCardFamily,
  ...repoImportCardFamily,
  ...syncCardFamily,
  ...branchesCardFamily,
  ...fileCardFamily,
  ...themePickerCardFamily,
  ...targetCardFamily,
  ...graphCardFamily,
  ...runTimelineCardFamily,
  ...runHistoryCardFamily,
  ...affectedCardFamily,
  ...ciMatrixCardFamily,
  ...agentCardFamily,
  ...flowFormCardFamily,
  ...workspaceCardFamily,
  ...serviceLogCardFamily,
  ...anonymousCeilingCardFamily,
  ...searchResultsCardFamily,
  ...repositoryChoiceCardFamily,
  ...pluginLibraryCardFamily,
  ...wikiCardFamily
}

/** The entry for one kind, typed to that kind's card. */
export const cardRenderer = <K extends Card["kind"]>(kind: K): CardFamilyEntry<K> => CARD_RENDERERS[kind]

/**
 * The header's status word. Forms keep refusals in their body; other error cards wear "failed";
 * otherwise the family that owns the kind answers.
 */
export const pillStatus = (card: Card): string => {
  if (card.status === "error" && card.kind !== "flow-form") return "failed"
  return cardRenderer(card.kind).pill(card)
}

/** The card's body, from the family that owns its kind. */
export const renderCardBody = (card: Card, actions: CardActions) => cardRenderer(card.kind).render(card, actions)
