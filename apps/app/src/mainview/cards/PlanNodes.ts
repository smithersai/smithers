/*
 * One plan node, cut down to what a card carries.
 *
 * The control plane answers a plan with fully keyed nodes, and a card payload
 * is written to disk by the persistence backend: one node's key material is
 * tens of kilobytes of JSON schema. Both the launch that snapshots a plan onto
 * a run card and the script that records the graph fixture reduce a node the
 * same way, so the reduction lives here rather than twice.
 */
import type { PlanGraph, PlanNode } from "@smthrs/control/ControlSchema"
import type { Card } from "../state/AppState"

/** One node of a plan, exactly as a card carries it. */
export type PlanCardNode = NonNullable<Extract<Card, { kind: "flow-plan" }>["payload"]["nodes"]>[number]

/**
 * The address, the key, the edges, the tier and the action the node
 * dispatches, and nothing else.
 *
 * The tier is the material's own `kind`; the action is the ACTION or FLOW the
 * node calls, read off the hashed body the graph builder wrote. A merge node
 * calls neither and names no action rather than borrowing one.
 */
export const planCardNode = (node: PlanNode): PlanCardNode => {
  const body = node.material.body
  const named = typeof body === "object" && body !== null ? body as { readonly action?: unknown; readonly flow?: unknown } : {}
  const action = typeof named.action === "string" ? named.action : typeof named.flow === "string" ? named.flow : undefined
  return {
    id: node.id,
    kind: node.kind,
    key: node.key,
    dependsOn: [...node.dependsOn],
    tier: node.material.kind,
    ...(action === undefined ? {} : { action }),
    status: node.status
  }
}

/** The graph beside a plan, exactly as a card carries it. */
export type PlanCardGraph = NonNullable<Extract<Card, { kind: "flow-plan" }>["payload"]["graph"]>

/**
 * The labelled edges and the declaration sites, and nothing else.
 *
 * Both are the graph builder's own observations — `dependsOn` says which
 * nodes wait, only this says why, and the declaration site is deliberately
 * outside the key material — so both travel onto the card that draws them.
 * A node the builder reported no site for is kept as the id it answered with
 * rather than dropped: the answer's own shape, minus nothing.
 *
 * The revision travels with them for the same reason: a site says where a
 * node was declared and never which bytes were there, and the two are one
 * answer (D-068).
 */
export const planCardGraph = (graph: PlanGraph): PlanCardGraph => ({
  edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, reason: edge.reason })),
  ...(graph.nodes === undefined ? {} : {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      ...(node.declaredAt === undefined ? {} : { declaredAt: { path: node.declaredAt.path, line: node.declaredAt.line } })
    }))
  }),
  /* The revision those sites were read at, so the Code tab can open them (D-068). */
  ...(graph.sourceRevision === undefined ? {} : { sourceRevision: graph.sourceRevision })
})

/** The approved plan retained by either launch path before journal nodes arrive. */
export const planCardSnapshot = (plan: {
  readonly planId?: string
  readonly digest?: string
  readonly nodes?: ReadonlyArray<PlanNode>
  readonly graph?: PlanGraph
}): Extract<Card, { kind: "run-trace" }>["payload"]["plan"] =>
  plan.planId === undefined || plan.digest === undefined || !plan.nodes?.length ? undefined : {
    planId: plan.planId,
    digest: plan.digest,
    nodes: plan.nodes.map(planCardNode),
    ...(plan.graph === undefined ? {} : { graph: planCardGraph(plan.graph) })
  }
