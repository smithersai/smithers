import { describe, expect, test } from "vitest"
import { type InspectionEvent, inspectionJournal, monitorFromInspection } from "../src/InspectionJournal.vibe"
const event = (seq: number, eventType: string, payload: unknown): InspectionEvent => ({
  seq,
  eventType,
  emittedAtMs: 1000 + seq,
  payload: { text: JSON.stringify(payload), bytes: 0, clipped: false }
})
const run = { runId: "test", flowId: "test/Flow", status: "completed" }
const events = [
  event(1, "flows.engine.plan-recorded", {
    generation: 0,
    graph: {
      nodes: [
        { id: "a", kind: "ActionCall", tier: "sealed", action: "first", dependsOn: [] },
        { id: "b", kind: "ActionCall", tier: "sealed", action: "second", dependsOn: ["a"] }
      ]
    }
  }),
  event(2, "flows.engine.node-scheduled", { nodeId: "a", kind: "ActionCall", attempt: 1 }),
  event(3, "flows.engine.node-settled", {
    nodeId: "a",
    outcome: "built",
    attempts: 1,
    result: { preview: "\"ready\"", bytes: 7, truncated: false }
  }),
  event(4, "flows.engine.node-scheduled", { nodeId: "b", kind: "ActionCall", attempt: 1 })
]
describe("inspection journal adapter", () => {
  test("canonical fold gives live, historical and dependency states, without duplicate events", () => {
    expect(monitorFromInspection(run, events).attempts[0]!.graph.map((n) => n.state)).toEqual(["done", "current"])
    expect(monitorFromInspection(run, events, 2).attempts[0]!.graph.map((n) => n.state)).toEqual(["current", "next"])
    expect(monitorFromInspection(run, events, 0).attempts[0]!.graph).toEqual([])
    expect(inspectionJournal(run.runId, [...events].reverse().concat(events))).toHaveLength(4)
    expect(monitorFromInspection(run, events).attempts[0]!.graph[1]!.deps).toEqual(["engine-node:test%3A0:a"])
  })
  test("invalid and clipped evidence stays unreadable; generation is carried forward", () => {
    const invalid = ["no-json", "null", "[]", "42"].map((text, i) => ({
      ...events[0]!,
      seq: i,
      payload: { text, bytes: 0, clipped: false }
    }))
    expect(inspectionJournal("test", [...invalid, { ...events[0]!, payload: { text: "{}", bytes: 2, clipped: true } }]))
      .toEqual([])
    const records = inspectionJournal("test", [
      event(1, "plan", { generation: 3 }),
      event(2, "node", {}),
      event(3, "node", { generation: -1 })
    ])
    expect(records.map((r) => (r.payload as { generation: number }).generation)).toEqual([3, 3, 3])
    expect(monitorFromInspection(run, []).attempts[0]!.graph).toEqual([])
  })
})

test("forest preserves native identity, orders ties and supplies the same canonical graph", async () => {
  const { inspectionForest } = await import("../src/InspectionJournal.vibe")
  const forest = inspectionForest([{ runId: "b", events: events.slice(0, 2) }, {
    runId: "a",
    events: events.slice(0, 2)
  }])
  expect(forest.events.map((e) => [e.seq, e.runId, e.nativeSeq])).toEqual([[1, "a", 1], [2, "b", 1], [3, "a", 2], [
    4,
    "b",
    2
  ]])
  expect((forest.records[3]!.payload as { sequence: number }).sequence).toBe(2)
  expect(inspectionForest([{ runId: "b", events: events.slice(0, 2) }]).events.map((e) => e.seq)).toEqual([1, 2])
})

test("native checkpoint and cell-call source coordinates survive adaptation", () => {
  const stepId = "a".repeat(64)
  const fact = {
    version: 1,
    generation: 0,
    frame: 0,
    ordinal: 2,
    cell: "c",
    at: 1000,
    eventType: "control.agent.cell-produced",
    sourceSequence: 2,
    payload: { text: "42" },
    step: { stepId, executionId: "test", action: "agent", attempt: 1, ask: 0, retry: 1, scope: "scope" }
  }
  const call = {
    version: 1,
    phase: "invoked",
    callId: `cell-call-v1:${stepId}`,
    identity: { runId: "scope", frame: 0, cell: "c", ordinal: 0, declaration: "d", layers: [] },
    flowName: "tool",
    input: {}
  }
  const rows = inspectionJournal("test", [
    event(1, "flows.harness.step-fact.v1", fact),
    event(2, "flows.harness.call-fact.v1", call),
    event(3, "flows.harness.step-fact.v1", {}),
    event(4, "flows.harness.call-fact.v1", {})
  ])
  expect(rows.map((r) => (r.payload as { sourceId: string }).sourceId)).toEqual([
    `step-fact-v1:${stepId}:1:0:1`,
    `call-fact-v1:cell-call-v1:${stepId}:invoked`,
    "engine",
    "engine"
  ])
  expect((rows[0]!.payload as { sourceSequence: number }).sourceSequence).toBe(2)
  expect((rows[1]!.payload as { sourceSequence: number }).sourceSequence).toBe(0)
  expect(rows[1]!.runId).toBe("scope")
})

test("forest ordering uses native sequence when one execution records several events in a millisecond", async () => {
  const { inspectionForest } = await import("../src/InspectionJournal.vibe")
  const simultaneous = events.map((e) => ({ ...e, emittedAtMs: 1000 }))
  const forest = inspectionForest([{ runId: "b", events: [...simultaneous].reverse() }, {
    runId: "a",
    events: simultaneous
  }])
  expect(forest.events.map((e) => [e.runId, e.nativeSeq])).toEqual([
    ["a", 1],
    ["a", 2],
    ["a", 3],
    ["a", 4],
    ["b", 1],
    ["b", 2],
    ["b", 3],
    ["b", 4]
  ])
})

test("child boundaries are opt-in and never expose the root flow as a step", async () => {
  const { monitorFromJournal } = await import("../src/RunTrace.vibe")
  const recorded = inspectionJournal("test", [
    event(1, "flows.engine.plan-recorded", {
      graph: {
        nodes: [
          { id: "root", kind: "FlowCall", tier: "sealed", action: "test/Flow", dependsOn: [] },
          { id: "a", kind: "ActionCall", tier: "sealed", action: "first", dependsOn: ["root"] },
          { id: "child", kind: "FlowCall", tier: "sealed", action: "child/Flow", dependsOn: ["a"] }
        ]
      }
    }),
    event(2, "flows.engine.node-scheduled", { nodeId: "root", kind: "FlowCall", attempt: 1 }),
    event(3, "flows.engine.node-scheduled", { nodeId: "a", kind: "ActionCall", attempt: 1 }),
    // The child follows `a`: it starts once `a` settled.
    event(4, "flows.engine.node-settled", { nodeId: "a", outcome: "built", attempts: 1 }),
    event(5, "flows.engine.node-scheduled", { nodeId: "child", kind: "FlowCall", attempt: 1 })
  ])
  expect(monitorFromJournal(run, recorded).attempts[0]!.graph.map((n) => n.label)).toEqual(["first"])
  const shown = monitorFromJournal(run, recorded, undefined, { childBoundaries: true }).attempts[0]!
  expect(shown.graph.map((n) => n.label)).toEqual(["first", "child/Flow"])
  expect(shown.steps.map((n) => n.label)).toEqual(["first", "child/Flow"])
  expect(shown.graph[1]!.deps).toEqual(["engine-node:test%3A0:a"])
})
