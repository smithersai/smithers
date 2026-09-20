/*
 * The re-key preview: what a second run of the same flow would do.
 *
 * Both plans below are the recorded plan of `fixtures/GraphRunJournal.json`,
 * which a real bridged engine produced, and an edit is that plan with a
 * node's key changed. A key the engine never minted would prove nothing about
 * keys; a node id it never used would prove nothing about the join.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { foldRunGraph, runGraphOf, type NodeRun } from "../FlowGraphStatus"
import type { JournalRecord } from "../RunTrace"
import * as GatewayProjection from "@smthrs/gateway/GatewayProjection"
import { cleanSettlements, rekey, rekeySummary, wallClockOf, changedKeys, type PreviewNode } from "./Rekey"

interface Recorded {
  readonly flow: string
  readonly plan: { readonly nodes: ReadonlyArray<PreviewNode> }
  readonly rows: ReadonlyArray<JournalRecord>
}

const RECORDED: Recorded = JSON.parse(readFileSync(new URL("../fixtures/GraphRunJournal.json", import.meta.url), "utf8"))
const NODES = RECORDED.plan.nodes
const PLAN_IDS = NODES.map((node) => node.id)

/** The recorded plan with some of its nodes re-keyed, as an edit to the source would leave it. */
const edited = (ids: ReadonlyArray<string>): ReadonlyArray<PreviewNode> =>
  NODES.map((node) => ids.includes(node.id) ? { ...node, key: `${node.key}_edited` } : node)

const envelopeOf = (row: JournalRecord) => row.payload as {
  readonly eventType: string
  readonly payload: Record<string, unknown>
}

/** The status map for the execution that drove the recorded plan. */
const statusOf = (rows: ReadonlyArray<JournalRecord>): ReadonlyMap<string, NodeRun> => {
  const graph = runGraphOf(foldRunGraph(rows), { planNodeIds: PLAN_IDS, flow: RECORDED.flow })
  if (graph === undefined) throw new Error("the recording carries no execution covering the plan")
  return graph.status
}

describe("rekey", () => {
  test("the recorded plan against itself changes nothing", () => {
    const diff = rekey(NODES, NODES)
    expect(diff.unchanged).toHaveLength(11)
    expect(diff.rekeyed).toHaveLength(0)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
  })

  test("an edit that moves three of eleven keys changes three and keeps eight", () => {
    const diff = rekey(NODES, edited([
      "root.flow.then.map.all.cached",
      "root.flow.then.map",
      "root"
    ]))
    expect(diff.rekeyed.map((node) => node.id)).toEqual([
      "root.flow.then.map.all.cached",
      "root.flow.then.map",
      "root"
    ])
    expect(diff.unchanged).toHaveLength(8)
    expect(changedKeys(diff).size).toBe(3)
  })

  test("a re-keyed node names the key it moved from and the key it moved to", () => {
    const [moved] = rekey(NODES, edited(["root"])).rekeyed
    const before = NODES.find((node) => node.id === "root")
    expect(moved?.from).toBe(before!.key)
    expect(moved?.to).toBe(`${before!.key}_edited`)
  })

  test("a node the edit introduced is added, and one it deleted is removed", () => {
    const next = [
      ...NODES.filter((node) => node.id !== "root.flow.then.map.all.cached"),
      { id: "root.flow.then.map.all.fresh", kind: "step", key: "key1_fresh", dependsOn: ["root.flow.andThen"], tier: "sealed", action: "acme/Fresh", status: "run" } as PreviewNode
    ]
    const diff = rekey(NODES, next)
    expect(diff.added).toEqual(["root.flow.then.map.all.fresh"])
    expect(diff.removed).toEqual(["root.flow.then.map.all.cached"])
    // Only the fresh id contributes a key to the next plan.
    expect([...changedKeys(diff)]).toEqual(["root.flow.then.map.all.fresh"])
  })

  test("a node re-keyed AND a node added are both work", () => {
    const next = [
      ...edited(["root"]),
      { id: "root.extra", kind: "step", key: "key1_extra", dependsOn: ["root"], tier: "sealed", action: "acme/Extra", status: "run" } as PreviewNode
    ]
    expect(changedKeys(rekey(NODES, next)).size).toBe(2)
  })
})

describe("wallClockOf", () => {
  const timed = RECORDED.rows.flatMap((row) => typeof row.occurredAt === "number" ? [row.occurredAt] : [])

  test("a run's real wall clock is its first timed event to its last", () => {
    expect(timed.length).toBeGreaterThan(1)
    expect(wallClockOf(RECORDED.rows)).toBe(timed[timed.length - 1]! - timed[0]!)
  })

  test("a row with no timestamp says nothing about when it happened", () => {
    expect(wallClockOf([...RECORDED.rows, { sequence: 0, kind: "control.run.started", payload: {} }])).toBe(
      timed[timed.length - 1]! - timed[0]!
    )
  })

  test("a run with one timed event, or none, has no wall clock to state", () => {
    expect(wallClockOf([])).toBeUndefined()
    expect(wallClockOf([RECORDED.rows[0]!])).toBeUndefined()
  })
})

describe("cleanSettlements", () => {
  test("the production host records none, so there is no cache-hit count to show", () => {
    // D-044: every step re-dispatched on a real second run. The outcomes this
    // recording carries are exactly `built` and `failed`.
    expect(cleanSettlements(statusOf(RECORDED.rows))).toBe(0)
  })

  test("a run that really did settle a node clean has a count", () => {
    // ONE recorded `flows.engine.node-settled` row with its `outcome` field
    // changed to `clean`, which is what a host declaring a cache environment
    // (D-049) records. Nothing else about the recording moves.
    const rows = RECORDED.rows.map((row) => {
      const envelope = envelopeOf(row)
      return envelope.eventType === "flows.engine.node-settled" &&
          envelope.payload["nodeId"] === "root.flow.then.map.all.cached"
        ? { ...row, payload: { ...envelope, payload: { ...envelope.payload, outcome: "clean" } } }
        : row
    })
    expect(cleanSettlements(statusOf(rows))).toBe(1)
  })
})

describe("rekeySummary", () => {
  /** The rows the gateway would serve for the recorded run's own flow. */
  const DURATIONS = GatewayProjection.flowDurations(
    RECORDED.flow,
    GatewayProjection.nodeDurations(RECORDED.rows as ReadonlyArray<never>)
  )

  const summary = (next: ReadonlyArray<PreviewNode>, rows: ReadonlyArray<JournalRecord> = RECORDED.rows) =>
    rekeySummary({
      flowId: RECORDED.flow,
      previousNodes: NODES,
      nextNodes: next,
      events: rows,
      status: statusOf(rows),
      durations: DURATIONS
    })

  test("an edit that moved three keys re-keys three of eleven", () => {
    const shown = summary(edited(["root.flow.then.map.all.cached", "root.flow.then.map", "root"]))
    expect(shown.rerun).toBe(3)
    expect(shown.total).toBe(11)
  })

  test("an unchanged unmeasured action prevents an estimate", () => {
    // Doomed remains unchanged but has never succeeded; it still has to run.
    expect(summary(edited(["root.flow.then.map.all.cached"])).etaMs).toBeUndefined()
  })

  test("a re-keyed node nothing ever measured leaves no estimate at all", () => {
    // `gateway/graph/Doomed` failed on the recorded run, so it has no row.
    expect(summary(edited(["root.flow.then.map.all.recovered.protected"])).etaMs).toBeUndefined()
  })

  test("`was` is the compared run's own wall clock, not a prediction", () => {
    expect(summary(edited(["root"])).wasMs).toBe(wallClockOf(RECORDED.rows))
  })

  test("the default host records no clean settlement, so the preview states no cache hits", () => {
    expect(summary(edited(["root"])).cleanSettlements).toBeUndefined()
  })

  test("a run that really settled a node clean states that count", () => {
    const rows = RECORDED.rows.map((row) => {
      const envelope = envelopeOf(row)
      return envelope.eventType === "flows.engine.node-settled" &&
          envelope.payload["nodeId"] === "root.flow.then.map.all.cached"
        ? { ...row, payload: { ...envelope, payload: { ...envelope.payload, outcome: "clean" } } }
        : row
    })
    expect(summary(edited(["root"]), rows).cleanSettlements).toBe(1)
  })

  test("an unedited source changes no keys but still needs duration evidence", () => {
    const shown = summary(NODES)
    expect(shown.rerun).toBe(0)
    expect(shown.etaMs).toBeUndefined()
  })
})


describe("reuse evidence in the estimate", () => {
  const nodes = [
    { id: "a", key: "a1", action: "read", dependsOn: [] },
    { id: "b", key: "b1", action: "write", dependsOn: ["a"] }
  ]
  const durations = [
    { flowId: "flow", actionTag: "read", p50Ms: 100, p90Ms: 120, samples: 3 },
    { flowId: "flow", actionTag: "write", p50Ms: 200, p90Ms: 240, samples: 3 }
  ]
  const estimate = (outcome?: NodeRun["outcome"], nextNodes = nodes) => rekeySummary({
    flowId: "flow", previousNodes: nodes, nextNodes, events: [], durations,
    status: outcome === undefined ? new Map() : new Map([["a", { outcome } as NodeRun]])
  }).etaMs

  test("unchanged nodes retain their p50 without a clean settlement", () => {
    for (const outcome of [undefined, "built", "failed", "skipped"] as const) {
      expect(estimate(outcome)).toBe(300)
    }
  })
  test("only an unchanged node with a recorded clean settlement costs zero", () => {
    expect(estimate("clean")).toBe(200)
    expect(estimate("clean", [{ ...nodes[0]!, key: "a2" }, nodes[1]!])).toBe(300)
  })
})
