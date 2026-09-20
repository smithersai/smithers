import { describe, expect, it } from "vitest"
import * as Effects from "../src/Effects.ts"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"
import * as Placement from "../src/Placement.ts"

const strip = (graph: Graph.Graph): unknown => ({
  nodes: Graph.nodes(graph).map(({ keyMaterial, ...node }) => ({ ...node, keyMaterial })),
  edges: Graph.edges(graph),
  conflicts: Graph.conflicts(graph),
  diagnostics: Graph.diagnostics(graph).map(({ code, node, path }) => ({ code, node, path }))
})

describe("Graph purity", () => {
  it("is safe to build twice and does not mutate source annotations", () => {
    let builds = 0
    const effects = Effects.make({ reads: ["src/**"], writes: ["out/**"], mode: "hermetic", onConflict: "serialize" })
    const body = () => {
      builds++
      return Node.andThen(
        Node.within(
          Node.withEffects(Node.all({ first: Node.dynamic({ prompt: "one" }), second: Node.succeed("two") }), effects),
          Placement.sandbox()
        ),
        Node.capture({}, () => Node.succeed("later"))
      )
    }
    const flow = Flow.within(Flow.make({ effects, body }), Placement.local())
    const before = flow.annotations
    const first = Graph.build(flow)
    const second = Graph.build(flow)

    expect(builds).toBe(2)
    expect(strip(first)).toEqual(strip(second))
    expect(flow.annotations).toBe(before)
    expect(flow.annotations).toEqual(before)
  })
})
