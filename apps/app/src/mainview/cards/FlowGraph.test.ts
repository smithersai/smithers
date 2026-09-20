import { describe, expect, test } from "bun:test"
import { flowGraphModel, layoutFlowGraph, NODE_HEIGHT, NODE_WIDTH, type PlanCardNode } from "./FlowGraph"

const node = (id: string, dependsOn: Array<string> = [], over: Partial<PlanCardNode> = {}): PlanCardNode => ({
  id,
  kind: "step" as const,
  key: `key1_${"0".repeat(64)}`,
  dependsOn,
  tier: "sealed" as const,
  status: "run" as const,
  ...over
})

/* a → b, a → c, b → d, c → d */
const diamond = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])]

describe("the plan's nodes as a graph", () => {
  test("a diamond plan is four nodes and four edges", () => {
    const model = flowGraphModel(diamond)
    expect(model.nodes.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"])
    expect(model.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(["a->b", "a->c", "b->d", "c->d"])
    expect(model.edges.every((edge) => edge.reason === undefined)).toBe(true)
  })

  test("the workspace's labelled edges win over dependsOn when it reported them", () => {
    const model = flowGraphModel(diamond, {
      edges: [{ from: "a", to: "b", reason: "value" }, { from: "b", to: "d", reason: "failure" }]
    })
    expect(model.edges.map((edge) => [edge.from, edge.to, edge.reason])).toEqual([
      ["a", "b", "value"],
      ["b", "d", "failure"]
    ])
  })

  test("an edge naming a node the plan does not carry is dropped, never drawn", () => {
    expect(flowGraphModel([node("a"), node("b", ["ghost"])]).edges).toEqual([])
    expect(
      flowGraphModel([node("a")], { edges: [{ from: "a", to: "ghost", reason: "value" }] }).edges
    ).toEqual([])
  })

  test("a node keeps what it will do: its tier, its action and its state as a word", () => {
    const model = flowGraphModel([node("a", [], { kind: "agent", tier: "irreversible", action: "agent/run", status: "cached" })])
    expect(model.nodes[0]).toMatchObject({ id: "a", kind: "agent", tier: "irreversible", action: "agent/run", status: "cached" })
  })

  test("an empty plan is an empty graph", () => {
    expect(flowGraphModel([])).toEqual({ nodes: [], edges: [] })
    expect(layoutFlowGraph({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] })
  })
})

describe("the layout", () => {
  test("lays ranks out top to bottom, one row per dependency depth", () => {
    const laid = layoutFlowGraph(flowGraphModel(diamond))
    const rowOf = (id: string) => laid.nodes.find((entry) => entry.id === id)!.position.y
    expect(rowOf("a")).toBeLessThan(rowOf("b"))
    expect(rowOf("b")).toBe(rowOf("c"))
    expect(rowOf("c")).toBeLessThan(rowOf("d"))
    expect(laid.nodes.every((entry) => entry.width === NODE_WIDTH && entry.height === NODE_HEIGHT)).toBe(true)
  })

  test("is deterministic: the same plan lays out to the same pixels", () => {
    const first = layoutFlowGraph(flowGraphModel(diamond))
    const second = layoutFlowGraph(flowGraphModel(diamond))
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.nodes.every((entry) => Number.isInteger(entry.position.x) && Number.isInteger(entry.position.y))).toBe(true)
  })

  test("every laid-out edge names the two nodes it joins", () => {
    const laid = layoutFlowGraph(flowGraphModel(diamond))
    const ids = new Set(laid.nodes.map((entry) => entry.id))
    expect(laid.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true)
    expect(new Set(laid.edges.map((edge) => edge.id)).size).toBe(laid.edges.length)
  })
})
