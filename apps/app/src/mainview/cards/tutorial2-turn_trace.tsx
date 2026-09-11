import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { CardView } from "../ChatCards"
import { cardActions } from "./CardActions"
import { activeRepositoryId } from "../state/RepoContext"

/** Root mounts the existing card projection inside the lesson while its workspace is hidden. */
export function TutorialTraceCards() {
  const controller = useController()
  const { data: cards } = useLiveQuery(controller.store.collections.cards)
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const repo = activeRepositoryId(controller.store)
  const session = sessions[0]
  const selected = cards.filter(card => card.kind === "flow-form"
    ? card.payload.flow === "runs.steps" || card.payload.flow === "runs.trace.select"
    : card.kind === "run-trace" && card.payload.repo === repo && card.payload.workflow === "tutorial-change")
  return <div data-tutorial-traces="">
    {selected.sort((a, b) => a.ordinal - b.ordinal).map(card => <CardView
      key={card.id} card={card} maximized={session?.maximizedCardId === card.id}
      worldDocuments={[]} {...cardActions(controller)}
    />)}
  </div>
}
