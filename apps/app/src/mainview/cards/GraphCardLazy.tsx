/*
 * The target graph card loads its renderer (GraphCard.tsx, xyflow and dagre)
 * on first use, so the family entry lives here rather than beside the body:
 * importing GraphCard.tsx statically would pull the graph libraries into the
 * main bundle for every session that never opens a graph.
 */
import { lazy, Suspense } from "react"
import type { CardFamily } from "./CardFamily"

const GraphCardBody = lazy(() =>
  import("./GraphCard").then((module) => ({ default: module.GraphCardBody }))
)

export const graphCardFamily: CardFamily<"graph"> = {
  graph: {
    render: (card, actions) => (
      <Suspense fallback={<p className="smithers-card-note">Loading graph…</p>}>
        <GraphCardBody card={card} onRunCommand={actions.onRunCommand} />
      </Suspense>
    ),
    pill: (card) => card.payload.status
  }
}
