/*
 * How long a flow's nodes take, and how long the rest of a run will (D-030).
 *
 * The evidence is the gateway's `flow-durations` projection: one row per
 * action tag, with the two nearest-rank percentiles and the number of
 * executions behind them. The tag is the grouping because it is the only part
 * of a node's key material that survives a re-key, so history follows a step
 * through the edits that re-key it.
 *
 * Nothing here invents a number. A tag nothing has measured has no row, a
 * plan holding one such node has NO estimate, and a card that cannot say how
 * long something takes says nothing at all rather than "not measured yet"
 * (AGENTS.md MINIMAL TEXT). Pure: no seam, no DOM, no clock.
 */
import type { FlowDurationRow } from "@smthrs/gateway/GatewayProjection"
import { durationWords } from "../RunTrace"

/**
 * The part of a node a prediction reads: where it sits in the graph, and the
 * action or flow it dispatches. A plan card's node and a run graph's node
 * both satisfy it, so one estimate serves the plan card and the run card.
 */
export interface DurationNode {
  readonly id: string
  readonly dependsOn: ReadonlyArray<string>
  /** The action or flow the node dispatches; a merge node dispatches neither. */
  readonly action?: string | undefined
}

/**
 * The tag one node's history is grouped by, absent when it dispatches
 * nothing. `planCardNode` has already read it off `ActionCall.action` or
 * `FlowCall.flow`; this is the one place that says which field it is.
 */
export const actionTagOf = (node: DurationNode): string | undefined => node.action

/** The served rows, addressable by the tag they measure. */
export const durationsByTag = (rows: ReadonlyArray<FlowDurationRow>): ReadonlyMap<string, FlowDurationRow> =>
  new Map(rows.map((row) => [row.actionTag, row]))

/**
 * The spread past which one number stops being a fair claim. A p90 three
 * times the p50 is a step whose duration depends on something the history
 * does not carry, so the reader is shown both ends instead of a middle.
 */
const WIDE_SPREAD = 3

/** What a card may say about one tag's measured history. */
export interface DurationDisplay {
  /** `~1m00s`, or `1.0s–3.0s` when the spread is too wide for one number. */
  readonly text: string
  /** The claim behind the text: `p50 of 24 runs · p90 1m30s`. */
  readonly detail: string
  /** How many executions the two percentiles were folded from. */
  readonly samples: number
  /** The two percentiles themselves, so a running node can measure against them. */
  readonly p50Ms: number
  readonly p90Ms: number
}

/**
 * One tag's measured history, in the words a card shows.
 *
 * A row with no samples is refused rather than rendered as zero: the
 * projection never serves one, and a prediction from nothing is not a
 * prediction.
 */
export const display = (row: FlowDurationRow | undefined): DurationDisplay | undefined => {
  if (row === undefined || row.samples <= 0) return undefined
  const wide = row.p50Ms > 0 && row.p90Ms / row.p50Ms > WIDE_SPREAD
  return {
    text: wide ? `${durationWords(row.p50Ms)}–${durationWords(row.p90Ms)}` : `~${durationWords(row.p50Ms)}`,
    detail: `p50 of ${row.samples} run${row.samples === 1 ? "" : "s"} · p90 ${durationWords(row.p90Ms)}`,
    samples: row.samples,
    p50Ms: row.p50Ms,
    p90Ms: row.p90Ms
  }
}

/**
 * What each node of a graph may say about its own history, by node id.
 *
 * A node with no tag, or a tag nothing measured, is absent from the map
 * rather than present with an empty value: the renderer then draws nothing,
 * which is what a node with no history looks like.
 */
export const displayByNode = (
  nodes: ReadonlyArray<DurationNode>,
  rows: ReadonlyArray<FlowDurationRow>
): ReadonlyMap<string, DurationDisplay> => {
  const byTag = durationsByTag(rows)
  const shown = new Map<string, DurationDisplay>()
  for (const node of nodes) {
    const tag = actionTagOf(node)
    const display_ = tag === undefined ? undefined : display(byTag.get(tag))
    if (display_ !== undefined) shown.set(node.id, display_)
  }
  return shown
}

/** An estimate in the words a header shows: approximate, because it is. */
export const etaWords = (ms: number): string => `~${durationWords(ms)}`

/**
 * How far a running node has got through its own p50, or nothing.
 *
 * Past the p90 the prediction has been overtaken by the run, and a bar
 * pinned at full would claim a finish that has not happened; the caller shows
 * the elapsed time alone.
 */
export const progressOf = (
  elapsedMs: number,
  row: { readonly samples: number; readonly p50Ms: number; readonly p90Ms: number } | undefined
): number | undefined => {
  if (row === undefined || row.samples <= 0 || row.p50Ms <= 0) return undefined
  if (elapsedMs > row.p90Ms) return undefined
  return Math.min(1, Math.max(0, elapsedMs / row.p50Ms))
}

/**
 * What one node costs the path it sits on.
 *
 * Three nodes cost nothing, each for its own reason. A node the caller says
 * will not execute — already settled, skipped in this run, or proven reusable — is
 * time the reader will not wait for. A node that dispatches nothing has no
 * tag, so the projection never measured it and never will. And the flow's
 * OWN root node is measured over the same span as everything beneath it
 * (`GatewayProjection.nodeDurations`, which drops the echoed root of a CALLED
 * flow for exactly this reason), so putting it on the path would count the
 * whole flow twice. A node calling a DIFFERENT flow keeps its cost: that
 * callee's nodes are in the callee's plan, not this one.
 */
const costOf = (
  node: DurationNode,
  rows: ReadonlyMap<string, FlowDurationRow>,
  flowId: string,
  done: (id: string) => boolean
): number | undefined => {
  if (done(node.id)) return 0
  const tag = actionTagOf(node)
  if (tag === undefined || tag === flowId) return 0
  const row = rows.get(tag)
  return row === undefined || row.samples <= 0 ? undefined : row.p50Ms
}

/**
 * How long the part of a plan that has yet to run will take.
 *
 * The LONGEST path over `dependsOn`, never the sum of every node: a fan-out
 * runs its branches at once, and a serial total would be a number the engine
 * has never produced (the first mock's mistake, D-030).
 *
 * The answer is undefined when any node that WILL execute has no measured
 * tag. A partial sum is worse than silence: it reads as an estimate and is
 * short by however much the unmeasured nodes take.
 *
 * @param nodes the plan's nodes, without its triggers (D-031: a trigger is
 *   not a plan node, is never dispatched, and costs nothing)
 * @param rows the `flow-durations` rows for the flow these nodes belong to
 * @param flowId the flow this plan IS, so its own root node is recognised as
 *   the span over the rest rather than a step beside them
 * @param done whether a node will not execute, so it costs nothing (D-032: a
 *   skipped node is a node that did not run, not a cache hit)
 */
export const criticalPathEta = (
  nodes: ReadonlyArray<DurationNode>,
  rows: ReadonlyArray<FlowDurationRow>,
  flowId: string,
  done: (nodeId: string) => boolean = () => false
): number | undefined => {
  if (nodes.length === 0) return undefined
  const byTag = durationsByTag(rows)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const costs = new Map<string, number>()
  for (const node of nodes) {
    const cost = costOf(node, byTag, flowId, done)
    if (cost === undefined) return undefined
    costs.set(node.id, cost)
  }
  /* Longest path ending at a node, memoised. A dependency this plan does not
   * carry contributes nothing, exactly as the drawn graph drops its edge. */
  const through = new Map<string, number>()
  const walking = new Set<string>()
  const longest = (id: string): number => {
    const held = through.get(id)
    if (held !== undefined) return held
    /* A plan is a DAG. A cycle would be a plan the engine could not schedule,
     * and an estimate is not the place to discover it, so the back edge
     * contributes nothing rather than looping forever. */
    if (walking.has(id)) return 0
    walking.add(id)
    const node = byId.get(id)
    let upstream = 0
    for (const from of node?.dependsOn ?? []) {
      if (!byId.has(from)) continue
      upstream = Math.max(upstream, longest(from))
    }
    walking.delete(id)
    const total = upstream + (costs.get(id) ?? 0)
    through.set(id, total)
    return total
  }
  let eta = 0
  for (const node of nodes) eta = Math.max(eta, longest(node.id))
  return eta
}
