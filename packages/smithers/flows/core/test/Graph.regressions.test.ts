import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Digest from "../src/Digest.ts"
import * as Effects from "../src/Effects.ts"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"

const effect = (input: Partial<Effects.MakeOptions> = {}): Effects.Declaration =>
  Effects.make({
    reads: input.reads ?? [],
    writes: input.writes ?? [],
    mode: input.mode ?? "expected",
    onConflict: input.onConflict ?? "serialize",
    ...(input.tier === undefined ? {} : { tier: input.tier })
  })

const nodeMaterial = (graph: Graph.Graph, id: string) => Graph.nodes(graph).find((node) => node.id === id)?.keyMaterial

describe("Graph release regressions", () => {
  it("builds at maximumGraphDepth and rejects one level more", () => {
    const chain = (depth: number): Node.Node<number> => {
      const identity = (value: number) => value
      let current = Node.succeed(1)
      for (let index = 0; index < depth; index++) current = Node.map(current, identity)
      return current
    }

    expect(() => Graph.build(chain(Graph.maximumGraphDepth))).not.toThrow()
    expect(() => Graph.build(chain(Graph.maximumGraphDepth + 1))).toThrow(Graph.GraphBuildError)
    try {
      Graph.build(chain(Graph.maximumGraphDepth + 1))
    } catch (error) {
      expect(error).toMatchObject({ code: "graph_too_deep", path: [], node: expect.any(String) })
    }
  })

  it("reflects at maximumPayloadDepth and rejects one level more", () => {
    const nested = (depth: number): unknown => {
      let value: unknown = "leaf"
      for (let index = 0; index < depth; index++) value = { value }
      return value
    }

    expect(() => Graph.build(Node.succeed(nested(Graph.maximumPayloadDepth)))).not.toThrow()
    expect(() => Graph.build(Node.succeed(nested(Graph.maximumPayloadDepth + 1))))
      .toThrow(Graph.GraphBuildError)
    try {
      Graph.build(Node.succeed(nested(Graph.maximumPayloadDepth + 1)))
    } catch (error) {
      expect(error).toMatchObject({ code: "payload_too_deep", path: [], node: "root" })
    }
  })

  it("freezes every returned graph projection without changing its values", () => {
    const graph = Graph.build(Node.all({ child: Node.succeed({ value: 1 }) }))
    const root = Graph.nodes(graph)[0]!
    const originalDependencies = [...root.dependencies]
    const originalBody = root.keyMaterial.body
    const originalEdges = [...Graph.edges(graph)]

    expect(() => (root.dependencies as Array<string>).push("forged")).toThrow(TypeError)
    expect(() => {
      ;(root.keyMaterial as { kind: string }).kind = "irreversible"
    }).toThrow(TypeError)
    expect(() => {
      ;(root.keyMaterial.body as { keys: Array<string> }).keys.push("forged")
    }).toThrow(TypeError)
    expect(() =>
      (Graph.edges(graph) as Array<Graph.Edge>).push({
        from: "forged",
        to: "root",
        reason: "value"
      })
    ).toThrow(TypeError)

    expect(root.dependencies).toEqual(originalDependencies)
    expect(root.keyMaterial.body).toEqual(originalBody)
    expect(Graph.edges(graph)).toEqual(originalEdges)
  })

  it("keeps prototype-like All members in nodes, edges, and key material", () => {
    const graph = Graph.build(Node.all({
      ["__proto__"]: Node.succeed("proto"),
      constructor: Node.succeed("constructor"),
      prototype: Node.succeed("prototype")
    }))

    expect(Graph.nodes(graph).map((node) => node.id)).toEqual([
      "root",
      "root.all.__proto__",
      "root.all.constructor",
      "root.all.prototype"
    ])
    expect(Graph.edges(graph)).toEqual([
      { from: "root.all.__proto__", to: "root", reason: "value" },
      { from: "root.all.constructor", to: "root", reason: "value" },
      { from: "root.all.prototype", to: "root", reason: "value" }
    ])
    expect(nodeMaterial(graph, "root")?.body).toEqual({
      _tag: "All",
      keys: ["__proto__", "constructor", "prototype"]
    })
    expect(Result.getOrThrow(Graph.keyMaterial(graph)).map((entry) => entry.nodeId)).toEqual([
      "root.all.__proto__",
      "root.all.constructor",
      "root.all.prototype",
      "root"
    ])
  })

  it("diagnoses a repeated structural node id and refuses its key material", () => {
    const graph = Graph.build(Node.all({
      a: Node.all({ b: Node.succeed(1) }),
      "a.all.b": Node.succeed(2)
    }))

    expect(Graph.diagnostics(graph)).toMatchObject([{
      code: "duplicate_node",
      path: [],
      node: "root.all.a.all.b"
    }])
    expect(Graph.diagnostics(graph)).toHaveLength(1)
    expect(Graph.keyMaterial(graph)).toMatchObject({
      _tag: "Failure",
      failure: { code: "duplicate_node", node: "root.all.a.all.b" }
    })
  })

  it("allows dotted member names when their structural id is unambiguous", () => {
    const graph = Graph.build(Node.all({ "a.b": Node.succeed(1) }))

    expect(Graph.nodes(graph).map((node) => node.id)).toEqual(["root", "root.all.a.b"])
    expect(Graph.diagnostics(graph)).toEqual([])
    expect(Result.isSuccess(Graph.keyMaterial(graph))).toBe(true)
  })

  const fatalCodes = [
    "effect_outside_envelope",
    "effect_mode_widening",
    "effect_tier_widening",
    "write_conflict",
    "missing_key_material",
    "duplicate_node",
    "graph_too_deep",
    "plan_too_large",
    "payload_too_deep",
    "payload_too_large"
  ] as const

  it.each(fatalCodes)("blocks key material for fatal diagnostic %s", (code) => {
    const built = Graph.build(Node.succeed("ok"))
    const diagnostic = new Graph.GraphBuildError({ code, node: "root", path: ["path"], message: "" })
    const graph = { ...built, diagnostics: [diagnostic] } as Graph.Graph
    const result = Graph.keyMaterial(graph)

    expect(result).toMatchObject({ _tag: "Failure", failure: { code } })
    if (Result.isFailure(result)) expect(result.failure).toBe(diagnostic)
  })

  it("includes schema AST annotations in identity", () => {
    const brandedA = Schema.String.pipe(Schema.brand("A"))
    const brandedB = Schema.String.pipe(Schema.brand("B"))
    const first = Graph.build(Node.dynamic({ output: brandedA }))
    const second = Graph.build(Node.dynamic({ output: brandedB }))

    expect(nodeMaterial(first, "root")?.body).not.toEqual(nodeMaterial(second, "root")?.body)
    expect(nodeMaterial(first, "root")?.body).toMatchObject({
      output: {
        _tag: "Schema",
        ast: { tag: "String", annotations: { brands: ["A"] } }
      }
    })
  })

  it("distinguishes declared schemas with explicit identifiers", () => {
    const numeric = Schema.declare((value: unknown): value is number => typeof value === "number")
      .annotate({ identifier: "Numeric" })
    const textual = Schema.declare((value: unknown): value is string => typeof value === "string")
      .annotate({ identifier: "Textual" })

    expect(nodeMaterial(Graph.build(Node.dynamic({ output: numeric })), "root")?.body)
      .not.toEqual(nodeMaterial(Graph.build(Node.dynamic({ output: textual })), "root")?.body)
  })

  it("refuses an undecorated declared schema instead of collapsing it", () => {
    // A bare guard is a closure with no type parameters and an empty JSON
    // Schema, so every such declaration would key identically. Refusing is the
    // only projection that cannot hand two different schemas one step key.
    const numeric = Schema.declare((value: unknown): value is number => typeof value === "number")

    expect(() => Graph.build(Node.dynamic({ output: numeric }))).toThrow(Node.NodeBuildError)
    try {
      Graph.build(Node.dynamic({ output: numeric }))
    } catch (error) {
      expect(error).toMatchObject({
        code: "unrepresentable_value",
        member: "$.output",
        message:
          "Graph.build cannot derive identity for the declared schema at $.output because its guard is opaque; " +
          "annotate it, for example with an identifier, so distinct declarations key differently"
      })
    }
  })

  it("serializes two parallel writers of the same unnormalized path", () => {
    const writes = effect({ writes: ["repo/../secret"], mode: "expected", onConflict: "serialize" })
    const graph = Graph.build(Node.all({
      first: Node.withEffects(Node.dynamic({}), writes),
      second: Node.withEffects(Node.dynamic({}), writes)
    }))

    expect(Graph.conflicts(graph)).toEqual([{
      nodes: ["root.all.first", "root.all.second"],
      paths: ["repo/../secret"],
      strategy: "serialize"
    }])
    expect(Graph.edges(graph).some((edge) => edge.reason === "conflict")).toBe(true)
  })

  it("bounds type-parameter recursion with the payload depth limit", () => {
    let nested: Schema.Top = Schema.String
    for (let index = 0; index <= Graph.maximumPayloadDepth; index++) {
      const option = Schema.Option(nested)
      const ast = Object.create(
        Object.getPrototypeOf(option.ast),
        Object.getOwnPropertyDescriptors(option.ast)
      ) as typeof option.ast
      Object.defineProperty(ast, "annotations", { configurable: true, value: undefined, writable: true })
      nested = Schema.make(ast)
    }

    try {
      Graph.build(Node.dynamic({ output: nested }))
      throw new Error("expected the nested schema to exceed its depth limit")
    } catch (error) {
      expect(error).toBeInstanceOf(Graph.GraphBuildError)
      expect(error).toMatchObject({ code: "payload_too_deep", path: [], node: "root" })
    }
  })

  it("separates declared schemas by their type parameters", () => {
    const text = Schema.Option(Schema.String)
    const numeric = Schema.Option(Schema.Number)

    expect(nodeMaterial(Graph.build(Node.dynamic({ output: text })), "root")?.body)
      .not.toEqual(nodeMaterial(Graph.build(Node.dynamic({ output: numeric })), "root")?.body)
    expect(nodeMaterial(Graph.build(Node.dynamic({ output: text })), "root")?.body).toMatchObject({
      output: {
        _tag: "Schema",
        ast: { tag: "Declaration", typeParameters: [{ _tag: "Schema", ast: { tag: "String" } }] }
      }
    })
  })

  it("keys explicit effects on non-work nodes", () => {
    const irreversible = effect({
      writes: ["a"],
      mode: "expected",
      onConflict: "fail",
      tier: "irreversible"
    })
    const sealed = effect({
      writes: ["b"],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    })
    const first = nodeMaterial(Graph.build(Node.withEffects(Node.succeed(1), irreversible)), "root")
    const second = nodeMaterial(Graph.build(Node.withEffects(Node.succeed(1), sealed)), "root")

    expect(first).not.toEqual(second)
    expect(first).toMatchObject({ kind: "irreversible", effects: irreversible })
    expect(second).toMatchObject({ kind: "sealed", effects: sealed })
  })

  it("keeps a FlowCall wrapper sealed while its work child carries the flow tier", () => {
    const irreversible = effect({ tier: "irreversible" })
    const flow = Flow.make({ effects: irreversible, body: () => Node.dynamic({}) })
    const graph = Graph.build(flow(undefined))

    expect(nodeMaterial(graph, "root")?.kind).toBe("sealed")
    expect(nodeMaterial(graph, "root")?.effects).toBeUndefined()
    expect(nodeMaterial(graph, "root.flow")?.kind).toBe("irreversible")
    expect(nodeMaterial(graph, "root.flow")?.effects).toEqual(irreversible)
    expect(nodeMaterial(graph, "root.flow")?.effects).not.toBe(irreversible)
  })

  it("keeps an annotated All declaration as its children's narrowing envelope", () => {
    const envelope = effect({ writes: ["out/**"], mode: "hermetic", tier: "compensable" })
    const graph = Graph.build(Node.withEffects(
      Node.all({
        inside: Node.withEffects(Node.dynamic({}), effect({ writes: ["out/value"], mode: "hermetic" })),
        outside: Node.withEffects(Node.dynamic({}), effect({ writes: ["secret"], mode: "hermetic" }))
      }),
      envelope
    ))

    expect(nodeMaterial(graph, "root")?.effects).toEqual(envelope)
    expect(nodeMaterial(graph, "root")?.effects).not.toBe(envelope)
    expect(nodeMaterial(graph, "root")?.kind).toBe("compensable")
    expect(Graph.diagnostics(graph)).toMatchObject([{
      code: "effect_outside_envelope",
      path: ["secret"],
      node: "root.all.outside"
    }])
  })

  it("preserves a callee capability grant for a bare FlowCall root", () => {
    const flow = Flow.make({ capabilities: ["shell"], body: () => Node.dynamic({}) })
    const callGraph = Graph.build(flow(undefined))
    const flowGraph = Graph.build(flow, undefined)

    expect(nodeMaterial(callGraph, "root")?.capabilities).toEqual([])
    expect(nodeMaterial(callGraph, "root.flow")?.capabilities).toEqual(["shell"])
    expect(Graph.diagnostics(callGraph)).toEqual([])
    expect(nodeMaterial(flowGraph, "root")?.capabilities).toEqual(["shell"])
  })

  it("reports capability attenuation as advisory and still returns key material", () => {
    const child = Flow.make({ capabilities: ["shell"], body: () => Node.dynamic({}) })
    const parent = Flow.make({ capabilities: ["net"], body: () => child(undefined) })
    const graph = Graph.build(parent)

    expect(Graph.diagnostics(graph)).toMatchObject([{
      code: "capability_outside_grant",
      path: ["shell"],
      node: "root"
    }])
    expect(Graph.diagnostics(graph)).toHaveLength(1)
    expect(Result.isSuccess(Graph.keyMaterial(graph))).toBe(true)
  })

  it("canonicalizes All member order in declaration identity", () => {
    const first = Graph.build(Node.all({ a: Node.succeed(1), b: Node.succeed(2) }))
    const second = Graph.build(Node.all({ b: Node.succeed(2), a: Node.succeed(1) }))
    const unicodeFirst = Graph.build(Node.all({
      e: Node.succeed("plain"),
      ["é"]: Node.succeed("accented"),
      ["__proto__"]: Node.succeed("prototype")
    }))
    const unicodeSecond = Graph.build(Node.all({
      ["__proto__"]: Node.succeed("prototype"),
      ["é"]: Node.succeed("accented"),
      e: Node.succeed("plain")
    }))

    const assertIdentical = (left: Graph.Graph, right: Graph.Graph): void => {
      expect(Digest.canonical(Result.getOrThrow(Graph.keyMaterial(left))))
        .toBe(Digest.canonical(Result.getOrThrow(Graph.keyMaterial(right))))
      expect(Graph.nodes(left).map((node) => node.id)).toEqual(Graph.nodes(right).map((node) => node.id))
      expect(Graph.edges(left)).toEqual(Graph.edges(right))
    }

    expect(nodeMaterial(first, "root")?.body).toEqual(nodeMaterial(second, "root")?.body)
    assertIdentical(first, second)
    assertIdentical(unicodeFirst, unicodeSecond)
  })

  it("rejects a malformed root with an exact typed error", () => {
    const malformed = { [Node.TypeId]: true } as unknown as Node.Any

    expect(() => Graph.build(malformed)).toThrow(Graph.GraphBuildError)
    try {
      Graph.build(malformed)
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_node",
        path: [],
        node: "root",
        message: "Graph.build expected a supported Node AST at \"root\""
      })
    }
  })

  it("validates every nested AST", () => {
    const malformed = { [Node.TypeId]: true } as unknown as Node.Any
    const graph = Node.all({ malformed })

    try {
      Graph.build(graph)
      throw new Error("expected Graph.build to fail")
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_node",
        node: "root.all.malformed",
        message: "Graph.build expected a supported Node AST at \"root.all.malformed\""
      })
    }
  })

  it("preserves malformed-root causes without serializing them", () => {
    const cause = new Error("ast getter failed")
    const malformed = { [Node.TypeId]: true } as Record<PropertyKey, unknown>
    Object.defineProperty(malformed, "ast", {
      get: () => {
        throw cause
      }
    })

    try {
      Graph.build(malformed as unknown as Node.Any)
      throw new Error("expected Graph.build to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(Graph.GraphBuildError)
      expect((error as Error & { readonly cause?: unknown }).cause).toBe(cause)
      expect(Object.keys(error as object)).not.toContain("cause")
    }
  })
})
