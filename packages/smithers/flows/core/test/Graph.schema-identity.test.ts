import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Digest from "../src/Digest.ts"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"

const material = (schema: Schema.Top): string =>
  Digest.canonical(Result.getOrThrow(Graph.keyMaterial(Graph.build(Node.dynamic({ output: schema })))))

const outputIdentity = (schema: Schema.Top): unknown => {
  const body = Graph.nodes(Graph.build(Node.dynamic({ output: schema })))[0]?.keyMaterial.body as {
    readonly output: unknown
  }
  return body.output
}

describe("Graph schema annotation identity", () => {
  it("propagates the payload-depth bound for every too-deep annotation", () => {
    const documentation = (leaf: string): unknown => {
      let value: unknown = leaf
      for (let index = 0; index < 200; index++) value = { nested: value }
      return value
    }

    for (const leaf of ["first", "second"]) {
      const schema = Schema.String.annotate({ documentation: documentation(leaf) as string })
      expect(() => Graph.build(Node.dynamic({ output: schema }))).toThrow(Graph.GraphBuildError)
      try {
        Graph.build(Node.dynamic({ output: schema }))
        throw new Error("expected schema annotations to exceed the payload depth")
      } catch (error) {
        expect(error).toMatchObject({ code: "payload_too_deep", node: "root" })
      }
    }
  })

  it("propagates unrepresentable annotation values", () => {
    const documentation = Object.create({ _tag: "Weird" }) as string
    const schema = Schema.String.annotate({ documentation })

    expect(() => Graph.build(Node.dynamic({ output: schema }))).toThrow(Node.NodeBuildError)
    try {
      Graph.build(Node.dynamic({ output: schema }))
      throw new Error("expected schema annotation to be refused")
    } catch (error) {
      expect(error).toMatchObject({
        code: "unrepresentable_value",
        member: "$.output.ast.annotations.documentation"
      })
    }
  })

  it("escapes a literal cyclic marker away from genuinely cyclic annotations", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const cyclic = Schema.String.annotate({ documentation: cycle as unknown as string })
    const literalValue = { _tag: "CyclicAnnotations" }
    const literal = Schema.String.annotate({ documentation: literalValue as unknown as string })

    expect(outputIdentity(cyclic)).toMatchObject({
      ast: { annotations: { _tag: "CyclicAnnotations" } }
    })
    expect(outputIdentity(literal)).toMatchObject({
      ast: {
        annotations: {
          documentation: { _tag: "Escaped", value: literalValue }
        }
      }
    })
    expect(material(literal)).not.toBe(material(cyclic))
  })
})
