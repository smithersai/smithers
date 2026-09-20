import { Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Digest from "../src/Digest.ts"
import * as Effects from "../src/Effects.ts"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"
import * as Placement from "../src/Placement.ts"

const material = (graph: Graph.Graph): string => Digest.canonical(Result.getOrThrow(Graph.keyMaterial(graph)))

describe("Graph metadata snapshots", () => {
  it("traverses shallow-frozen declarations while freezing graph-owned snapshots", () => {
    const writes = ["a"]
    const declaration = Object.freeze({
      ...Effects.make({ reads: [], writes, mode: "hermetic", onConflict: "serialize" }),
      writes
    })
    const graph = Graph.build(Node.withEffects(Node.dynamic({}), declaration))
    const node = Graph.nodes(graph)[0]!
    const before = material(graph)

    expect(Object.isFrozen(node.effectiveEffects)).toBe(true)
    expect(Object.isFrozen(node.effectiveEffects?.writes)).toBe(true)
    writes.push("b")
    expect(material(graph)).toBe(before)
    expect(node.effectiveEffects?.writes).toEqual(["a"])
  })

  it("leaves caller annotations mutable and keeps every graph projection byte-stable", () => {
    const declaration = Effects.make({
      reads: ["input"],
      writes: ["a"],
      mode: "hermetic",
      onConflict: "serialize"
    })
    const placement = Placement.sandbox({ profile: "initial" })
    const graph = Graph.build(
      Node.dynamic({}).pipe(
        Node.withEffects(declaration),
        Node.within(placement)
      )
    )
    const before = {
      nodes: Digest.canonical(Graph.nodes(graph)),
      effects: Digest.canonical(Graph.effects(graph)),
      material: material(graph)
    }

    expect(Object.isFrozen(declaration)).toBe(false)
    expect(Object.isFrozen(declaration.writes)).toBe(false)
    expect(Object.isFrozen(placement)).toBe(false)
    ;(declaration.writes as Array<string>).push("b")
    ;(placement as { profile?: string }).profile = "changed"

    expect(Digest.canonical(Graph.nodes(graph))).toBe(before.nodes)
    expect(Digest.canonical(Graph.effects(graph))).toBe(before.effects)
    expect(material(graph)).toBe(before.material)
  })

  it("snapshots direct Dynamic, FlowCall, and reflected Flow effects without normalizing them", () => {
    const dynamicEffects: Effects.Declaration = {
      reads: ["z", "a", "z"],
      writes: [],
      mode: "expected",
      onConflict: "serialize"
    }
    const flowEffects: Effects.Declaration = {
      reads: ["b", "a", "b"],
      writes: [],
      mode: "expected",
      onConflict: "serialize"
    }
    const flow = Flow.make({ effects: flowEffects, body: () => Node.dynamic({}) })
    const graph = Graph.build(Node.all({
      call: flow(undefined),
      direct: Node.dynamic({ effects: dynamicEffects }),
      reflected: Node.succeed(flow)
    }))
    const before = material(graph)

    expect(Object.isFrozen(dynamicEffects)).toBe(false)
    expect(Object.isFrozen(flowEffects)).toBe(false)
    expect(Graph.nodes(graph).find((node) => node.id === "root.all.direct")?.effectiveEffects?.reads)
      .toEqual(["z", "a", "z"])
    expect(Graph.nodes(graph).find((node) => node.id === "root.all.call")?.declaredEffects?.reads)
      .toEqual(["b", "a", "b"])
    ;(dynamicEffects.reads as Array<string>).push("changed")
    ;(flowEffects.reads as Array<string>).push("changed")
    expect(material(graph)).toBe(before)
  })
})
