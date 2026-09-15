/**
 * The node-output projection `smthrs output` and `get_node_detail` read.
 *
 * The requirement carried over from 0.x's `smthrs output` and `node` verbs:
 * an operator asks what one step produced, by a name they can quote back, and
 * a run that died mid-call must still answer for the call it was in.
 */
import type { ControlSchema } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as NodeOutput from "../src/NodeOutput.ts"

let sequence = 0

const event = (kind: string, payload: unknown): ControlSchema.ControlEvent => ({
  sequence: ++sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence * 1000,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

const started = (flowName: string, input: unknown = {}) => event("control.agent.cell-call-started", { flowName, input })
const settled = (flowName: string, outcome: string, value: unknown, message?: string) =>
  event("control.agent.cell-call-settled", { flowName, outcome, value, message })

describe("the projection", () => {
  it("joins concurrent calls by ID in reverse settlement order and ignores duplicate deliveries", () => {
    const first = { callId: "first", flowName: "write", input: { path: "a" } }
    const second = { callId: "second", flowName: "write", input: { path: "b" } }
    const failure = { callId: "second", flowName: "write", outcome: "failure", message: "denied" }
    const start = event("control.agent.cell-call-started", first)
    const nodes = NodeOutput.project([
      start,
      event("control.agent.cell-call-started", second),
      event("control.agent.cell-call-started", first),
      event("control.agent.cell-call-settled", failure),
      event("control.agent.cell-call-settled", { callId: "first", flowName: "write", outcome: "success", value: "a" }),
      event("control.agent.cell-call-settled", failure)
    ])
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toMatchObject({
      nodeId: "write#1",
      callId: "first",
      input: { path: "a" },
      value: "a",
      outcome: "success",
      startedSequence: start.sequence
    })
    expect(nodes[1]).toMatchObject({ nodeId: "write#2", callId: "second", outcome: "failure", message: "denied" })
    expect(nodes[0]!.settledSequence).toBeGreaterThan(nodes[1]!.settledSequence!)
  })

  it("allows upgraded legacy settlements without letting unknown IDs steal identified starts", () => {
    const nodes = NodeOutput.project([
      event("control.agent.cell-call-started", { callId: "current", flowName: "read" }),
      event("control.agent.cell-call-settled", { callId: "unknown", flowName: "read", value: "orphan" }),
      started("read"),
      event("control.agent.cell-call-settled", { callId: "resumed", flowName: "read", value: "legacy" }),
      settled("read", "success", "cannot steal current")
    ])
    expect(nodes[0]).toMatchObject({ nodeId: "read#1", outcome: "pending" })
    expect(nodes[1]).toMatchObject({ nodeId: "read#2", outcome: "success", value: "legacy" })
  })

  it("numbers each flow's calls from one and records what they produced", () => {
    const nodes = NodeOutput.project([
      started("read", { path: "a.ts" }),
      settled("read", "success", "contents of a"),
      started("read", { path: "b.ts" }),
      settled("read", "success", "contents of b"),
      started("write", { path: "c.ts" }),
      settled("write", "failure", undefined, "permission denied")
    ])

    expect(nodes.map((node) => node.nodeId)).toEqual(["read#1", "read#2", "write#1"])
    expect(nodes[0]).toMatchObject({
      outcome: "success",
      value: "contents of a",
      input: { path: "a.ts" },
      startedSequence: expect.any(Number),
      settledSequence: expect.any(Number)
    })
    expect(nodes[2]).toMatchObject({ outcome: "failure", message: "permission denied" })
  })

  it("reports a call that started and never settled as pending", () => {
    // A run that died mid-call is exactly when an operator asks what the last
    // step was doing; dropping the row would answer "nothing happened".
    const nodes = NodeOutput.project([started("bash", { command: "sleep 300" })])

    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ nodeId: "bash#1", outcome: "pending" })
    expect(nodes[0]?.startedSequence).toBeDefined()
    expect(nodes[0]?.settledSequence).toBeUndefined()
    expect(nodes[0]?.settledAt).toBeUndefined()
  })

  it("settles the oldest unsettled call of a flow when calls overlap", () => {
    const nodes = NodeOutput.project([
      started("read", { path: "a" }),
      started("read", { path: "b" }),
      settled("read", "success", "first")
    ])

    expect(nodes[0]).toMatchObject({ nodeId: "read#1", outcome: "success", value: "first" })
    expect(nodes[1]).toMatchObject({ nodeId: "read#2", outcome: "pending" })
  })

  it("ignores a settlement for a flow that never started", () => {
    expect(NodeOutput.project([settled("ghost", "success", 1)])).toEqual([])
  })

  it("adds the run's final assistant output under the reserved `result` id", () => {
    const nodes = NodeOutput.project([
      started("read"),
      settled("read", "success", "x"),
      event("control.agent.resolved", { text: "done" })
    ])

    expect(NodeOutput.resultNodeId).toBe("result")
    expect(nodes.at(-1)).toMatchObject({ nodeId: "result", outcome: "success", value: "done" })
  })

  it("names a call with no flow name rather than dropping it", () => {
    expect(NodeOutput.project([started(undefined as unknown as string)])[0]?.nodeId).toBe("?#1")
    expect(NodeOutput.project([event("control.agent.cell-call-started", [])])[0]?.nodeId).toBe("?#1")
  })

  it("ignores unrelated event kinds after checking the final-output boundary", () => {
    expect(NodeOutput.project([event("control.unrelated", {})])).toEqual([])
  })

  it("finds one node by id", () => {
    const events = [started("read"), settled("read", "success", "x")]

    expect(NodeOutput.find(events, "read#1")?.value).toBe("x")
    expect(NodeOutput.find(events, "read#2")).toBeUndefined()
  })
})

describe("the reader-facing messages", () => {
  it("lists the ids a run has when one is not found", () => {
    const nodes = NodeOutput.project([started("read"), settled("read", "success", "x")])

    expect(NodeOutput.notFound("run-1", "read#9", nodes)).toContain("has no node read#9")
    expect(NodeOutput.notFound("run-1", "read#9", nodes)).toContain("It has: read#1")
  })

  it("says a run recorded nothing rather than listing an empty set", () => {
    expect(NodeOutput.notFound("run-1", "read#1", [])).toBe("Run run-1 recorded no node output.")
  })

  it("renders the outcome line, the failure message, and the value", () => {
    const [failure] = NodeOutput.project([started("write"), settled("write", "failure", undefined, "denied")])
    const [success] = NodeOutput.project([started("read"), settled("read", "success", { rows: 2 })])

    expect(NodeOutput.render(failure!)).toBe("write#1 failure\ndenied")
    expect(NodeOutput.render(success!)).toBe("read#1 success\n{\n  \"rows\": 2\n}")
    expect(NodeOutput.render({ nodeId: "empty", flowName: "read", outcome: "success" })).toBe("empty success")
  })
})
