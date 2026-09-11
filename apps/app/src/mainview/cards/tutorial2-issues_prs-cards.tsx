import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { CardView } from "../ChatCards"
import { activeRepositoryId, resolveOpenRepo } from "../state/RepoContext"
import { cardActions } from "./CardActions"

/** The tutorial projects the same durable cards as the workspace transcript. */
export function TutorialIssuesPrsCards() {
  const controller = useController()
  const { data: cards } = useLiveQuery(controller.store.collections.cards)
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const { data: identities } = useLiveQuery(controller.store.collections.identitySessions)
  const session = sessions[0]
  const local = session?.activeRepoKey?.startsWith("local:") ? resolveOpenRepo(controller.store) : undefined
  const repo = activeRepositoryId(controller.store) ?? (local && "repo" in local ? local.repo.path : undefined)
  const visible = cards.filter(card => {
    if (card.kind === "flow-form") return card.id === "form-issues.list" || card.id === "form-prs.list"
    return (card.kind === "issue-list" || card.kind === "issue" || card.kind === "pr-list" || card.kind === "pr") && card.payload.repo === repo
  }).sort((a, b) => a.ordinal - b.ordinal)
  return <>{visible.map(card => <CardView key={card.id} card={card}
    maximized={session?.maximizedCardId === card.id}
    signedOut={identities[0]?.state === "signed-out"}
    worldDocuments={[]} {...cardActions(controller)} />)}</>
}
