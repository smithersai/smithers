import { ViewSkeleton } from "../ViewSkeleton"
import { GraphCardBody } from "../ViewModules"
/*
 * The target graph card loads its renderer (GraphCard.tsx, xyflow and dagre)
 * on first use, so the family entry lives here rather than beside the body:
 * importing GraphCard.tsx statically would pull the graph libraries into the
 * main bundle for every session that never opens a graph.
 */
import { Suspense } from "react"
import type { CardFamily } from "./CardFamily"



export const graphCardFamily: CardFamily<"graph"> = {
  graph: {
    render: (card, actions) => (
      <Suspense fallback={<ViewSkeleton />}>
        <GraphCardBody card={card} onRunCommand={actions.onRunCommand} />
      </Suspense>
    ),
    pill: (card) => card.payload.status
  }
}
