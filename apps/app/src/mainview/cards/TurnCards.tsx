/*
 * The agent turn's own cards: the plan it is following and a status line with
 * optional progress. Both render the turn's Markdown body when it has one.
 */
import { Markdown, Plan, PlanContent, PlanStep, Progress } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"

const PlanCardBody = ({ card }: { readonly card: Extract<Card, { kind: "plan" }> }) => (
  <>
    {card.body !== undefined ? <Markdown className="smithers-card-markdown" content={card.body} /> : null}
    <Plan defaultOpen>
      <PlanContent>
        <ol className="sui-plan-steps">
          {card.payload.items.map((item) => <PlanStep key={item.id} label={item.title} status={item.status} />)}
        </ol>
      </PlanContent>
    </Plan>
  </>
)


const StatusCardBody = ({ card }: { readonly card: Extract<Card, { kind: "status" }> }) => (
  <>
    {card.body !== undefined ? <Markdown className="smithers-card-markdown" content={card.body} /> : null}
    {card.payload.progress !== undefined ?
      <Progress className="smithers-card-progress" value={Math.round(card.payload.progress * 100)} /> :
      null}
    {card.payload.note !== undefined ? <p className="smithers-card-note">{card.payload.note}</p> : null}
  </>
)


export const turnCardFamily: CardFamily<"plan" | "status"> = {
  plan: {
    render: (card) => <PlanCardBody card={card} />,
    pill: (card) => {
      if (card.status === "acted") return "done"
      if (card.payload.items.length > 0 && card.payload.items.every((item) => item.status === "done")) {
        return "done"
      }
      if (card.payload.items.some((item) => item.status === "active")) return "running"
      return "pending"
    }
  },
  status: {
    render: (card) => <StatusCardBody card={card} />,
    pill: (card) => {
      if (card.status === "acted") return "done"
      const progress = card.payload.progress
      return progress !== undefined && progress >= 1 ? "done" : "running"
    }
  }
}
