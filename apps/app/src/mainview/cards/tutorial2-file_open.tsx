import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { CardView } from "../ChatCards"
import { cardActions } from "./CardActions"
import { fileTargetKey } from "../state/seams/tutorial2-file_open"

/** Same persisted cards and flow bindings as the workspace transcript, inside lesson 5. */
export function TutorialFileCards() {
  const controller = useController()
  const { data: cards } = useLiveQuery(controller.store.collections.cards)
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const session = sessions[0]
  const repo = fileTargetKey(controller.store)
  const selected = cards.filter(card =>
    card.kind === "flow-form" ? card.payload.flow === "files.read" :
      (card.kind === "file" || card.kind === "file-list") && (card.payload.localRepoId ?? card.payload.repo) === repo)
  return <div data-tutorial-files="">
    {selected.sort((a, b) => a.ordinal - b.ordinal).map(card => <CardView
      key={card.id}
      card={card}
      maximized={session?.maximizedCardId === card.id}
      worldDocuments={[]}
      {...cardActions(controller)}
    />)}
  </div>
}
