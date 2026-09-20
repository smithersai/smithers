/*
 * The re-key preview: which plan keys changed.
 *
 * A step key is a function of what the step consumes, so an edit moves the
 * keys of the node it touched and of everything downstream, and moves nothing
 * else. Comparing the plan a run was approved on with a fresh plan of the
 * same flow is therefore the whole invalidation rule, stated in numbers.
 *
 * `PlanDiff.diff` (@smthrs/plan) is the engine's own version of this and is
 * the semantics followed here: same id and same key is unchanged, same id and
 * a different key is re-keyed, an id only the fresh plan has is added, and an
 * id only the previous plan had is removed. The engine also attributes WHICH
 * declaration field moved a key; a card node carries the key and not the key
 * material, so this module states the keys and never the fields.
 *
 * What it will NOT state is a cache hit. On the production host nothing
 * settles `clean` (D-044), a plan key is not a dispatch key, and no cache
 * probe exists, so {@link cleanSettlements} reports what a run RECORDED and
 * the caller shows a count only where there is one. Pure: no seam, no DOM.
 */
import type { NodeRun } from "../FlowGraphStatus"
import { criticalPathEta, type DurationNode } from "./Durations"
import type { FlowDurationRow } from "@smthrs/gateway/GatewayProjection"

/** The part of a plan node the comparison reads: its address and its key. */
export interface RekeyNode {
  readonly id: string
  readonly key: string
}

/** One node whose key moved, and the two keys it moved between. */
export interface RekeyedNode {
  readonly id: string
  readonly from: string
  readonly to: string
}

/** What a fresh plan changed about the plan a run was approved on. */
export interface RekeyDiff {
  /** Ids only the fresh plan has. */
  readonly added: ReadonlyArray<string>
  /** Ids only the previous plan had; they cannot run, so they are not work. */
  readonly removed: ReadonlyArray<string>
  /** Ids both plans have under different keys. */
  readonly rekeyed: ReadonlyArray<RekeyedNode>
  /** Ids both plans have under the same key. */
  readonly unchanged: ReadonlyArray<string>
}

/**
 * The plan a run was approved on, against a fresh plan of the same flow.
 *
 * Order follows the fresh plan, which follows the flow's own declaration
 * order, so a reader listing the work sees it in the order it would run.
 */
export const rekey = (
  previousNodes: ReadonlyArray<RekeyNode>,
  nextNodes: ReadonlyArray<RekeyNode>
): RekeyDiff => {
  const before = new Map(previousNodes.map((node) => [node.id, node]))
  const after = new Set(nextNodes.map((node) => node.id))
  const added: Array<string> = []
  const rekeyed: Array<RekeyedNode> = []
  const unchanged: Array<string> = []
  for (const node of nextNodes) {
    const original = before.get(node.id)
    if (original === undefined) added.push(node.id)
    else if (original.key === node.key) unchanged.push(node.id)
    else rekeyed.push({ id: node.id, from: original.key, to: node.key })
  }
  return {
    added,
    removed: previousNodes.filter((node) => !after.has(node.id)).map((node) => node.id),
    rekeyed,
    unchanged
  }
}

/**
 * The fresh or changed keys in the next plan. This says nothing about which
 * nodes will execute: a matching plan key is not evidence of dispatch reuse.
 */
export const changedKeys = (diff: RekeyDiff): ReadonlySet<string> =>
  new Set([...diff.added, ...diff.rekeyed.map((node) => node.id)])

/**
 * How long the run being compared against really took, first event to last.
 *
 * The journal's own timestamps, so this is a measurement rather than a
 * prediction. A row that carries no timestamp says nothing about when it
 * happened and is passed over, and fewer than two timed rows span nothing a
 * reader could check, so they are reported as no wall clock at all.
 */
export const wallClockOf = (
  events: ReadonlyArray<{ readonly occurredAt?: number | undefined }>
): number | undefined => {
  const timed = events.flatMap((event) => typeof event.occurredAt === "number" ? [event.occurredAt] : [])
  if (timed.length < 2) return undefined
  const first = timed[0]!
  const last = timed[timed.length - 1]!
  return last >= first ? last - first : undefined
}

/**
 * How many nodes a run actually settled `clean`.
 *
 * This is the only evidence that a cache hit is a thing that happens on the
 * host a card is talking to. On the production host it is zero (D-044:
 * `CacheAdmission` refuses a sealed action with no hard file boundary, and
 * `ActionKey` folds the run id into the key while no cache environment is
 * declared), and a HUD that claimed cache hits anyway would be claiming the
 * engine's DESIGN as the host's behaviour.
 */
export const cleanSettlements = (status: ReadonlyMap<string, NodeRun>): number => {
  let clean = 0
  for (const run of status.values()) if (run.outcome === "clean") clean += 1
  return clean
}

/** A plan node, as both halves of the preview read it. */
export type PreviewNode = RekeyNode & DurationNode

/** Everything the preview is computed from; every field is something recorded. */
export interface RekeyInputs {
  /** The flow both plans are of; its own root node costs the path nothing. */
  readonly flowId: string
  /** The plan the compared run was approved on, off its run card. */
  readonly previousNodes: ReadonlyArray<PreviewNode>
  /** A fresh plan of the same flow, from the source now in the workspace. */
  readonly nextNodes: ReadonlyArray<PreviewNode>
  /** That run's journal rows, for the wall clock it really took. */
  readonly events: ReadonlyArray<{ readonly occurredAt?: number | undefined }>
  /** What that run's own records say happened to each of its nodes. */
  readonly status: ReadonlyMap<string, NodeRun>
  /** The flow's measured history, for the estimate over the work. */
  readonly durations: ReadonlyArray<FlowDurationRow>
}

/** The preview, as numbers. Every optional field is absent where the evidence is. */
export interface RekeySummary {
  /** Fresh or changed keys. `rerun` is the persisted legacy field name. */
  readonly rerun: number
  /** Nodes in the fresh plan. */
  readonly total: number
  /** The critical path over the work; absent when one node of it was never measured. */
  readonly etaMs?: number
  /** What the compared run really took. */
  readonly wasMs?: number
  /** How many nodes that run settled `clean`; absent where none did (D-044). */
  readonly cleanSettlements?: number
}

/**
 * Changed keys and the measured cost of another run. Only an unchanged node
 * with a clean settlement in the compared run costs zero (D-053). Other
 * unchanged nodes keep their p50, including built, failed and skipped nodes.
 * `wasMs` and `cleanSettlements` describe the compared run, never savings.
 */
export const rekeySummary = (inputs: RekeyInputs): RekeySummary => {
  const diff = rekey(inputs.previousNodes, inputs.nextNodes)
  const changed = changedKeys(diff)
  const unchanged = new Set(diff.unchanged)
  const eta = criticalPathEta(inputs.nextNodes, inputs.durations, inputs.flowId,
    (id) => unchanged.has(id) && inputs.status.get(id)?.outcome === "clean")
  const was = wallClockOf(inputs.events)
  const clean = cleanSettlements(inputs.status)
  return {
    rerun: changed.size,
    total: inputs.nextNodes.length,
    ...(eta === undefined ? {} : { etaMs: eta }),
    ...(was === undefined ? {} : { wasMs: was }),
    ...(clean > 0 ? { cleanSettlements: clean } : {})
  }
}
