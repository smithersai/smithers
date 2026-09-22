/**
 * What every ported pattern test reads off a `@smthrs/flow` graph.
 *
 * `Graph.build` enters the flow it is given as a call of its own, so counting
 * `FlowCall` nodes counts one more than the calls a body made. Every pattern
 * test therefore counts calls to a NAMED member instead, which is both what
 * the core-era assertions meant and stricter than a kind count.
 */
import { Graph } from "@smthrs/flow"

/** Every graph node that is a call to `tag`, whether flow or action. */
export const callsTo = (graph: Graph.Graph, tag: string): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) =>
    (node.kind === "FlowCall" && (node.ast as { readonly flow?: string }).flow === tag) ||
    (node.kind === "ActionCall" && (node.ast as { readonly action?: string }).action === tag)
  )

/** The payload one call node carries, with planned references left in place. */
export const payloadOf = (node: Graph.GraphNode): Record<string, unknown> => node.payload as Record<string, unknown>
