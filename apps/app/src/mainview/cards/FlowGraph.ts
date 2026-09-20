/*
 * The plan, as a graph: the pure half.
 *
 * A `flow-plan` card holds the keyed nodes the control plane answered with.
 * This module turns those into the node and edge lists a renderer draws, and
 * lays them out with dagre. Nothing here touches React, the DOM or a seam, so
 * the graph's shape is provable without a canvas — which matters, because
 * React Flow measures the DOM and happy-dom measures nothing.
 *
 * Top to bottom (D-034): the nodes are wide cards, so a rank costs 142px
 * vertically and 314px horizontally, and a fifteen-node unrolled loop reads
 * top-to-bottom at a usable zoom where left-to-right is a ribbon.
 */
import dagre from "dagre"
import type { Card } from "../state/AppState"
import type { DurationDisplay } from "./flowGraph/Durations"
import { graphNodeLabel } from "./flowGraph/NodeAria"
import type { TriggerGraphNode, TriggerGraphPart } from "./FlowGraphTriggerNode"

/** One node of the plan, exactly as the card carries it. */
export type PlanCardNode = NonNullable<Extract<Card, { kind: "flow-plan" }>["payload"]["nodes"]>[number]

/** One labelled edge, exactly as the card carries it. */
export type PlanCardEdge = NonNullable<Extract<Card, { kind: "flow-plan" }>["payload"]["graph"]>["edges"][number]

/** The graph a plan card carries: the labelled edges, and where the nodes were declared. */
export type PlanCardGraph = NonNullable<Extract<Card, { kind: "flow-plan" }>["payload"]["graph"]>

/** One node's declaration site, exactly as the card carries it. */
export type PlanCardSite = NonNullable<PlanCardGraph["nodes"]>[number]

/**
 * Where each node of a plan was declared, by node id.
 *
 * A node the workspace reported no site for is absent from the map rather
 * than present with nothing, so the drawer's Code tab is absent for it
 * (D-035).
 */
export const sitesByNode = (
  graph?: { readonly nodes?: ReadonlyArray<PlanCardSite> | undefined } | undefined
): ReadonlyMap<string, { readonly path: string; readonly line: number }> => {
  const sites = new Map<string, { readonly path: string; readonly line: number }>()
  for (const site of graph?.nodes ?? []) {
    if (site.declaredAt !== undefined) sites.set(site.id, site.declaredAt)
  }
  return sites
}

/** The mock's node anatomy, in pixels (D-034). */
export const NODE_WIDTH = 228
export const NODE_HEIGHT = 88
const RANK_SEP = 24
const NODE_SEP = 16

/**
 * Why one node waits for another. The wire's own reasons, plus `fires`: the
 * UI-only edge from a schedule into the plan it starts (D-031), which no
 * engine reports because a trigger is not a plan node.
 */
export type FlowGraphEdgeReason = PlanCardEdge["reason"] | "fires"

/** One drawn edge. `reason` is absent when the workspace reported none. */
export interface FlowGraphEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly reason?: FlowGraphEdgeReason
}

/**
 * The plan as a drawable graph.
 *
 * `nodes` is the PLAN's nodes and only those, so every count the card states
 * is the plan's own. `triggers` is present only when the caller had trigger
 * rows to merge: a plan read without them is not a plan with none.
 */
export interface FlowGraphModel {
  readonly nodes: ReadonlyArray<PlanCardNode>
  readonly edges: ReadonlyArray<FlowGraphEdge>
  readonly triggers?: ReadonlyArray<TriggerGraphNode>
}

const edgeId = (from: string, to: string): string => `${from}->${to}`

/**
 * The plan's nodes and the edges between them.
 *
 * The workspace's labelled edges are used when it reported them, because they
 * say WHY one node waits for another; `dependsOn` is the unlabelled edge set
 * every host carries and is the fallback. Either way an edge naming a node
 * this plan does not carry is dropped: a half-drawn edge is a lie about the
 * graph, and a throw would take the whole card down over one bad id.
 *
 * `triggers` is the schedules that fire this flow (FlowGraphTriggerNode.ts).
 * They ride beside the plan rather than in it: their `fires` edges are drawn,
 * and `nodes` stays the plan's own so no count picks them up (D-031).
 */
export const flowGraphModel = (
  nodes: ReadonlyArray<PlanCardNode>,
  graph?: { readonly edges: ReadonlyArray<PlanCardEdge> } | undefined,
  triggers?: TriggerGraphPart | undefined
): FlowGraphModel => {
  const known = new Set(nodes.map((node) => node.id))
  const declared = graph?.edges ?? nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id })))
  const seen = new Set<string>()
  const edges: Array<FlowGraphEdge> = []
  for (const edge of declared) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue
    const id = edgeId(edge.from, edge.to)
    if (seen.has(id)) continue
    seen.add(id)
    edges.push({ id, from: edge.from, to: edge.to, ...("reason" in edge ? { reason: edge.reason } : {}) })
  }
  for (const edge of triggers?.edges ?? []) {
    if (seen.has(edge.id)) continue
    seen.add(edge.id)
    edges.push({ id: edge.id, from: edge.from, to: edge.to, reason: "fires" })
  }
  return { nodes, edges, ...(triggers === undefined ? {} : { triggers: triggers.nodes }) }
}

/** One positioned node, in the shape React Flow's `nodes` prop takes. */
export interface FlowGraphLayoutNode {
  readonly id: string
  readonly type: "planNode" | "triggerNode"
  readonly position: { readonly x: number; readonly y: number }
  readonly data: { readonly node?: PlanCardNode; readonly trigger?: TriggerGraphNode; readonly [key: string]: unknown }
  readonly width: number
  readonly height: number
  readonly draggable: false
  readonly connectable: false
  readonly deletable: false
  readonly ariaLabel: string
}

/** One positioned edge, in the shape React Flow's `edges` prop takes. */
export interface FlowGraphLayoutEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly type: "smoothstep"
  readonly className: string
  readonly data: { readonly reason: FlowGraphEdgeReason | undefined }
}

export interface FlowGraphLayout {
  readonly nodes: ReadonlyArray<FlowGraphLayoutNode>
  readonly edges: ReadonlyArray<FlowGraphLayoutEdge>
}

/**
 * The graph laid out, top to bottom.
 *
 * Positions are rounded to whole pixels so the same plan lays out to the same
 * bytes twice: a card payload that moved by a floating-point hair would be a
 * new payload, and every reader of it would re-render.
 */
export const layoutFlowGraph = (
  model: FlowGraphModel,
  /* What each node's history says it costs, by node id. It rides the node's
   * own `data` so the canvas draws it without a second lookup and without
   * knowing where the numbers came from (flowGraph/Durations.ts). */
  durations?: ReadonlyMap<string, DurationDisplay> | undefined
): FlowGraphLayout => {
  const layout = new dagre.graphlib.Graph()
  layout.setDefaultEdgeLabel(() => ({}))
  layout.setGraph({ rankdir: "TB", ranker: "longest-path", ranksep: RANK_SEP, nodesep: NODE_SEP, marginx: 24, marginy: 24 })
  for (const node of model.nodes) layout.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const trigger of model.triggers ?? []) layout.setNode(trigger.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of model.edges) layout.setEdge(edge.from, edge.to)
  dagre.layout(layout)

  const placed = (id: string): FlowGraphLayoutNode["position"] => {
    const positioned = layout.node(id)
    return {
      x: Math.round((positioned?.x ?? 0) - NODE_WIDTH / 2),
      y: Math.round((positioned?.y ?? 0) - NODE_HEIGHT / 2)
    }
  }

  /* A trigger is drawn where the plan is not: same box, its own node type, and never in `model.nodes`. */
  const triggerNodes = (model.triggers ?? []).map((trigger): FlowGraphLayoutNode => ({
    id: trigger.id,
    type: "triggerNode",
    position: placed(trigger.id),
    data: { trigger },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    draggable: false,
    connectable: false,
    deletable: false,
    ariaLabel: graphNodeLabel(undefined, trigger.row.id, trigger.state)
  }))
  const planNodes = model.nodes.map((node): FlowGraphLayoutNode => ({
    id: node.id,
    type: "planNode",
    position: placed(node.id),
    data: { node, ...(durations?.get(node.id) === undefined ? {} : { duration: durations.get(node.id) }) },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    draggable: false,
    connectable: false,
    deletable: false,
    ariaLabel: graphNodeLabel(node.action, node.id, node.status)
  }))

  return {
    nodes: [...triggerNodes, ...planNodes],
    edges: model.edges.map((edge): FlowGraphLayoutEdge => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      className: "flow-graph-edge",
      data: { reason: edge.reason }
    }))
  }
}
